import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rename, readFile, appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { readCollectorDelivery } from './collector-delivery.mjs';
import { persistIntervalBatch } from './interval-history.mjs';
import { observeUntil } from './observation-loop.mjs';
import { investigateQueryMemory } from './query-memory.mjs';
import { captureMemoryTrace } from './memory-trace.mjs';
import { missingDashboardMetrics } from './dashboard-metrics.mjs';
import { createCapacityTelemetry } from './capacity-telemetry.mjs';
import { capacityTargets } from './capacity-targets.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { memoryPlans, verifyMemoryLimits } from './memory-budget.mjs';
import { acquireRunLock } from './run-lock.mjs';
import { finishRun } from './run-result.mjs';
import { cleanupResources } from './cleanup.mjs';
import { teardownIsolatedRun } from './teardown.mjs';
import {
  assessCapacityStage,
  capacityWorkloads,
  capacityCommandTimeoutMs,
} from './capacity-stage.mjs';

const profile = process.argv[2] ?? 'memory-4gb';
assert.ok(Object.hasOwn(memoryPlans, profile), 'Unknown memory profile');
const memoryPlan = memoryPlans[profile];
const capacity = profile.startsWith('capacity-4gb');
const httpCap = profile === 'capacity-4gb-http32' ? 32 : 128;
const dbConnections = [
  'capacity-4gb-db8',
  'capacity-4gb-db8-long',
  'capacity-4gb-db8-q24',
  'capacity-4gb-db8-q24-noqueries',
  'capacity-4gb-db8-q24-generator',
  'capacity-4gb-db8-q24-rebalanced',
  'capacity-4gb-telemetry',
  'capacity-4gb-memory-trace',
  'capacity-4gb-memory-trace-smoke',
  'capacity-4gb-telemetry-failure',
  'capacity-4gb-query-memory',
  'capacity-4gb-query-memory-no-text-log',
  'capacity-4gb-db8-q24-endurance',
].includes(profile)
  ? 8
  : 4;
const dbQueries =
  profile.startsWith('capacity-4gb-db8-q24') ||
  profile.startsWith('capacity-4gb-telemetry') ||
  profile.startsWith('capacity-4gb-memory-trace') ||
  profile.startsWith('capacity-4gb-query-memory')
    ? 24
    : 16;
const isolatedGenerator = [
  'capacity-4gb-db8-q24-generator',
  'capacity-4gb-db8-q24-rebalanced',
  'capacity-4gb-telemetry',
  'capacity-4gb-memory-trace',
  'capacity-4gb-memory-trace-smoke',
  'capacity-4gb-telemetry-failure',
  'capacity-4gb-query-memory',
  'capacity-4gb-query-memory-no-text-log',
  'capacity-4gb-db8-q24-endurance',
].includes(profile);
let generatorAffinityVerified = false;
const memoryTrace = profile.startsWith('capacity-4gb-memory-trace');
const analyticalLoad = profile !== 'capacity-4gb-db8-q24-noqueries';
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
function docker(args, timeout = capacity ? capacityCommandTimeoutMs(profile) : 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SIGNALTRAIL_FIXTURE_HTTP_CAP: String(httpCap),
        SIGNALTRAIL_FIXTURE_DB_CONNECTIONS: String(dbConnections),
        SIGNALTRAIL_FIXTURE_DB_QUERIES: String(dbQueries),
      },
    });
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
    ...(isolatedGenerator ? ['-f', 'tests/load/compose.generator-isolation.yaml'] : []),
    ...([
      'capacity-4gb-db8-q24-rebalanced',
      'capacity-4gb-telemetry',
      'capacity-4gb-memory-trace',
      'capacity-4gb-memory-trace-smoke',
      'capacity-4gb-telemetry-failure',
      'capacity-4gb-query-memory',
      'capacity-4gb-query-memory-no-text-log',
      'capacity-4gb-db8-q24-endurance',
    ].includes(profile)
      ? ['-f', 'tests/load/compose.memory-rebalanced.yaml']
      : []),
    ...(profile === 'capacity-4gb-query-memory-no-text-log'
      ? ['-f', 'tests/load/compose.no-text-log.yaml']
      : []),
    ...args,
  ]);
