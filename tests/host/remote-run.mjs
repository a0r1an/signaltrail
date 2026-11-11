// Load run against a host bootstrapped with infra/host: the generator (k6 in Docker
// on this machine) sends singleton events through the real ingestion endpoint; a
// sampler records host CPU (with steal), memory, disk and containers; every event's
// client outcome is reconciled against ClickHouse. Optional single dashboard viewer.
//
//   SIGNALTRAIL_HOST_TARGET=lima:<instance> node tests/host/remote-run.mjs <profile>
//   SIGNALTRAIL_CPU_BASELINE_PERCENT=20 (t4g.medium) marks the sustainable range.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createAnalyticsReader } from '../../packages/analytics/dist/index.js';
import { assessDashboard, dashboardWindow, summarizeDashboard } from '../load/dashboard-load.mjs';
import {
  assessStage,
  cpuBetween,
  findLimits,
  parseLedger,
  parseProcStat,
  reconcile,
  summarizeProbe,
} from './remote-assess.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MINUTE = 60;
const profiles = {
  smoke: { seedRows: 100000, viewer: true, stages: [{ rate: 1, seconds: 30 }] },
  'ramp-short': {
    seedRows: 100000,
    viewer: true,
    stages: [
      { rate: 1, seconds: MINUTE },
      { rate: 10, seconds: MINUTE },
    ],
  },
  idle: { seedRows: 9000000, viewer: false, stages: [{ rate: 0, seconds: 120 * MINUTE }] },
  '1eps': { seedRows: 9000000, viewer: true, stages: [{ rate: 1, seconds: 240 * MINUTE }] },
  ramp: {
    seedRows: 9000000,
    viewer: true,
    stages: [1, 5, 10, 25, 50, 100].map((rate) => ({ rate, seconds: 15 * MINUTE })),
  },
};
const profileName = process.argv[2];
const profile = profiles[profileName];
if (!profile) throw new Error(`Profile must be one of: ${Object.keys(profiles).join(', ')}`);
const baselinePercent = Number(process.env.SIGNALTRAIL_CPU_BASELINE_PERCENT ?? 20);

function run(command, args, { input, allowFailure = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 || allowFailure
        ? resolveRun({ code, stdout, stderr })
        : reject(
            new Error(
              `${command} ${args.slice(0, 4).join(' ')} exited ${code}: ${stderr.slice(-2000)}`,
            ),
          ),
    );
    child.stdin.end(input ?? '');
  });
}

/** Commands on the target and the addresses this machine uses to reach it. */
function transport(spec) {
  const [kind, name] = (spec ?? '').split(':');
  if (kind === 'lima' && name)
    return {
      exec: async (command) =>
        (await run('limactl', ['shell', '--workdir', '/', name, 'sudo', 'sh', '-c', command]))
          .stdout,
      repo: root,
      // Lima forwards the guest's loopback ports to this machine's loopback.
      local: (address) => `http://${address}`,
      generator: (address) => `http://${address.replace('127.0.0.1', 'host.docker.internal')}`,
    };
  throw new Error('SIGNALTRAIL_HOST_TARGET must be lima:<instance> (ssh transport: phase B)');
}

