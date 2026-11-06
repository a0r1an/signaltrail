import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { memoryPlans, verifyMemoryLimits } from './memory-budget.mjs';
import { acquireRunLock } from './run-lock.mjs';
import { finishRun } from './run-result.mjs';
import { cleanupResources } from './cleanup.mjs';
import { teardownIsolatedRun } from './teardown.mjs';

const profile = process.argv[2] ?? 'memory-4gb';
assert.ok(Object.hasOwn(memoryPlans, profile), 'Unknown memory profile');
const memoryPlan = memoryPlans[profile];
const serviceMiB = Object.values(memoryPlan.services).reduce((sum, n) => sum + n, 0);
const totalGiB = (serviceMiB + memoryPlan.hostReserveMiB) / 1024;
const directory = `test-results/load/${new Date().toISOString().replaceAll(':', '-')}-${profile}`;
await mkdir(directory, { recursive: true });
const release = await acquireRunLock('test-results/load.lock');
let cancelled = false;
const cancel = () => {
  cancelled = true;
};
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
function docker(args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '',
      error = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (error += data));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output)
        : reject(new Error(`docker ${args.slice(0, 4).join(' ')} failed: ${error.slice(-4000)}`));
    });
  });
}
const compose = (...args) =>
  docker([
    'compose',
    '--profile',
    '*',
    '-f',
    'tests/load/compose.memory.yaml',
    ...(profile === 'memory-2gb' ? ['-f', 'tests/load/compose.memory-2gb.yaml'] : []),
    ...args,
  ]);