const services = Object.keys(memoryPlan.services);
const save = (name, value) =>
  writeFile(
    `${directory}/${name}`,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
const hostTelemetry = capacity ? createCapacityTelemetry() : undefined;
let hostMetricsServer,
  targetsAdvertised = false,
  collectorBefore;
const runStartedAt = Date.now() / 1000;
const runId = directory.split('/').at(-1);
const advertiseTargets = async (targets) => {
  await writeFile('test-results/load-targets.json.tmp', JSON.stringify(targets));
  await rename('test-results/load-targets.json.tmp', 'test-results/load-targets.json');
};
const telemetryConfig = {
  startedAt: runStartedAt,
  active: true,
  connections: dbConnections,
  queryLimit: dbQueries,
  httpLimit: httpCap,
};
let intervalCursor = 0;
async function flushIntervals() {
  const response = await fetch(`http://127.0.0.1:34105/diagnostics?after=${intervalCursor}`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  intervalCursor = await persistIntervalBatch({
    cursor: intervalCursor,
    payload: await response.json(),
    append: (body) => appendFile(`${directory}/stall-intervals.jsonl`, body),
  });
  result.intervalRecordsSaved = intervalCursor;
}
const samples = [];
const stages = [];
const queries = [];
const observationFailures = {};
async function traceMemory() {
  const record = await captureMemoryTrace({
    request: query,
    append: (record) =>
      appendFile(`${directory}/clickhouse-memory.jsonl`, JSON.stringify(record) + '\n'),
  });
  result.memoryTraceSnapshots = (result.memoryTraceSnapshots ?? 0) + 1;
  for (const error of record.errors)
    await reportObservationError('clickhouse-memory', new Error(`${error.name}: ${error.message}`));
  return record;
}
async function reportObservationError(kind, error) {
  const record = { at: new Date().toISOString(), kind, message: error.message };
  await appendFile(`${directory}/observation-errors.jsonl`, JSON.stringify(record) + '\n');
  observationFailures[kind] = (observationFailures[kind] ?? 0) + 1;
  result.observationFailures = { ...observationFailures };
  console.error(`${kind} observation failed: ${error.message}`);
}
async function inspect() {
  const ids = (await compose('ps', '-q', ...services)).trim().split(/\s+/).filter(Boolean);
  assert.equal(ids.length, services.length);
  const values = JSON.parse(await docker(['inspect', ...ids]));
  verifyMemoryLimits(values, memoryPlan);
  if (capacity) {
    const app = values.find((v) => v.Config.Labels['com.docker.compose.service'] === 'app');
    assert.ok(
      app.Config.Env.includes(`SIGNALTRAIL_FIXTURE_HTTP_CAP=${httpCap}`),
      'HTTP cap must match profile',
    );
  }
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
async function query(sql, queryId) {
  const start = performance.now();
  const endpoint = new URL('http://127.0.0.1:38124/?wait_end_of_query=1');
  if (queryId) endpoint.searchParams.set('query_id', queryId);
  const r = await fetch(endpoint, {
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
  generatorCpuSet: isolatedGenerator ? '2,3' : null,
  analyticalQueriesDuringTraffic: analyticalLoad,
  applicationLimits: {
    httpConcurrentRequests: httpCap,
    metadataConnections: dbConnections,
    metadataOutstandingQueries: dbQueries,
  },
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
  ...(profile === 'capacity-4gb-telemetry-failure'
    ? {
        faultInjection:
          'First analytical query uses max_memory_usage=1; expected failed capacity result',
      }
    : {}),
  stages,
  directory,
  limitations: [
    `Per-service hard memory caps sum to ${serviceMiB} MiB; ${memoryPlan.hostReserveMiB} MiB is reserved, not allocated to a real guest OS.`,
    `Not a ${totalGiB} GiB VM: separate cgroups, shared host CPU/disk, Docker kernel and host caches differ.`,
    `${capacity ? 1000000 : 100000} historical fixture rows; short runs do not qualify retention-scale, backups, replay or production endurance.`,
    'PostgreSQL stored-key lookup is real; synthetic fixture role/schema is not production authorization provisioning.',
    analyticalLoad
      ? 'Valkey runs idle; dashboard query load is direct SQL, not the Clerk/Next.js UI.'
      : 'Control suppresses analytical SQL during traffic; final reconciliation and metadata diagnostics remain. This does not qualify concurrent dashboard traffic.',
  ],
};
async function collectQueryMemory(phase) {
  if (!profile.startsWith('capacity-4gb-query-memory')) return;
  const evidence = await investigateQueryMemory({
    request: query,
    save: (report) => save(`query-memory-${phase}.json`, report),
    runId: `${runId}-${phase}`,
  });
  result.queryMemoryInvestigation ??= {};
  result.queryMemoryInvestigation[phase] = evidence;
  assert.equal(evidence.errors.length, 0, 'Query-memory evidence unavailable');
  assert.ok(
    evidence.variants.every((variant) => variant.ok),
    'A query-memory control failed',
  );
  const logs = evidence.snapshots.find((snapshot) => snapshot.name === 'query-log').data;
  for (const variant of evidence.variants) {
    const matching = logs.filter(
      (row) => row.query_id === variant.queryId && row.type === 'QueryFinish',
    );
    assert.equal(matching.length, 1, 'Expected one query-log finish per diagnostic query');
    assert.ok(matching[0].memory_usage > 0, 'Query memory was not measured');
  }
}
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
    assert.ok(host.NCPU >= (isolatedGenerator ? 4 : 2), 'Enough logical CPUs must be available');
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
  if (capacity) {
    hostTelemetry.setRun(telemetryConfig);
    hostMetricsServer = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/metrics') {
        response.writeHead(404).end();
        return;
      }
      void hostTelemetry.registry
        .metrics()
        .then((body) =>
          response.writeHead(200, { 'Content-Type': hostTelemetry.registry.contentType }).end(body),
        )
        .catch(() => response.writeHead(503).end());
    });
    await new Promise((resolve, reject) => {
      hostMetricsServer.once('error', reject);
      hostMetricsServer.listen(34107, '127.0.0.1', resolve);
    });
    collectorBefore = await readCollectorDelivery();
    await advertiseTargets(capacityTargets({ profile, runId }));
    targetsAdvertised = true;
    // Check each exposed protocol before starting traffic; remote delivery is a separate check.
    for (const path of ['/metrics', '/processor-metrics', '/broker-metrics']) {
      const response = await fetch(`http://127.0.0.1:34105${path}`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200, `Metrics endpoint unavailable: ${path}`);
      const body = await response.text();
      assert.ok(body.includes('# TYPE'), `No Prometheus metric types: ${path}`);
      await save(path.slice(1) + '.initial.prom', body);
    }
    const hostResponse = await fetch('http://127.0.0.1:34107/metrics', {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(hostResponse.status, 200);
    await save('capacity-host.initial.prom', await hostResponse.text());
    result.telemetryVerification = { localEndpoints: true, cloudQueryVerified: false };
    result.telemetryTargets = capacityTargets({ profile, runId });
  }
  await collectQueryMemory('before');
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
    hostTelemetry?.setRun({ ...telemetryConfig, offeredRate: rate });
    const trafficStarted = performance.now();
    let lastProgressAt = 0;
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
    const sampling = observeUntil({
      done: () => done,
      onError: async (error) => {
        samplingError ??= error;
        await reportObservationError('resources', error);
      },
      observe: async () => {
        const observation = {
          at: new Date().toISOString(),
          monotonicStartMs: performance.now(),
          users,
          stats: (await compose('stats', '--no-stream', '--format', 'json'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(JSON.parse),
        };
        if (capacity) observation.pipeline = await status();
        observation.finishedAt = new Date().toISOString();
        observation.collectionMs = performance.now() - observation.monotonicStartMs;
        if (isolatedGenerator) {
          const ids = (
            await docker([
              'ps',
              '-q',
              '--filter',
              'label=com.docker.compose.project=signaltrail-memory',
              '--filter',
              'label=com.docker.compose.service=k6',
            ])
          )
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          if (ids.length) {
            const generators = JSON.parse(await docker(['inspect', ...ids]));
            for (const generator of generators)
              assert.equal(generator.HostConfig.CpusetCpus, '2,3');
            generatorAffinityVerified = true;
            observation.generatorAffinityVerified = true;
          }
        }
        if (capacity) {
          observation.clickhouseMemoryStartedAt = new Date().toISOString();
          observation.clickhouseMemory = await compose(
            'exec',
            '-T',
            'clickhouse',
            'cat',
            '/sys/fs/cgroup/memory.events',
            '/sys/fs/cgroup/memory.pressure',
            '/sys/fs/cgroup/memory.current',
            '/sys/fs/cgroup/memory.max',
            '/sys/fs/cgroup/memory.stat',
          );
          observation.clickhouseMemoryFinishedAt = new Date().toISOString();
        }
        hostTelemetry?.updateSample(observation, memoryPlan);
        samples.push(observation);
        if (capacity && (!lastProgressAt || performance.now() - lastProgressAt >= 60000)) {
          const state = observation.pipeline;
          const checkpoint = {
            phase: 'running',
            at: new Date().toISOString(),
            profile,
            elapsedSeconds: (performance.now() - trafficStarted) / 1000,
            offeredEventsPerSecond: rate,
            brokerAcknowledged: state.publisher.completed,
            metadataRefused: state.metadata.refused,
            metadataFailures: state.metadata.failedQueries,
            httpRefused: state.admission.refused,
            sourceLag: state.source.total,
            peakOutstandingQueries: state.metadata.peakInFlight,
            loopMaxMs: state.eventLoopDelayMs.max,
            intervalRecordsSaved: intervalCursor,
          };
          await save('capacity-progress.json', checkpoint);
          console.log(
            `Progress ${Math.round(checkpoint.elapsedSeconds)}s: broker_acknowledged=${checkpoint.brokerAcknowledged}, metadata_refused=${checkpoint.metadataRefused}, http_refused=${checkpoint.httpRefused}, lag=${checkpoint.sourceLag}`,
          );
          lastProgressAt = performance.now();
        }
        await inspect();
      },
    });
    const intervals = capacity
      ? observeUntil({
          done: () => done,
          observe: flushIntervals,
          onError: async (error) => {
            samplingError ??= error;
            await reportObservationError('intervals', error);
          },
        })
      : Promise.resolve();
    let analyticalError;
    let analyticalAttempts = 0;
    const tracing = memoryTrace
      ? observeUntil({
          done: () => done,
          intervalMs: 15000,
          observe: traceMemory,
          onError: async (error) => {
            samplingError ??= error;
            await reportObservationError('clickhouse-memory-export', error);
          },
        })
      : Promise.resolve();
    const analytical = analyticalLoad
      ? observeUntil({
          done: () => done,
          observe: async () => {
            analyticalAttempts++;
            const injectFailure =
              profile === 'capacity-4gb-telemetry-failure' && analyticalAttempts === 1;
            const queryId = memoryTrace ? `${runId}-analytical-${analyticalAttempts}` : undefined;
            const startedAt = new Date().toISOString(),
              started = performance.now();
            let queryFailure;
            try {
              await query(
                'SELECT event_name, count(), uniqExact(distinct_id) FROM signaltrail.analytics_events FINAL GROUP BY event_name' +
                  (injectFailure ? ' SETTINGS max_memory_usage=1' : '') +
                  ' FORMAT JSONEachRow',
                queryId,
              );
            } catch (error) {
              queryFailure = error;
              throw error;
            } finally {
              if (memoryTrace)
                await appendFile(
                  `${directory}/analytical-attempts.jsonl`,
                  JSON.stringify({
                    queryId,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    ms: performance.now() - started,
                    ok: !queryFailure,
                    ...(queryFailure ? { message: queryFailure.message } : {}),
                  }) + '\n',
                );
            }
          },
          onError: async (error) => {
            analyticalError ??= error;
            await reportObservationError('analytical', error);
          },
        })
      : Promise.resolve();
    // Attach rejection handlers immediately; artifact-write errors still fail the run.
    const observations = Promise.allSettled([sampling, intervals, analytical, tracing]);
    let output;
    try {
      output = await traffic;
    } finally {
      done = true;
      const outcomes = await observations;
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed) throw failed.reason;
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
      if (analyticalError)
        stage.reasons.push(`Analytical query failed: ${analyticalError.message}`);
      stage.analyticalAttempts = analyticalAttempts;
      if (observationFailures['clickhouse-memory'])
        stage.reasons.push('ClickHouse memory snapshots have unavailable categories');
      const drainStart = performance.now(),
        deadline = Date.now() + 60000;
      do {
        stage.pipeline = await status();
        assert.equal(stage.pipeline.metadata.maxConnections, dbConnections);
        assert.equal(stage.pipeline.metadata.capacity, dbQueries);
        assert.ok(stage.pipeline.metadata.connectionWaitMs.count > 0);
        assert.ok(stage.pipeline.metadata.queryExecutionMs.count > 0);
        assert.ok(stage.pipeline.admission.peakActiveRequests > 0);
        assert.ok(Number.isFinite(stage.pipeline.eventLoopDelayMs.max));
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
      if (isolatedGenerator) {
        assert.ok(generatorAffinityVerified, 'Generator affinity was not verified');
        result.generatorAffinityVerified = true;
      }
      hostTelemetry?.setRun({
        ...telemetryConfig,
        offeredRate: rate,
        accepted,
        stored: stage.uniqueStored,
        dropped: stage.droppedIterations,
      });
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
    if (analyticalError) throw analyticalError;
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
  await collectQueryMemory('after');
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
      ...(capacity
        ? [
            ...(memoryTrace
              ? [
                  {
                    name: 'save final ClickHouse memory and query logs',
                    timeoutMs: 90000,
                    run: async () => {
                      await traceMemory();
                      await query('SYSTEM FLUSH LOGS');
                      const body = await query(
                        `SELECT query_id, toString(type) AS type, query_duration_ms, read_rows, memory_usage, exception_code, exception FROM system.query_log WHERE startsWith(query_id, '${runId}-analytical-') AND type != 'QueryStart' ORDER BY event_time_microseconds SETTINGS max_threads=1, max_memory_usage=67108864 FORMAT JSONEachRow`,
                      );
                      await save('analytical-query-log.jsonl', body);
                      assert.ok(body.trim(), 'No analytical query-log evidence');
                    },
                  },
                ]
              : []),
            {
              name: 'save interval diagnostics',
              timeoutMs: 15000,
              run: async () => {
                await flushIntervals();
                result.telemetryVerification.intervalHistoryCompleteThroughExport = true;
                await save('stall-history.json', {
                  savedThroughSequence: intervalCursor,
                  exportedAt: new Date().toISOString(),
                  format: 'stall-intervals.jsonl',
                  note: 'Contiguous history through export; post-export scrape-hold intervals are outside the traffic/drain window.',
                });
                const response = await fetch('http://127.0.0.1:34105/diagnostics', {
                  signal: AbortSignal.timeout(10000),
                });
                assert.equal(response.status, 200);
                const diagnostics = await response.json();
                assert.ok(diagnostics.totalRecords > 0);
                await save('stall-diagnostics.json', diagnostics);
              },
            },
            {
              name: 'save final capacity metrics',
              timeoutMs: 20000,
              run: async () => {
                hostTelemetry.setRun({
                  ...telemetryConfig,
                  active: false,
                  endedAt: Date.now() / 1000,
                });
                if (hostMetricsServer) {
                  const finalBodies = [await hostTelemetry.registry.metrics()];
                  await save('capacity-host.final.prom', finalBodies[0]);
                  for (const path of ['/metrics', '/processor-metrics', '/broker-metrics']) {
                    const response = await fetch(`http://127.0.0.1:34105${path}`, {
                      signal: AbortSignal.timeout(5000),
                    });
                    assert.equal(response.status, 200);
                    const body = await response.text();
                    finalBodies.push(body);
                    await save(path.slice(1) + '.final.prom', body);
                  }
                  // Leave the final marker available for at least one five-second scrape.
                  if (targetsAdvertised) await delay(6000);
                  const collectorAfter = await readCollectorDelivery();
                  result.telemetryVerification.alloyLoadForwardingObserved = !!(
                    collectorBefore?.available &&
                    collectorAfter.available &&
                    collectorAfter.loadForwarded > collectorBefore.loadForwarded
                  );
                  await save('collector-delivery.json', {
                    before: collectorBefore,
                    after: collectorAfter,
                    note: 'Remote write counters aggregate all jobs; they are not proof of cloud query results for this run.',
                  });
                  if (profile === 'capacity-4gb-telemetry' && stages.length) {
                    const dashboard = JSON.parse(
                      await readFile('infra/monitoring/capacity-dashboard.json', 'utf8'),
                    );
                    const missing = missingDashboardMetrics(dashboard, finalBodies);
                    assert.deepEqual(missing, [], 'Dashboard references unexposed metrics');
                    result.telemetryVerification.dashboardMetricContract = true;
                  }
                }
              },
            },
            {
              name: 'withdraw capacity scrape targets',
              run: async () => {
                if (targetsAdvertised) await advertiseTargets([]);
              },
            },
            {
              name: 'close capacity host exporter',
              run: async () => {
                if (hostMetricsServer)
                  await new Promise((resolve) => hostMetricsServer.close(resolve));
                hostTelemetry.close();
              },
            },
          ]
        : []),
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