const target = transport(process.env.SIGNALTRAIL_HOST_TARGET);
const runTag = `remote-${randomBytes(4).toString('hex')}`;
const directory = resolve(
  root,
  'test-results/host',
  `${new Date().toISOString().replaceAll(':', '-')}-remote-${profileName}`,
);
await mkdir(directory, { recursive: true });
const result = { profile: profileName, runTag, baselinePercent, stages: [], passed: false };
const save = () => writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2));
const envFile = async (file) =>
  Object.fromEntries(
    (await target.exec(`cat /etc/signaltrail/${file}`))
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
let sampler;
try {
  const host = await envFile('host.env');
  const ingestion = host.SIGNALTRAIL_INGESTION_PUBLISH ?? '127.0.0.1:4100';
  const clickhouseUrl = target.local(host.SIGNALTRAIL_CLICKHOUSE_PUBLISH ?? '127.0.0.1:8123');
  const dashboard = await envFile('dashboard.env');
  const reader = {
    endpoint: clickhouseUrl,
    username: dashboard.SIGNALTRAIL_CLICKHOUSE_READER,
    password: dashboard.SIGNALTRAIL_CLICKHOUSE_READER_PASSWORD,
  };
  result.host = {
    kernel: (await target.exec('uname -srm')).trim(),
    cpus: Number((await target.exec('nproc')).trim()),
    memoryKiB: Number(
      (await target.exec("sed -n 's/^MemTotal: *\\([0-9]*\\) kB/\\1/p' /proc/meminfo")).trim(),
    ),
    release: host.SIGNALTRAIL_RELEASE,
  };
  result.preflight = (await target.exec(`sh ${target.repo}/infra/host/verify.sh`)).trim();

  // Long profiles record disk behaviour first (about a minute).
  if (!['smoke', 'ramp-short'].includes(profileName)) {
    const probe = await target.exec(`sh ${target.repo}/infra/host/probe.sh`);
    await writeFile(resolve(directory, 'probe.json'), probe);
    result.probe = summarizeProbe(JSON.parse(probe));
    await save();
  }
  const seedStarted = performance.now();
  const seeded = await target.exec(`ROWS=${profile.seedRows} sh ${target.repo}/tests/host/seed.sh`);
  const project = /PROJECT=(\S+)/.exec(seeded)?.[1];
  const key = /KEY=(\S+)/.exec(seeded)?.[1];
  assert.ok(project && key, 'Seed did not return a project and key');
  result.seed = { rows: profile.seedRows, seconds: (performance.now() - seedStarted) / 1000 };
  await save();

  const samplesFile = `/var/lib/signaltrail/samples-${runTag}.jsonl`;
  sampler = (
    await target.exec(
      `nohup sh ${target.repo}/infra/host/sample.sh > ${samplesFile} 2>&1 & echo $!`,
    )
  ).trim();

  const storedIds = async (prefix) => {
    const url = new URL(clickhouseUrl);
    url.searchParams.set(
      'query',
      'SELECT event_id FROM signaltrail.analytics_events FINAL WHERE project_id = {project:String} AND startsWith(event_id, {prefix:String}) FORMAT TSVRaw',
    );
    url.searchParams.set('param_project', project);
    url.searchParams.set('param_prefix', prefix + '-');
    const response = await fetch(url, {
      headers: { 'X-ClickHouse-User': reader.username, 'X-ClickHouse-Key': reader.password },
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body.slice(0, 300));
    return body.split('\n').filter(Boolean);
  };

  for (const [index, stage] of profile.stages.entries()) {
    const prefix = `${runTag}-s${index}`;
    const record = {
      rate: stage.rate,
      seconds: stage.seconds,
      startedAt: new Date().toISOString(),
    };
    result.stages.push(record);
    const cpuStart = parseProcStat(await target.exec('head -1 /proc/stat'));
    let done = false;
    const pages = [];
    const viewer = profile.viewer
      ? (async () => {
          for (let attempt = 0; !done; attempt++) {
            const window = { projectId: project, ...dashboardWindow(attempt) };
            const started = performance.now();
            const query = async (call) => {
              const queryStarted = performance.now();
              try {
                await call(createAnalyticsReader(reader));
                return { ok: true, ms: performance.now() - queryStarted };
              } catch (error) {
                return { ok: false, ms: performance.now() - queryStarted, error: error.message };
              }
            };
            const [list, count, visitors] = await Promise.all([
              query((r) => r.listOccurredEvents({ ...window, limit: 50 })),
              query((r) => r.countOccurredEvents(window)),
              query((r) => r.countOccurredVisitors(window)),
            ]);
            pages.push({
              days: window.days,
              ms: performance.now() - started,
              queries: { list, count, visitors },
            });
            await delay(5000);
          }
        })()
      : Promise.resolve();

    let k6 = { accepted: 0, retry: 0, rejected: 0, dropped: 0, p95: 0, p99: 0 };
    let ledger = { entries: {}, malformed: 0 };
    if (stage.rate > 0) {
      const traffic = await run(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${resolve(root, 'tests/host')}:/scripts:ro`,
          '-v',
          `${directory}:/out`,
          'grafana/k6:1.6.0',
          'run',
          '--quiet',
          '--log-format=raw',
          `--log-output=file=/out/ledger-${index}.jsonl`,
          '-e',
          `RATE=${stage.rate}`,
          '-e',
          `DURATION=${stage.seconds}s`,
          '-e',
          `PREFIX=${prefix}`,
          '-e',
          `KEY=${key}`,
          '-e',
          `TARGET=${target.generator(ingestion)}/v1/events`,
          '/scripts/k6-ledger.js',
        ],
        { allowFailure: true },
      );
      const metrics = JSON.parse(traffic.stdout).metrics;
      const count = (name) => metrics[name]?.values.count ?? 0;
      k6 = {
        accepted: count('events_accepted'),
        retry: count('events_retry'),
        rejected: count('events_rejected'),
        transportErrors: count('transport_errors'),
        dropped: count('dropped_iterations'),
        p95: metrics.http_req_duration.values['p(95)'],
        p99: metrics.http_req_duration.values['p(99)'],
        max: metrics.http_req_duration.values.max,
      };
      ledger = parseLedger(await readFile(resolve(directory, `ledger-${index}.jsonl`), 'utf8'));
    } else await delay(stage.seconds * 1000);
    done = true;
    await viewer;
    const cpuEnd = parseProcStat(await target.exec('head -1 /proc/stat'));

    // Drain: every accepted event must become queryable.
    const drainStarted = performance.now();
    let totals;
    do {
      totals = reconcile(ledger.entries, await storedIds(prefix));
      if (!totals.acceptedMissing) break;
      await delay(1000);
    } while (performance.now() - drainStarted < 60000);
    Object.assign(record, {
      k6,
      ledgerMalformed: ledger.malformed,
      reconcile: totals,
      drainSeconds: (performance.now() - drainStarted) / 1000,
      drained: totals.acceptedMissing === 0,
      cpu: cpuBetween(cpuStart, cpuEnd),
    });
    const assessment =
      stage.rate > 0
        ? assessStage(record, { baselinePercent })
        : { passed: true, withinBaseline: record.cpu.busyPercent <= baselinePercent, reasons: [] };
    if (profile.viewer) {
      record.dashboard = summarizeDashboard(pages);
      assessment.reasons.push(...assessDashboard(record.dashboard));
      assessment.passed = assessment.reasons.length === 0;
    }
    Object.assign(record, assessment);
    await save();
    console.log(
      `stage ${index}: ${stage.rate} EPS ${record.passed ? 'pass' : 'FAIL'} cpu ${record.cpu.busyPercent.toFixed(1)}% steal ${record.cpu.stealPercent.toFixed(1)}%`,
      record.reasons.join('; '),
    );
    if (!record.passed) break;
  }
  result.limits = findLimits(result.stages.filter((stage) => stage.rate > 0));
  result.passed = result.stages.every((stage) => stage.passed);
} catch (error) {
  result.error = error.message;
} finally {
  if (sampler) {
    await target.exec(`kill ${sampler}`).catch(() => {});
    const samples = await target
      .exec(
        `cat /var/lib/signaltrail/samples-${runTag}.jsonl; rm -f /var/lib/signaltrail/samples-${runTag}.jsonl`,
      )
      .catch(() => '');
    await writeFile(resolve(directory, 'samples.jsonl'), samples);
  }
  await save();
}
console.log(
  JSON.stringify(
    { passed: result.passed, limits: result.limits, error: result.error, directory },
    null,
    2,
  ),
);
if (!result.passed) process.exit(1);
