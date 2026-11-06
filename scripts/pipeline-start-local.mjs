import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashIngestionKey } from '../packages/project-access/dist/index.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = new Set();
let stopping = false;
let stage = 'configuration';
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  const deadline = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 16000);
  deadline.unref();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
function start(file, args, env, cwd = root) {
  if (stopping) return;
  const child = spawn(process.execPath, [file, ...args], { cwd, env, stdio: 'inherit' });
  children.add(child);
  child.on('error', () => stop(1));
  child.on('exit', (code) => {
    children.delete(child);
    if (!stopping) stop(code || 1);
  });
}
try {
  if (process.argv.length !== 2) throw new Error();
  const state = JSON.parse(
    await readFile(join(root, '.local-data/dashboard-local-setup.json'), 'utf8'),
  );
  if (
    !/^st_dashboard_[a-f0-9]{12}$/.test(state.readerName) ||
    ![state.ingestionPassword, state.processorPassword].every(
      (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
    )
  )
    throw new Error();
  hashIngestionKey(state.publicKey);
  for (const port of [4102, 9467, 3001]) {
    stage = `port ${port}`;
    await new Promise((done, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(done));
    });
  }
  for (const topic of ['signaltrail.analytics.v1', 'signaltrail.analytics.dlq.v1']) {
    stage = `topic ${topic}`;
    execFileSync(
      'docker',
      [
        'compose',
        'run',
        '--rm',
        '--no-deps',
        '-e',
        `SIGNALTRAIL_REDPANDA_TOPIC=${topic}`,
        'redpanda-init',
      ],
      { cwd: root, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }
  stage = 'service startup';
  const suffix = state.readerName.slice('st_dashboard_'.length);
  const base = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG']
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  start('apps/ingestion/dist/main.js', [], {
    ...base,
    NODE_ENV: 'production',
    PORT: '4102',
    SIGNALTRAIL_METRICS_PORT: '9467',
    SIGNALTRAIL_REDPANDA_BROKERS: '127.0.0.1:19092',
    SIGNALTRAIL_REDPANDA_TOPIC: 'signaltrail.analytics.v1',
    SIGNALTRAIL_ALLOWED_ORIGINS: 'http://localhost:3001,http://127.0.0.1:3001',
    SIGNALTRAIL_INGESTION_DATABASE_URL: `postgres://st_ingestion_${suffix}:${state.ingestionPassword}@127.0.0.1:5433/signaltrail`,
    SIGNALTRAIL_INGESTION_DATABASE_TLS: 'false',
  });
  start('workers/event-processor/dist/main.js', [], {
    ...base,
    NODE_ENV: 'development',
    SIGNALTRAIL_REDPANDA_BROKERS: '127.0.0.1:19092',
    SIGNALTRAIL_REDPANDA_TOPIC: 'signaltrail.analytics.v1',
    SIGNALTRAIL_REDPANDA_DLQ_TOPIC: 'signaltrail.analytics.dlq.v1',
    SIGNALTRAIL_PROCESSOR_GROUP_ID: 'signaltrail-local-demo-' + suffix,
    SIGNALTRAIL_CLICKHOUSE_URL: 'http://127.0.0.1:8123',
    SIGNALTRAIL_CLICKHOUSE_USERNAME: 'st_processor_' + suffix,
    SIGNALTRAIL_CLICKHOUSE_PASSWORD: state.processorPassword,
  });
  start(
    'node_modules/next/dist/bin/next',
    ['dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3001'],
    {
      ...base,
      NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SIGNALTRAIL_PROJECT_KEY: state.publicKey,
      NEXT_PUBLIC_SIGNALTRAIL_INGESTION_URL: 'http://localhost:4102/v1/events',
    },
    join(root, 'apps/demo-store'),
  );
  console.log(
    'Local demo pipeline starting at http://localhost:3001. Ctrl+C stops only these owned processes.',
  );
} catch {
  console.error(
    `Local pipeline startup failed during ${stage}. Existing services were not stopped. No credentials printed.`,
  );
  stop(1);
}
