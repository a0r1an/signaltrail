import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { memoryPlans, verifyMemoryLimits } from './memory-budget.mjs';
import { acquireRunLock } from './run-lock.mjs';
import { finishRun } from './run-result.mjs';
import { cleanupResources } from './cleanup.mjs';
import { teardownIsolatedRun } from './teardown.mjs';
import { assessCapacityStage, capacityWorkloads } from './capacity-stage.mjs';

const profile = process.argv[2] ?? 'memory-4gb';
assert.ok(Object.hasOwn(memoryPlans, profile), 'Unknown memory profile');
const memoryPlan = memoryPlans[profile];
const capacity = profile.startsWith('capacity-4gb');
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
function docker(args, timeout = 300000) {
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
        : reject(
            Object.assign(
              new Error(`docker ${args.slice(0, 4).join(' ')} failed: ${error.slice(-4000)}`),
              { stdout: output, exitCode: code },
            ),
          );
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
    ...(capacity ? ['-f', 'tests/load/compose.capacity.yaml'] : []),
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
    ...(capacity ? { cpuSet: v.HostConfig.CpusetCpus } : {}),
  }));
}
async function status() {
  const response = await fetch('http://127.0.0.1:34105/status', {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, 'Capacity observer unavailable');
  return response.json();
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
  ...(capacity
    ? {
        highestPassingEventsPerSecond: 0,
        seedRows: 1000000,
        sessionCount: 1000,
        thresholds: {
          httpP95Ms: 500,
          httpP99Ms: 2000,
          diagnosticQueryMaxMs: 2000,
          drainSeconds: 60,
        },
      }
    : {}),
  memoryPlan,
  stages,
  directory,
  limitations: [
    `Per-service hard memory caps sum to ${serviceMiB} MiB; ${memoryPlan.hostReserveMiB} MiB is reserved, not allocated to a real guest OS.`,
    `Not a ${totalGiB} GiB VM: separate cgroups, shared host CPU/disk, Docker kernel and host caches differ.`,
    `${capacity ? 1000000 : 100000} historical fixture rows; short runs do not qualify retention-scale, backups, replay or production endurance.`,
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
  if (capacity) {
    const host = JSON.parse(await docker(['info', '--format', '{{json .}}']));
    assert.ok(host.NCPU >= 2, 'Two logical CPUs must be available');
    result.dockerHost = {
      cpus: host.NCPU,
      memoryBytes: host.MemTotal,
      architecture: host.Architecture,
      kernel: host.KernelVersion,
    };
    result.limitations.push(
      'Target services share CPU affinity 0,1; cores are not exclusive and do not model Lightsail CPU credits or EBS.',
    );
    result.limitations.push(
      'Failed-stage accepted/stored count mismatches after ambiguous responses do not by themselves prove accepted-event loss.',
    );
  }
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
  if (capacity) {
    const deadline = Date.now() + 90000;
    for (;;) {
      try {
        await status();
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await delay(1000);
      }
    }
  }
  result.enforcedLimits = await inspect();
  assert.equal(
    Number(
      await query(
        "SELECT count() FROM signaltrail.analytics_events FINAL WHERE event_name='history_seed'",
      ),
    ),
    capacity ? 1000000 : 100000,
  );
  const workloads = capacity
    ? capacityWorkloads(profile)
    : [10, 25, 50].map((users) => ({ users, rate: users / 10, sessionCount: users }));
  for (const { users, rate, sessionCount, durationSeconds = 60 } of workloads) {
    if (cancelled) throw new Error('Interrupted');
    console.log(
      capacity
        ? `Capacity stage: ${rate} events/s for ${durationSeconds} seconds`
        : `Testing ${users} active-user equivalent: ${rate} events/s for 60 seconds`,
    );
    const queryStart = queries.length;
    let done = false,
      samplingError,
      trafficError;
    const traffic = compose(
      'run',
      '--rm',
      '--no-deps',
      'k6',
      'run',
      '--quiet',
      ...(capacity ? ['--summary-trend-stats', 'avg,min,med,max,p(90),p(95),p(99)'] : []),
      '-e',
      `RATE=${rate * 10}`,
      '-e',
      'TIME_UNIT=10s',
      '-e',
      'BATCH_SIZE=1',
      '-e',
      'PADDING_BYTES=512',
      '-e',
      `DURATION=${durationSeconds}s`,
      '-e',
      `SESSION_COUNT=${sessionCount}`,
      '-e',
      `PREALLOCATED_VUS=${capacity ? 100 : 10}`,
      '-e',
      `MAX_VUS=${capacity ? 400 : 50}`,
      '-e',
      'STRICT_ACCEPTANCE=true',
      '-e',
      `RUN_ID=memory-${users}`,
      '-e',
      `PROJECT_KEY=st_pub_${'A'.repeat(43)}`,
      '-e',
      'TARGET=http://postgres:4104/v1/events',
      '/scripts/ingestion.js',
    ).catch((error) => {
      trafficError = error;
      return error.stdout ?? '';
    });
    traffic.finally(() => (done = true)).catch(() => {});
    const sampling = (async () => {
      while (!done) {
        try {
          const observation = {
            at: new Date().toISOString(),
            users,
            stats: (await compose('stats', '--no-stream', '--format', 'json'))
              .trim()
              .split('\n')
              .filter(Boolean)
              .map(JSON.parse),
          };
          if (capacity) observation.pipeline = await status();
          samples.push(observation);
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
    await save(`k6-${users}.json`, output);
    const summary = JSON.parse(output);
    const accepted = summary.metrics.events_accepted.values.count;
    if (capacity) {
      const stage = {
        eventsPerSecond: rate,
        durationSeconds,
        sessionCount,
        accepted,
        sustained: false,
        reasons: assessCapacityStage(summary),
        httpDurationMs: summary.metrics.http_req_duration.values,
        retry: summary.metrics.events_retry?.values.count,
        rejected: summary.metrics.events_rejected?.values.count,
        malformed: summary.metrics.responses_malformed?.values.count,
        droppedIterations: summary.metrics.dropped_iterations?.values.count ?? 0,
        httpFailureRate: summary.metrics.http_req_failed?.values.rate,
      };
      stages.push(stage);
      if (trafficError) stage.reasons.push(`k6 exit ${trafficError.exitCode}`);
      if (samplingError) stage.reasons.push(`Sampling failed: ${samplingError.message}`);
      const drainStart = performance.now(),
        deadline = Date.now() + 60000;
      do {
        stage.pipeline = await status();
        stage.uniqueStored = Number(
          await query(
            `SELECT count() FROM signaltrail.analytics_events FINAL WHERE startsWith(event_id,'memory-${users}-')`,
          ),
        );
        if (stage.uniqueStored === accepted && stage.pipeline.source.total === '0') break;
        await delay(1000);
      } while (Date.now() < deadline && !cancelled);
      stage.drainSeconds = (performance.now() - drainStart) / 1000;
      if (stage.uniqueStored !== accepted || stage.pipeline.source.total !== '0')
        stage.reasons.push('Storage/offset drain did not reconcile within 60 seconds');
      const durations = queries.slice(queryStart).map((q) => q.ms);
      stage.maxDiagnosticQueryMs = Math.max(...durations);
      if (stage.maxDiagnosticQueryMs > 2000)
        stage.reasons.push('Diagnostic query exceeded 2 seconds');
      await inspect();
      stage.sustained = stage.reasons.length === 0;
      if (stage.sustained) result.highestPassingEventsPerSecond = rate;
      await save('progress.json', { ...result, passed: false });
      if (!stage.sustained) {
        result.firstUnsustainedEventsPerSecond = rate;
        throw new Error(
          `Capacity target not sustained at ${rate} events/s: ${stage.reasons.join('; ')}`,
        );
      }
      console.log(
        `Sustained ${rate} events/s; accepted=${accepted}, source lag=${stage.pipeline.source.total}`,
      );
      continue;
    }
    if (samplingError) throw samplingError;
    if (trafficError) throw trafficError;
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
  if (capacity) result.ceilingNotReached = true;
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
