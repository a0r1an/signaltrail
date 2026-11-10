// Synthetic isolated fixture only; no development credentials/configuration are loaded.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createIngestionMetrics } from '../../apps/ingestion/src/metrics.ts';
import { createCapacityTelemetry } from './capacity-telemetry.mjs';
import { startStallObserver } from './stall-observer.mjs';
import { measureSourceLag } from './pipeline-measurements.mjs';
import { createPostgresMembershipDatabase } from '../../packages/project-access/dist/index.js';
import {
  createIngestionServer,
  createProjectRuntime,
  createRedpandaPublisher,
} from '../../apps/ingestion/dist/index.js';
const { Client } = createRequire(
  new URL('../../packages/project-access/package.json', import.meta.url),
)('pg');
const capacity = process.env.SIGNALTRAIL_CAPACITY_PROFILE === '1';
const seedRows = capacity ? 1000000 : 100000;
const pg = new Client({
  connectionString: 'postgres://signaltrail:signaltrail_local@127.0.0.1:5432/signaltrail',
});
await pg.connect();
await pg.query(
  'CREATE SCHEMA signaltrail_control; CREATE TABLE signaltrail_control.ingestion_keys(project_id uuid NOT NULL,key_hash bytea UNIQUE NOT NULL,revoked_at timestamptz)',
);
await pg.query('INSERT INTO signaltrail_control.ingestion_keys VALUES ($1,$2,NULL)', [
  '00000000-0000-0000-0000-000000000011',
  createHash('sha256')
    .update('st_pub_' + 'A'.repeat(43))
    .digest(),
]);
await pg.end();
async function query(sql) {
  const response = await fetch('http://clickhouse:8123/?wait_end_of_query=1', {
    method: 'POST',
    headers: { 'X-ClickHouse-User': 'signaltrail', 'X-ClickHouse-Key': 'signaltrail_local' },
    body: sql,
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (!response.ok || ![null, '0'].includes(response.headers.get('X-ClickHouse-Exception-Code')))
    throw new Error(text);
  return text;
}
await query(await readFile('infra/clickhouse/001-analytics-events.sql', 'utf8'));
await query(
  `INSERT INTO signaltrail.analytics_events SELECT '00000000-0000-0000-0000-000000000011', concat('seed-',toString(number)), now64(3) - toIntervalDay(number % 30), toString(now64(3)), 'history_seed', concat('visitor-',toString(number%${capacity ? 10000 : 50})), concat('session-',toString(number%${capacity ? 10000 : 50})), number, 'https://load.invalid', '{}', '{}' FROM numbers(${seedRows})`,
);
let applicationMetrics, capacityMetrics;
let metadataDatabase,
  metadataFailures = 0,
  metadataAtCapacity = 0;
const projects = createProjectRuntime(
  {
    NODE_ENV: 'production',
    SIGNALTRAIL_INGESTION_DATABASE_URL:
      'postgres://signaltrail:signaltrail_local@127.0.0.1:5432/signaltrail',
    SIGNALTRAIL_INGESTION_DATABASE_TLS: 'false',
  },
  capacity
    ? {
        createDatabase(options) {
          const database = createPostgresMembershipDatabase({
            ...options,
            onQueryTiming: (phase, seconds) =>
              capacityMetrics?.observeDatabaseTiming(phase, seconds),
            maxConnections: Number(process.env.SIGNALTRAIL_FIXTURE_DB_CONNECTIONS ?? 4),
            maxInFlight: Number(process.env.SIGNALTRAIL_FIXTURE_DB_QUERIES ?? 16),
          });
          metadataDatabase = database;
          return {
            close: database.close,
            query(input) {
              const state = database.snapshot();
              if (state.inFlight >= state.capacity) metadataAtCapacity++;
              return database.query(input).catch((error) => {
                metadataFailures++;
                throw error;
              });
            },
          };
        },
      }
    : undefined,
);
await projects.verify();
const publisher = createRedpandaPublisher({
  brokers: ['redpanda:9092'],
  topic: 'signaltrail.analytics.v1',
  maxOutstandingEvents: 1000,
  maxOutstandingBytes: 8388608,
  onPublicationSettled: (seconds, failed) =>
    applicationMetrics?.observePublication(seconds, failed),
});
if (capacity) {
  applicationMetrics = createIngestionMetrics(publisher.snapshot, {
    maxEvents: 1000,
    maxBytes: 8388608,
    maxConcurrentRequests: Number(process.env.SIGNALTRAIL_FIXTURE_HTTP_CAP ?? 128),
  });
  capacityMetrics = createCapacityTelemetry({
    registry: applicationMetrics.registry,
    kind: 'ingestion',
  });
}
await publisher.connect();
let observer, statusServer, stallObserver, diagnosticDatabase;
let activeRequests = 0,
  admissionRefused = 0;
const statusClasses = {};
let peakActiveRequests = 0;
const recentHttpRefusals = [];
const eventLoopDelay = capacity ? monitorEventLoopDelay({ resolution: 20 }) : undefined;
eventLoopDelay?.enable();
if (capacity) {
  diagnosticDatabase = new Client({
    connectionString: 'postgres://signaltrail:signaltrail_local@127.0.0.1:5432/signaltrail',
    application_name: 'signaltrail-fixture-diagnostics',
    connectionTimeoutMillis: 2000,
    query_timeout: 1000,
    statement_timeout: 500,
  });
  diagnosticDatabase.on('error', () => {});
  await diagnosticDatabase.connect();
  stallObserver = startStallObserver({
    database: diagnosticDatabase,
    onRecord: (record) => capacityMetrics.updateInterval(record),
    snapshot: () => ({
      metadata: metadataDatabase.snapshot(),
      admission: { activeRequests, refused: admissionRefused },
      publisher: publisher.snapshot(),
      statusClasses: { ...statusClasses },
    }),
  });
  const { Kafka, logLevel } = createRequire(
    new URL('../../apps/ingestion/package.json', import.meta.url),
  )('kafkajs');
  observer = new Kafka({
    brokers: ['redpanda:9092'],
    clientId: 'capacity-observer',
    logLevel: logLevel.ERROR,
  }).admin();
  await observer.connect();
  statusServer = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (req.url === '/metrics') {
      capacityMetrics.updateApplication({
        metadata: metadataDatabase.snapshot(),
        admission: { activeRequests, refused: admissionRefused, peakActiveRequests },
      });
      void applicationMetrics.registry
        .metrics()
        .then((body) =>
          res.writeHead(200, { 'Content-Type': applicationMetrics.registry.contentType }).end(body),
        )
        .catch(() => res.writeHead(503).end());
      return;
    }
    if (req.url === '/processor-metrics' || req.url === '/broker-metrics') {
      const url =
        req.url === '/processor-metrics'
          ? 'http://127.0.0.1:4107/metrics'
          : 'http://redpanda:9644/public_metrics';
      void fetch(url, { signal: AbortSignal.timeout(2000) })
        .then(async (response) => {
          res.writeHead(response.status, {
            'Content-Type': response.headers.get('content-type') ?? 'text/plain',
          });
          res.end(await response.text());
        })
        .catch(() => res.writeHead(503).end());
      return;
    }
    const diagnosticsRequest = /^\/diagnostics(?:\?after=(\d+))?$/.exec(req.url ?? '');
    if (diagnosticsRequest) {
      const after = Number(diagnosticsRequest[1] ?? 0);
      if (!Number.isSafeInteger(after)) {
        res.writeHead(400).end();
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(stallObserver.records(after)));
      return;
    }
    if (req.url !== '/status') {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      const committed = await observer.fetchOffsets({
        groupId: 'memory-budget',
        topics: ['signaltrail.analytics.v1'],
      });
      const high = await observer.fetchTopicOffsets('signaltrail.analytics.v1');
      const source = measureSourceLag(high, committed[0]?.partitions ?? []);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          source,
          diagnostics: stallObserver.snapshot(),
          publisher: publisher.snapshot(),
          admission: {
            activeRequests,
            peakActiveRequests,
            refused: admissionRefused,
            recentRefusals: recentHttpRefusals,
          },
          eventLoopDelayMs: {
            mean: Number.isFinite(eventLoopDelay.mean) ? eventLoopDelay.mean / 1e6 : null,
            p99: eventLoopDelay.percentile(99) / 1e6,
            max: eventLoopDelay.max / 1e6,
          },
          metadata: {
            ...metadataDatabase.snapshot(),
            failedQueries: metadataFailures,
            attemptsAtCapacity: metadataAtCapacity,
          },
          statusClasses,
        }),
      );
    })().catch(() => res.writeHead(503).end());
  });
  statusServer.listen(4105, '0.0.0.0');
}
const worker = spawn(process.execPath, ['workers/event-processor/dist/main.js'], {
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    NODE_OPTIONS: '--max-old-space-size=128',
    SIGNALTRAIL_REDPANDA_BROKERS: 'redpanda:9092',
    SIGNALTRAIL_REDPANDA_TOPIC: 'signaltrail.analytics.v1',
    SIGNALTRAIL_REDPANDA_DLQ_TOPIC: 'signaltrail.analytics.dlq.v1',
    SIGNALTRAIL_PROCESSOR_GROUP_ID: 'memory-budget',
    SIGNALTRAIL_PROCESSOR_BATCH_WAIT_MS: process.env.SIGNALTRAIL_FIXTURE_BATCH_WAIT_MS ?? '0',
    SIGNALTRAIL_CLICKHOUSE_ASYNC_INSERT: process.env.SIGNALTRAIL_FIXTURE_ASYNC_INSERT ?? '0',
    ...(capacity ? { SIGNALTRAIL_PROCESSOR_METRICS_PORT: '4107' } : {}),
    SIGNALTRAIL_CLICKHOUSE_URL: 'http://clickhouse:8123',
    SIGNALTRAIL_CLICKHOUSE_USERNAME: 'signaltrail',
    SIGNALTRAIL_CLICKHOUSE_PASSWORD: 'signaltrail_local',
  },
});
let stopping = false;
worker.on('exit', (code) => {
  if (!stopping) process.exit(code || 1);
});
const server = createIngestionServer({
  maxConcurrentRequests: Number(process.env.SIGNALTRAIL_FIXTURE_HTTP_CAP ?? 128),
  resolveProjectKey: projects.resolveProjectKey,
  publish: publisher.publish,
  ...(capacity
    ? {
        observeAdmission(active, refused) {
          applicationMetrics.observeAdmission(active, refused);
          activeRequests = active;
          peakActiveRequests = Math.max(peakActiveRequests, active);
          if (refused) {
            admissionRefused++;
            recentHttpRefusals.push({ at: new Date().toISOString(), activeRequests });
            if (recentHttpRefusals.length > 32) recentHttpRefusals.shift();
          }
        },
        observeRequest(status, seconds) {
          applicationMetrics.observeRequest(status, seconds);
          const key = String(status);
          statusClasses[key] = (statusClasses[key] ?? 0) + 1;
        },
      }
    : {}),
});
server.listen(4104, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    stallObserver?.stop();
    capacityMetrics?.close();
    await diagnosticDatabase?.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    worker.kill('SIGTERM');
    await new Promise((resolve) => worker.once('exit', resolve));
    await publisher.close();
    await projects.close();
    await observer?.disconnect();
    statusServer?.close();
    clearTimeout(deadline);
  });
