import { spawn, execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIngestionServer, createRedpandaPublisher } from '../../apps/ingestion/dist/index.js';
import { createIngestionMetrics } from '../../apps/ingestion/src/metrics.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scenario = process.argv[2] ?? 'baseline';
const scenarios = {
  baseline: { rate: 10, batch: 20, padding: 0, maxEvents: 1000, maxBytes: 8388608 },
  burst: { rate: 200, batch: 20, padding: 0, maxEvents: 1000, maxBytes: 8388608 },
  saturation: { rate: 100, batch: 20, padding: 0, maxEvents: 10, maxBytes: 8388608 },
  bytes: { rate: 30, batch: 20, padding: 8000, maxEvents: 1000, maxBytes: 262144 },
};
const config = scenarios[scenario];
if (!Object.hasOwn(scenarios, scenario)) throw new Error(`Unknown scenario: ${scenario}`);
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${scenario}`;
const directory = resolve(root, 'test-results/load', runId);
await mkdir(directory, { recursive: true });
const compose = ['compose', '-f', 'tests/load/compose.yaml'];
const dockerEnv = { ...process.env, SIGNALTRAIL_REDPANDA_EXTERNAL_PORT: '29092' };
function docker(args, capture = false, allowFailure = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('docker', [...compose, ...args], {
      cwd: root,
      env: dockerEnv,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 || allowFailure
        ? resolveRun(output)
        : reject(new Error(`Docker exited ${code}: ${args.join(' ')}`)),
    );
  });
}
let publisher, server, metrics, interval;
const samples = [];
let sampling = Promise.resolve();
let shutdown = false;
const stop = () => {
  shutdown = true;
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await docker(['up', '-d', '--wait', '--wait-timeout', '120', 'redpanda']);
  await docker(['run', '--rm', 'init']);
  await writeFile(
    resolve(directory, 'broker-process.txt'),
    await docker(['top', 'redpanda'], true),
  );
  publisher = createRedpandaPublisher({
    brokers: ['127.0.0.1:29092'],
    onPublicationSettled: (seconds, failed) => metrics?.observePublication(seconds, failed),
    topic: 'signaltrail.analytics.v1',
    maxOutstandingEvents: config.maxEvents,
    maxOutstandingBytes: config.maxBytes,
  });
  await publisher.connect();
  metrics = createIngestionMetrics(publisher.snapshot, {
    maxEvents: config.maxEvents,
    maxBytes: config.maxBytes,
  });
  await new Promise((done, reject) => {
    metrics.server.once('error', reject);
    metrics.server.listen(9465, '127.0.0.1', done);
  });
  const targetFile = resolve(root, 'test-results/load-targets.json');
  await writeFile(
    targetFile + '.tmp',
    JSON.stringify([
      {
        targets: ['host.docker.internal:9465'],
        labels: { job: 'signaltrail-load', environment: 'development', scenario },
      },
      {
        targets: ['host.docker.internal:29644'],
        labels: {
          job: 'signaltrail-redpanda-load',
          environment: 'development',
          scenario,
          __metrics_path__: '/public_metrics',
        },
      },
    ]),
  );
  await rename(targetFile + '.tmp', targetFile);
  server = createIngestionServer({
    resolveProjectKey: (key) => (key === 'load-test-key' ? 'load-project' : undefined),
    publish: publisher.publish,
    observeRequest: metrics.observeRequest,
  });
  // Temporary load-only listener: Docker's k6 reaches the host through its gateway.
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', done);
  });
  const port = server.address().port;
  interval = setInterval(() => {
    samples.push({
      at: new Date().toISOString(),
      ...publisher.snapshot(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
    });
    sampling = sampling.then(async () =>
      writeFile(resolve(directory, 'metrics.prom'), await metrics.registry.metrics()),
    );
  }, 1000);
  const stages =
    scenario === 'burst'
      ? [
          ['warmup', 10, '5s'],
          ['burst', config.rate, process.env.DURATION ?? '10s'],
          ['recovery', 10, '10s'],
        ]
      : [[scenario, config.rate, process.env.DURATION ?? '15s']];
  const failedStages = [];
  for (const [name, rate, duration] of stages) {
    if (shutdown) throw new Error('Load test interrupted');
    const output = await docker(
      [
        'run',
        '--rm',
        '-e',
        `TARGET=http://host.docker.internal:${port}/v1/events`,
        '-e',
        `RUN_ID=${runId}-${name}`,
        '-e',
        `RATE=${rate}`,
        '-e',
        `DURATION=${duration}`,
        '-e',
        `BATCH_SIZE=${config.batch}`,
        '-e',
        `PADDING_BYTES=${config.padding}`,
        'k6',
        'run',
        '--quiet',
        '/scripts/ingestion.js',
      ],
      true,
      true,
    );
    await writeFile(resolve(directory, `${name}.json`), output);
    const summary = JSON.parse(output);
    if (
      Object.values(summary.metrics).some(
        (metric) =>
          metric.thresholds && Object.values(metric.thresholds).some((threshold) => !threshold.ok),
      )
    )
      failedStages.push(name);
  }
  const drainDeadline = Date.now() + 15000;
  while (publisher.snapshot().outstandingEvents && Date.now() < drainDeadline)
    await new Promise((done) => setTimeout(done, 100));
  const final = publisher.snapshot();
  const passed =
    failedStages.length === 0 &&
    final.outstandingEvents === 0 &&
    final.peakEvents <= config.maxEvents &&
    final.peakBytes <= config.maxBytes &&
    (['saturation', 'bytes'].includes(scenario) ? final.refused > 0 : true);
  await writeFile(
    resolve(directory, 'result.json'),
    JSON.stringify(
      {
        scenario,
        failedStages,
        config,
        final,
        passed,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        workingTreeDirty:
          execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
            .length > 0,
        machine: {
          cpuCount: cpus().length,
          cpuModel: cpus()[0]?.model,
          totalMemoryBytes: totalmem(),
        },
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        limitations: [
          'Same-host generator and broker; development baseline, not production sizing.',
          'Capacity probes do not simulate SDK retries.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ directory, passed, final }, null, 2));
  if (!passed) throw new Error('Load invariants failed');
} catch (error) {
  const logs = await docker(['logs', '--no-color', '--tail', '100', 'redpanda'], true).catch(
    () => '',
  );
  await writeFile(resolve(directory, 'broker.log'), logs);
  throw error;
} finally {
  clearInterval(interval);
  await sampling;
  await writeFile(resolve(directory, 'samples.json'), JSON.stringify(samples));
  if (server) await new Promise((done) => server.close(done));
  await publisher?.close();
  await writeFile(resolve(root, 'test-results/load-targets.json'), '[]');
  metrics?.close();
  await docker(['down', '--volumes']);
}