const services = Object.keys(memoryPlan.services);
const save = (name, value) =>
  writeFile(
    `${directory}/${name}`,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
const samples = [];
const stages = [];
const queries = [];
async function inspect() {
  const ids = (await compose('ps', '-q', ...services)).trim().split(/\s+/).filter(Boolean);
  assert.equal(ids.length, services.length);
  const values = JSON.parse(await docker(['inspect', ...ids]));
  verifyMemoryLimits(values, memoryPlan);
  // Do not persist expanded container environments or mounts.
  return values.map((v) => ({
    service: v.Config.Labels['com.docker.compose.service'],
    memoryLimit: v.HostConfig.Memory,
    swapLimit: v.HostConfig.MemorySwap,
    oomKilled: v.State.OOMKilled,
    restarts: v.RestartCount,
  }));
}
async function query(sql) {
  const start = performance.now();
  const r = await fetch('http://127.0.0.1:38124/?wait_end_of_query=1', {
    method: 'POST',
    headers: { 'X-ClickHouse-User': 'signaltrail', 'X-ClickHouse-Key': 'signaltrail_local' },
    body: sql,
    signal: AbortSignal.timeout(15000),
  });
  const value = await r.text();
  assert.equal(r.status, 200, value);
  assert.ok([null, '0'].includes(r.headers.get('X-ClickHouse-Exception-Code')));
  queries.push({ at: new Date().toISOString(), ms: performance.now() - start });
  return value;
}
let result = {
  passed: false,
  profile,
  memoryPlan,
  stages,
  directory,
  limitations: [
    `Per-service hard memory caps sum to ${serviceMiB} MiB; ${memoryPlan.hostReserveMiB} MiB is reserved, not allocated to a real guest OS.`,
    `Not a ${totalGiB} GiB VM: separate cgroups, shared host CPU/disk, Docker kernel and host caches differ.`,
    '100000 historical fixture rows; short runs do not qualify retention-scale, backups, replay or production endurance.',
    'PostgreSQL stored-key lookup is real; synthetic fixture role/schema is not production authorization provisioning.',
    'Valkey runs idle; dashboard query load is direct SQL, not the Clerk/Next.js UI.',
  ],
};
let runError,
  ownsInfrastructure = false;
try {
  assert.equal(
    (await compose('ps', '-aq')).trim(),
    '',
    'Existing memory-test containers require inspection; refusing reuse',
  );
  await compose('config', '--quiet');
  ownsInfrastructure = true;
  console.log(`Starting isolated services under the ${totalGiB} GiB memory plan`);
  await compose(
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '150',
    'postgres',
    'redpanda',
    'clickhouse',
    'valkey',
  );
  await compose('run', '--rm', '--no-deps', 'init');
  await compose(
    'run',
    '--rm',
    '--no-deps',
    '-e',
    'SIGNALTRAIL_REDPANDA_TOPIC=signaltrail.analytics.dlq.v1',
    'init',
  );
  await compose('up', '-d', '--wait', '--wait-timeout', '150', 'app');
  result.enforcedLimits = await inspect();
  assert.equal(
    Number(
      await query(
        "SELECT count() FROM signaltrail.analytics_events FINAL WHERE event_name='history_seed'",
      ),
    ),
    100000,
  );
  for (const users of [10, 25, 50]) {
    if (cancelled) throw new Error('Interrupted');
    console.log(`Testing ${users} active-user equivalent: ${users * 0.1} events/s for 60 seconds`);
    const rate = users / 10;
    let done = false,
      samplingError;
    const traffic = compose(
      'run',
      '--rm',
      '--no-deps',
      'k6',
      'run',
      '--quiet',
      '-e',
      `RATE=${users}`,
      '-e',
      'TIME_UNIT=10s',
      '-e',
      'BATCH_SIZE=1',
      '-e',
      'PADDING_BYTES=512',
      '-e',
      'DURATION=60s',
      '-e',
      `SESSION_COUNT=${users}`,
      '-e',
      'PREALLOCATED_VUS=10',
      '-e',
      'MAX_VUS=50',
      '-e',
      'STRICT_ACCEPTANCE=true',
      '-e',
      `RUN_ID=memory-${users}`,
      '-e',
      `PROJECT_KEY=st_pub_${'A'.repeat(43)}`,
      '-e',
      'TARGET=http://postgres:4104/v1/events',
      '/scripts/ingestion.js',
    );
    traffic.finally(() => (done = true)).catch(() => {});
    const sampling = (async () => {
      while (!done) {
        try {
          samples.push({
            at: new Date().toISOString(),
            users,
            stats: (await compose('stats', '--no-stream', '--format', 'json'))
              .trim()
              .split('\n')
              .filter(Boolean)
              .map(JSON.parse),
          });
          await query(
            'SELECT event_name, count(), uniqExact(distinct_id) FROM signaltrail.analytics_events FINAL GROUP BY event_name FORMAT JSONEachRow',
          );
          await inspect();
        } catch (error) {
          samplingError = error;
          break;
        }
        await delay(2000);
      }
    })();
    let output;
    try {
      output = await traffic;
    } finally {
      done = true;
      await sampling;
    }
    if (samplingError) throw samplingError;
    await save(`k6-${users}.json`, output);
    const summary = JSON.parse(output);
    const accepted = summary.metrics.events_accepted.values.count;
    assert.ok(accepted > 0);
    for (const name of [
      'events_retry',
      'events_rejected',
      'responses_malformed',
      'dropped_iterations',
    ])
      assert.equal(summary.metrics[name]?.values.count ?? 0, 0, name);
    const deadline = Date.now() + 60000;
    let stored;
    do {
      stored = Number(
        await query(
          `SELECT count() FROM signaltrail.analytics_events FINAL WHERE startsWith(event_id,'memory-${users}-')`,
        ),
      );
      if (stored === accepted) break;
      await delay(1000);
    } while (Date.now() < deadline);
    assert.equal(stored, accepted, 'Every accepted event must be queryable');
    stages.push({
      users,
      eventsPerSecond: rate,
      accepted,
      uniqueStored: stored,
      httpDurationMs: summary.metrics.http_req_duration.values,
    });
  }
  result.enforcedLimits = await inspect();
  result.passed = true;
} catch (error) {
  runError = error;
  console.error(error.message);
}
await finishRun({
  result,
  runError,
  cleanup: async () => {
    if (!ownsInfrastructure) {
      await release();
      return;
    }
    try {
      const ids = (await compose('ps', '-aq', ...services)).trim().split(/\s+/).filter(Boolean);
      if (ids.length) {
        const values = JSON.parse(await docker(['inspect', ...ids]));
        await save(
          'lifecycle.json',
          values.map((v) => ({
            service: v.Config.Labels['com.docker.compose.service'],
            memoryLimit: v.HostConfig.Memory,
            swapLimit: v.HostConfig.MemorySwap,
            status: v.State.Status,
            oomKilled: v.State.OOMKilled,
            exitCode: v.State.ExitCode,
            restarts: v.RestartCount,
          })),
        );
      }
    } catch {}
    try {
      await save('services.log', await compose('logs', '--no-color', '--tail', '100'));
    } catch {}
    await cleanupResources([
      { name: 'save memory samples', run: () => save('samples.json', samples) },
      { name: 'save query timings', run: () => save('queries.json', queries) },
      {
        name: 'remove isolated memory stack',
        timeoutMs: 180000,
        run: () =>
          teardownIsolatedRun({
            remove: () => compose('down', '--volumes', '--remove-orphans', '--timeout', '20'),
            remaining: async () => (await compose('ps', '-aq')).trim().split(/\s+/).filter(Boolean),
            release,
          }),
      },
      {
        name: 'remove signal handlers',
        run: async () => {
          process.off('SIGINT', cancel);
          process.off('SIGTERM', cancel);
        },
      },
    ]);
  },
  writeResult: (value) => save('result.json', value),
});
console.log(`Passed: ${directory}/result.json`);
