// Synthetic isolated fixture only; no development credentials/configuration are loaded.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  createIngestionServer,
  createProjectRuntime,
  createRedpandaPublisher,
} from '../../apps/ingestion/dist/index.js';
const { Client } = createRequire(
  new URL('../../packages/project-access/package.json', import.meta.url),
)('pg');
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
  `INSERT INTO signaltrail.analytics_events SELECT '00000000-0000-0000-0000-000000000011', concat('seed-',toString(number)), now64(3) - toIntervalDay(number % 30), toString(now64(3)), 'history_seed', concat('visitor-',toString(number%50)), concat('session-',toString(number%50)), number, 'https://load.invalid', '{}', '{}' FROM numbers(100000)`,
);
const projects = createProjectRuntime({
  NODE_ENV: 'production',
  SIGNALTRAIL_INGESTION_DATABASE_URL:
    'postgres://signaltrail:signaltrail_local@127.0.0.1:5432/signaltrail',
  SIGNALTRAIL_INGESTION_DATABASE_TLS: 'false',
});
await projects.verify();
const publisher = createRedpandaPublisher({
  brokers: ['redpanda:9092'],
  topic: 'signaltrail.analytics.v1',
  maxOutstandingEvents: 1000,
  maxOutstandingBytes: 8388608,
});
await publisher.connect();
const worker = spawn(process.execPath, ['workers/event-processor/dist/main.js'], {
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    NODE_OPTIONS: '--max-old-space-size=128',
    SIGNALTRAIL_REDPANDA_BROKERS: 'redpanda:9092',
    SIGNALTRAIL_REDPANDA_TOPIC: 'signaltrail.analytics.v1',
    SIGNALTRAIL_REDPANDA_DLQ_TOPIC: 'signaltrail.analytics.dlq.v1',
    SIGNALTRAIL_PROCESSOR_GROUP_ID: 'memory-budget',
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
  maxConcurrentRequests: 32,
  resolveProjectKey: projects.resolveProjectKey,
  publish: publisher.publish,
});
server.listen(4104, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    worker.kill('SIGTERM');
    await new Promise((resolve) => worker.once('exit', resolve));
    await publisher.close();
    await projects.close();
    clearTimeout(deadline);
  });
