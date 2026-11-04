import { spawn, execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIngestionServer, createRedpandaPublisher } from '../../apps/ingestion/dist/index.js';
import { exerciseBrokerRecovery } from './broker-recovery.mjs';
import { teardownIsolatedRun } from './teardown.mjs';
import { finishRun } from './run-result.mjs';
import { acquireRunLock } from './run-lock.mjs';
import { cleanupResources } from './cleanup.mjs';
import { createIngestionMetrics } from '../../apps/ingestion/src/metrics.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scenario = process.argv[2] ?? 'baseline';
const scenarios = {
  'storage-readiness': { rate: 0, batch: 1, padding: 0, maxEvents: 1000, maxBytes: 8388608 },
  'project-access': { rate: 0, batch: 1, padding: 0, maxEvents: 1000, maxBytes: 8388608 },
  'analytics-read': { rate: 0, batch: 1, padding: 0, maxEvents: 1000, maxBytes: 8388608 },
  'request-admission': {
    rate: 0,
    batch: 1,
    padding: 0,
    maxEvents: 1000,
    maxBytes: 8388608,
    maxConcurrentRequests: 1,
  },
  'sustained-bytes': {
    rate: 10,
    batch: 20,
    padding: 8000,
    maxEvents: 1000,
    maxBytes: 8388608,
    duration: '60s',
  },
  'sustained-outage': {
    rate: 10,
    batch: 20,
    padding: 0,
    maxEvents: 1000,
    maxBytes: 8388608,
    duration: '60s',
    storageInterruption: true,
  },
  'sustained-smoke': {
    rate: 10,
    batch: 20,
    padding: 0,
    maxEvents: 1000,
    maxBytes: 8388608,
    duration: '5s',
  },
  sustained: {
    rate: 10,
    batch: 20,
    padding: 0,
    maxEvents: 1000,
    maxBytes: 8388608,
    duration: '60s',
  },
  'sustained-stress': {
    rate: 50,
    batch: 20,
    padding: 0,
    maxEvents: 1000,
    maxBytes: 8388608,
    duration: '60s',
  },
  'browser-pipeline': { rate: 0, batch: 3, padding: 0, maxEvents: 1000, maxBytes: 8388608 },
  pipeline: { rate: 0, batch: 3, padding: 0, maxEvents: 1000, maxBytes: 8388608 },
  recovery: { rate: 0, batch: 3, padding: 0, maxEvents: 2, maxBytes: 8388608 },
  baseline: { rate: 10, batch: 20, padding: 0, maxEvents: 1000, maxBytes: 8388608 },
  burst: { rate: 200, batch: 20, padding: 0, maxEvents: 1000, maxBytes: 8388608 },
  saturation: { rate: 100, batch: 20, padding: 0, maxEvents: 10, maxBytes: 8388608 },
  bytes: { rate: 30, batch: 20, padding: 8000, maxEvents: 1000, maxBytes: 262144 },
};
const config = {
  maxConcurrentRequests: 128,
  ...scenarios[scenario],
  ...(scenario.startsWith('sustained') ? { sessionCount: 100 } : {}),
};
if (!Object.hasOwn(scenarios, scenario)) throw new Error(`Unknown scenario: ${scenario}`);
const isPipeline = ['pipeline', 'browser-pipeline'].includes(scenario);
const isSustained = [
  'sustained-smoke',
  'sustained',
  'sustained-stress',
  'sustained-outage',
  'sustained-bytes',
].includes(scenario);
const usesStorage =
  isPipeline || isSustained || ['analytics-read', 'storage-readiness'].includes(scenario);
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${scenario}`;
const directory = resolve(root, 'test-results/load', runId);
await mkdir(directory, { recursive: true });
const releaseRunLock = await acquireRunLock(resolve(root, 'test-results/load.lock'));
const compose = ['compose', '--profile', '*', '-f', 'tests/load/compose.yaml'];
const dockerEnv = {
  ...process.env,
  SIGNALTRAIL_REDPANDA_EXTERNAL_PORT: '29092',
  SIGNALTRAIL_STORAGE_INIT_GATE: scenario === 'storage-readiness' ? '1' : '0',
};
function docker(args, capture = false, allowFailure = false, signal) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('docker', [...compose, ...args], {
      cwd: root,
      env: dockerEnv,
      signal,
      stdio: capture ? ['ignore', 'pipe', capture === 'combined' ? 'pipe' : 'inherit'] : 'inherit',
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk) => {
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
let publisher, server, metrics, interval, sustained;
const samples = [];
let sampling = Promise.resolve();
let shutdown = false;
let runError;
let result = { scenario, config, passed: false, failedStages: [] };
const stop = () => {
  shutdown = true;
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  result = {
    ...result,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeDirty:
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
        .length > 0,
    machine: { cpuCount: cpus().length, cpuModel: cpus()[0]?.model, totalMemoryBytes: totalmem() },
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    limitations: [
      'Same-host generator and broker; development baseline, not production sizing.',
      scenario === 'request-admission'
        ? 'Node SDK retry and one slow body; not browser execution or connection flooding.'
        : scenario === 'recovery'
          ? 'Recovery uses the Node SDK memory fallback; browser persistence is tested separately.'
          : isSustained
            ? 'Sustained local pipeline measurement; not production sizing or SDK retry simulation.'
            : isPipeline
              ? 'Pipeline is a small correctness probe with FINAL reads, not a production query API.'
              : 'Capacity probes do not simulate SDK retries.',
    ],
  };
  // An interrupted process must not leave a successful-looking result.
  await writeFile(
    resolve(directory, 'result.json'),
    JSON.stringify({ ...result, incomplete: true }, null, 2),
  );
  if (scenario === 'browser-pipeline')
    execFileSync(
      'pnpm',
      [
        '--filter',
        '@signaltrail/browser-sdk',
        'exec',
        'tsup',
        '--config',
        'tests/browser/harness/bundle.config.ts',
      ],
      { cwd: root, stdio: 'inherit' },
    );
  await docker([
    'up',
    '-d',
    ...(scenario === 'storage-readiness' ? [] : ['--wait', '--wait-timeout', '120']),
    'redpanda',
    ...(usesStorage ? ['clickhouse'] : []),
    ...(scenario === 'project-access' ? ['postgres'] : []),
  ]);
  if (scenario === 'storage-readiness') {
    const { exerciseStorageReadiness } = await import('./storage-readiness.mjs');
    await writeFile(
      resolve(directory, 'storage-readiness.json'),
      JSON.stringify(await exerciseStorageReadiness({ docker }), null, 2),
    );
  }
  if (scenario === 'project-access') {
    const { exerciseProjectAccess } = await import('./project-access.mjs');
    await writeFile(
      resolve(directory, 'project-access.json'),
      JSON.stringify(await exerciseProjectAccess({ docker }), null, 2),
    );
  }
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
    maxConcurrentRequests: config.maxConcurrentRequests,
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
    maxConcurrentRequests: config.maxConcurrentRequests,
    resolveProjectKey: (key) =>
      key === 'load-test-key'
        ? 'load-project'
        : isPipeline && key === 'pipeline-other-key'
          ? 'load-other-project'
          : undefined,
    publish: publisher.publish,
    ...(['recovery', 'browser-pipeline'].includes(scenario) ? { publicationTimeoutMs: 250 } : {}),
    ...(scenario === 'browser-pipeline' ? { allowedOrigins: ['http://127.0.0.1:4179'] } : {}),
    observeRequest: metrics.observeRequest,
    observeAdmission: metrics.observeAdmission,
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
    // Observe rejection immediately; cleanup later reports it without crashing mid-run.
    void sampling.catch(() => {});
  }, 1000);
  if (isSustained) {
    const { openSustainedPipeline } = await import('./sustained-pipeline.mjs');
    sustained = await openSustainedPipeline({
      runId,
      directory,
      docker,
      interrupted: () => shutdown,
      storageInterruption: config.storageInterruption ?? false,
      expectedPaddingBytes: config.padding,
    });
  }
  if (scenario === 'analytics-read') {
    const { exerciseAnalyticsReads } = await import('./analytics-read.mjs');
    await writeFile(
      resolve(directory, 'analytics-read.json'),
      JSON.stringify(await exerciseAnalyticsReads({ directory }), null, 2),
    );
  }
  if (scenario === 'request-admission') {
    const { exerciseRequestAdmission } = await import('./request-admission.mjs');
    const evidence = await exerciseRequestAdmission({
      url: `http://127.0.0.1:${port}/v1/events`,
      publisher,
      runId,
    });
    await writeFile(
      resolve(directory, 'request-admission.json'),
      JSON.stringify(evidence, null, 2),
    );
  }
  if (scenario === 'recovery') {
    const evidence = await exerciseBrokerRecovery({
      url: `http://127.0.0.1:${port}/v1/events`,
      publisher,
      docker,
      runId,
    });
    await writeFile(resolve(directory, 'recovery.json'), JSON.stringify(evidence, null, 2));
  }
  if (isPipeline) {
    const { exerciseEventPipeline } = await import('./event-pipeline.mjs');
    const evidence = await exerciseEventPipeline({
      url: `http://127.0.0.1:${port}/v1/events`,
      runId,
      docker,
      browser: scenario === 'browser-pipeline',
      directory,
    });
    await writeFile(resolve(directory, 'pipeline.json'), JSON.stringify(evidence, null, 2));
  }
  const stages =
    config.rate === 0
      ? []
      : scenario === 'burst'
        ? [
            ['warmup', 10, '5s'],
            ['burst', config.rate, process.env.DURATION ?? '10s'],
            ['recovery', 10, '10s'],
          ]
        : [[scenario, config.rate, config.duration ?? process.env.DURATION ?? '15s']];
  const failedStages = result.failedStages;
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
        ...(isSustained
          ? [
              '-e',
              'PREALLOCATED_VUS=20',
              '-e',
              'MAX_VUS=100',
              '-e',
              'STRICT_ACCEPTANCE=true',
              '-e',
              `SESSION_COUNT=${config.sessionCount}`,
            ]
          : []),
        'k6',
        'run',
        '--quiet',
        '/scripts/ingestion.js',
      ],
      true,
      true,
    );
    await writeFile(resolve(directory, `${isSustained ? 'k6-' : ''}${name}.json`), output);
    const summary = JSON.parse(output);
    if (
      Object.values(summary.metrics).some(
        (metric) =>
          metric.thresholds && Object.values(metric.thresholds).some((threshold) => !threshold.ok),
      )
    )
      failedStages.push(name);
    if (sustained) {
      const evidence = await sustained.finish(summary);
      result.sustained = { totals: evidence.totals, drainSeconds: evidence.drainSeconds };
    }
  }
  const drainDeadline = Date.now() + 15000;
  while (publisher.snapshot().outstandingEvents && Date.now() < drainDeadline)
    await new Promise((done) => setTimeout(done, 100));
  const final = publisher.snapshot();
  const passed =
    failedStages.length === 0 &&
    !shutdown &&
    final.outstandingEvents === 0 &&
    final.peakEvents <= config.maxEvents &&
    final.peakBytes <= config.maxBytes &&
    (['saturation', 'bytes'].includes(scenario) ? final.refused > 0 : true);
  result = { ...result, final, passed };
  if (!passed) throw new Error('Load invariants failed');
} catch (error) {
  runError = error;
  try {
    await cleanupResources([
      {
        name: 'save broker diagnostics',
        run: async (signal) => {
          const logs = await docker(
            ['logs', '--no-color', '--tail', '100', 'redpanda'],
            'combined',
            false,
            signal,
          );
          await writeFile(resolve(directory, 'broker.log'), logs, { signal });
        },
      },
      ...(usesStorage
        ? [
            {
              name: 'save storage diagnostics',
              run: async (signal) => {
                const logs = await docker(
                  ['logs', '--no-color', '--tail', '200', 'clickhouse'],
                  'combined',
                  false,
                  signal,
                );
                await writeFile(resolve(directory, 'clickhouse.log'), logs, { signal });
              },
            },
          ]
        : []),
      ...(scenario === 'project-access'
        ? [
            {
              name: 'save metadata diagnostics',
              run: async (signal) => {
                const logs = await docker(
                  ['logs', '--no-color', '--tail', '100', 'postgres'],
                  'combined',
                  false,
                  signal,
                );
                await writeFile(resolve(directory, 'postgres.log'), logs, { signal });
              },
            },
          ]
        : []),
    ]);
  } catch (diagnosticError) {
    console.error('Could not save load diagnostics:', diagnosticError);
  }
} finally {
  clearInterval(interval);
  result = { ...result, final: publisher?.snapshot() };
  try {
    await finishRun({
      result,
      runError,
      writeResult: (completed) =>
        writeFile(resolve(directory, 'result.json'), JSON.stringify(completed, null, 2)),
      cleanup: () =>
        cleanupResources([
          { name: 'close sustained pipeline', timeoutMs: 90000, run: () => sustained?.close() },
          { name: 'finish metric sampling', run: () => sampling },
          {
            name: 'save samples',
            run: (signal) =>
              writeFile(resolve(directory, 'samples.json'), JSON.stringify(samples), { signal }),
          },
          {
            name: 'close ingestion listener',
            run: (signal) =>
              new Promise((done, reject) => {
                if (!server) return done();
                const forceClose = () => server.closeAllConnections();
                signal.addEventListener('abort', forceClose, { once: true });
                server.close((error) => {
                  signal.removeEventListener('abort', forceClose);
                  if (error) reject(error);
                  else done();
                });
              }),
          },
          { name: 'disconnect publisher', run: () => publisher?.close() },
          {
            name: 'withdraw load scrape targets',
            run: (signal) =>
              writeFile(resolve(root, 'test-results/load-targets.json'), '[]', { signal }),
          },
          { name: 'close metrics', run: () => metrics?.close() },
          {
            name: 'remove isolated infrastructure',
            timeoutMs: 30000,
            run: async (signal) => {
              await teardownIsolatedRun({
                remove: () => docker(['down', '--volumes'], false, false, signal),
                remaining: async () =>
                  (await docker(['ps', '--all', '--quiet'], true, false, signal))
                    .trim()
                    .split('\n')
                    .filter(Boolean),
                release: releaseRunLock,
              });
            },
          },
        ]),
    });
    console.log(JSON.stringify({ directory, passed: true, final: result.final }, null, 2));
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
