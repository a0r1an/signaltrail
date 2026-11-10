#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `SignalTrail operations (run from the repository root)
  ./scripts/signaltrail-ops.mjs check contracts|ingestion|sdk|processor|analytics|access|dashboard
  ./scripts/signaltrail-ops.mjs dashboard browser|auth-smoke
  ./scripts/signaltrail-ops.mjs api generate|check|browser
  ./scripts/signaltrail-ops.mjs browser test|install|size|benchmark
  ./scripts/signaltrail-ops.mjs broker test|status|metrics
  ./scripts/signaltrail-ops.mjs load check|baseline|burst|saturation|bytes|recovery|pipeline|browser-pipeline|sustained-smoke|sustained|sustained-stress|sustained-outage|sustained-bytes|request-admission|analytics-read|storage-readiness|project-access|authorized-analytics|storage-image|storage-logs
  ./scripts/signaltrail-ops.mjs load part-memory
  ./scripts/signaltrail-ops.mjs load memory-4gb|memory-2gb|capacity-4gb|capacity-4gb-boundary|capacity-4gb-confirm|capacity-4gb-http32|capacity-4gb-http128|capacity-4gb-db8|capacity-4gb-db4-long|capacity-4gb-db8-long|capacity-4gb-db8-q24|capacity-4gb-db8-q24-noqueries|capacity-4gb-db8-q24-generator|capacity-4gb-db8-q24-rebalanced|capacity-4gb-telemetry|capacity-4gb-memory-trace|capacity-4gb-memory-trace-heap|capacity-4gb-memory-trace-heap-batched|capacity-4gb-memory-trace-heap-batched-smoke|capacity-4gb-memory-trace-heap-smoke|capacity-4gb-memory-trace-smoke|capacity-4gb-telemetry-failure|capacity-4gb-query-memory|capacity-4gb-query-memory-no-text-log|capacity-4gb-db8-q24-endurance
  ./scripts/signaltrail-ops.mjs monitoring validate|up|down|status|logs|delivery
  ./scripts/signaltrail-ops.mjs compose validate
  ./scripts/signaltrail-ops.mjs metadata status|migrate-local|configure-local|plan|bootstrap-plan
  ./scripts/signaltrail-ops.mjs pipeline start-local|probe-local|status-local
  ./scripts/signaltrail-ops.mjs install
  ./scripts/signaltrail-ops.mjs --dry-run <operation>

No arbitrary commands or extra arguments are accepted. Dry-run performs no operations.
Monitoring reads the ignored .env.monitoring and Docker-mounted token file.
Load tests clean up only their isolated signaltrail-load Compose project.
`;
let args = process.argv.slice(2);
if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.log(help);
  process.exit(0);
}
const dryRun = args[0] === '--dry-run';
if (dryRun) args = args.slice(1);
const [group, action] = args;
const tasks = [];
const pnpm = (...arguments_) => tasks.push({ command: 'pnpm', args: arguments_ });
const docker = (...arguments_) => tasks.push({ command: 'docker', args: arguments_ });
const monitoring = [
  'compose',
  '--env-file',
  '.env.monitoring',
  '-f',
  'infra/monitoring/compose.yaml',
];
const packages = {
  contracts: '@signaltrail/contracts',
  ingestion: '@signaltrail/ingestion',
  sdk: '@signaltrail/browser-sdk',
  processor: '@signaltrail/event-processor',
  analytics: '@signaltrail/analytics',
  access: '@signaltrail/project-access',
  dashboard: '@signaltrail/dashboard',
  demo: '@signaltrail/demo-store',
};
function invalid() {
  throw new Error(`Unknown operation.\n${help}`);
}
try {
  if (args.length !== (group === 'install' ? 1 : 2)) invalid();
  if (group === 'check' && Object.hasOwn(packages, action)) {
    // Browser typechecks import ingestion declarations; build dependencies first.
    if (!['contracts', 'analytics', 'access', 'dashboard'].includes(action))
      pnpm('--filter', '@signaltrail/contracts', 'build');
    if (action === 'dashboard') {
      pnpm('--filter', '@signaltrail/analytics', 'build');
      pnpm('--filter', '@signaltrail/project-access', 'build');
    }
    if (['sdk', 'ingestion'].includes(action))
      pnpm('--filter', '@signaltrail/project-access', 'build');
    if (action === 'sdk') pnpm('--filter', '@signaltrail/ingestion', 'build');
    if (action === 'demo') pnpm('--filter', '@signaltrail/browser-sdk', 'build');
    for (const script of ['lint', 'test', 'typecheck', 'build'])
      if (action !== 'demo' || script !== 'test') pnpm('--filter', packages[action], script);
  } else if (group === 'dashboard' && action === 'auth-smoke') {
    pnpm('--filter', '@signaltrail/analytics', 'build');
    pnpm('--filter', '@signaltrail/project-access', 'build');
    pnpm('--filter', '@signaltrail/dashboard', 'build');
    tasks.push({ command: 'node', args: ['tests/browser/dashboard-auth.mjs'] });
  } else if (group === 'dashboard' && action === 'browser') {
    pnpm('--filter', '@signaltrail/analytics', 'build');
    pnpm('--filter', '@signaltrail/dashboard', 'harness:build');
    tasks.push({ command: 'node', args: ['tests/browser/event-explorer.mjs'] });
  } else if (group === 'api' && action === 'browser') {
    pnpm('--filter', '@signaltrail/analytics', 'build');
    tasks.push({ command: 'node', args: ['tests/browser/query-client.mjs'] });
  } else if (group === 'api' && ['generate', 'check'].includes(action))
    pnpm('--filter', '@signaltrail/analytics', `api:${action}`);
  else if (group === 'browser' && action === 'test')
    pnpm('--filter', '@signaltrail/browser-sdk', 'test:browser');
  else if (group === 'browser' && action === 'benchmark') {
    pnpm('--filter', '@signaltrail/contracts', 'build');
    pnpm('--filter', '@signaltrail/browser-sdk', 'build');
    pnpm(
      '--filter',
      '@signaltrail/browser-sdk',
      'exec',
      'tsup',
      '--config',
      'tests/browser/harness/bundle.config.ts',
    );
    tasks.push({ command: 'node', args: ['tests/benchmarks/browser-queue.mjs'] });
  } else if (group === 'browser' && action === 'size') {
    pnpm('--filter', '@signaltrail/contracts', 'build');
    pnpm('--filter', '@signaltrail/browser-sdk', 'build');
    tasks.push({ command: 'node', args: ['tests/benchmarks/browser-sdk-size.mjs'] });
  } else if (group === 'browser' && action === 'install')
    pnpm('--filter', '@signaltrail/browser-sdk', 'exec', 'playwright', 'install', 'chromium');
  else if (group === 'broker' && action === 'test')
    pnpm('--filter', '@signaltrail/ingestion', 'test:integration');
  else if (group === 'broker' && action === 'status') docker('compose', 'ps', 'redpanda');
  else if (group === 'broker' && action === 'metrics')
    docker(
      'compose',
      'exec',
      '-T',
      'redpanda',
      'curl',
      '-fsS',
      'http://127.0.0.1:9644/public_metrics',
    );
  else if (group === 'load' && action === 'part-memory')
    tasks.push({ command: 'node', args: ['tests/load/inspect-part-memory.mjs'] });
  else if (
    group === 'load' &&
    [
      'memory-4gb',
      'memory-2gb',
      'capacity-4gb',
      'capacity-4gb-boundary',
      'capacity-4gb-confirm',
      'capacity-4gb-http32',
      'capacity-4gb-http128',
      'capacity-4gb-db8',
      'capacity-4gb-db4-long',
      'capacity-4gb-db8-long',
      'capacity-4gb-db8-q24',
      'capacity-4gb-db8-q24-noqueries',
      'capacity-4gb-db8-q24-generator',
      'capacity-4gb-db8-q24-rebalanced',
      'capacity-4gb-telemetry',
      'capacity-4gb-memory-trace',
      'capacity-4gb-memory-trace-heap',
      'capacity-4gb-memory-trace-heap-batched',
      'capacity-4gb-memory-trace-heap-batched-smoke',
      'capacity-4gb-memory-trace-heap-smoke',
      'capacity-4gb-memory-trace-smoke',
      'capacity-4gb-telemetry-failure',
      'capacity-4gb-query-memory',
      'capacity-4gb-query-memory-no-text-log',
      'capacity-4gb-db8-q24-endurance',
    ].includes(action)
  ) {
    for (const name of ['contracts', 'project-access', 'ingestion', 'event-processor'])
      pnpm('--filter', `@signaltrail/${name}`, 'build');
    tasks.push({ command: 'node', args: ['tests/load/memory-run.mjs', action] });
  } else if (group === 'load' && action === 'check') pnpm('test:load:unit');
  else if (group === 'load' && action === 'storage-image')
    docker(
      'run',
      '--rm',
      '--pull',
      'never',
      '--entrypoint',
      'cat',
      'clickhouse/clickhouse-server:26.8',
      '/entrypoint.sh',
    );
  else if (group === 'load' && action === 'storage-logs')
    docker(
      'compose',
      '-f',
      'tests/load/compose.yaml',
      'logs',
      '--no-color',
      '--tail',
      '200',
      'clickhouse',
    );
  else if (
    group === 'load' &&
    [
      'baseline',
      'burst',
      'saturation',
      'bytes',
      'recovery',
      'pipeline',
      'browser-pipeline',
      'sustained-smoke',
      'sustained',
      'sustained-stress',
      'sustained-outage',
      'sustained-bytes',
      'request-admission',
      'analytics-read',
      'storage-readiness',
      'project-access',
      'authorized-analytics',
    ].includes(action)
  )
    pnpm('test:load', action);
  else if (group === 'compose' && action === 'validate') {
    docker('compose', 'config', '--quiet');
    docker('compose', '-f', 'tests/load/compose.yaml', 'config', '--quiet');
  } else if (group === 'monitoring') {
    if (action === 'validate') {
      docker(...monitoring, 'config', '--quiet');
      docker(
        ...monitoring,
        'run',
        '--rm',
        '--no-deps',
        'alloy',
        'validate',
        '/etc/alloy/config.alloy',
      );
    } else if (action === 'up') docker(...monitoring, 'up', '-d');
    else if (action === 'down') docker(...monitoring, 'down');
    else if (action === 'status') docker(...monitoring, 'ps');
    else if (action === 'logs')
      docker(...monitoring, 'logs', '--tail', '30', '--no-color', 'alloy');
    else if (action === 'delivery') tasks.push({ url: 'http://127.0.0.1:12345/metrics' });
    else invalid();
  } else if (group === 'metadata' && action === 'status') {
    pnpm('--filter', '@signaltrail/project-access', 'build');
    tasks.push({ command: 'node', args: ['scripts/metadata-status.mjs'] });
  } else if (group === 'metadata' && action === 'migrate-local') {
    pnpm('--filter', '@signaltrail/project-access', 'build');
    tasks.push({ command: 'node', args: ['scripts/metadata-migrate-local.mjs'] });
  } else if (group === 'metadata' && action === 'configure-local') {
    pnpm('--filter', '@signaltrail/project-access', 'build');
    pnpm('--filter', '@signaltrail/analytics', 'build');
    tasks.push({ command: 'node', args: ['scripts/metadata-configure-local.mjs'] });
  } else if (group === 'metadata' && action === 'plan') {
    pnpm('--filter', '@signaltrail/project-access', 'build');
    tasks.push({ command: 'node', args: ['scripts/control-plane-plan.mjs'] });
  } else if (group === 'metadata' && action === 'bootstrap-plan') {
    pnpm('--filter', '@signaltrail/project-access', 'build');
    tasks.push({ command: 'node', args: ['scripts/bootstrap-project-plan.mjs'] });
  } else if (group === 'pipeline' && action === 'start-local') {
    for (const pkg of [
      'contracts',
      'project-access',
      'browser-sdk',
      'ingestion',
      'event-processor',
    ])
      pnpm('--filter', `@signaltrail/${pkg}`, 'build');
    tasks.push({ command: 'node', args: ['scripts/pipeline-start-local.mjs'] });
  } else if (group === 'pipeline' && action === 'probe-local') {
    tasks.push({ command: 'node', args: ['scripts/pipeline-probe-local.mjs'] });
  } else if (group === 'pipeline' && action === 'status-local') {
    tasks.push({ command: 'node', args: ['scripts/pipeline-status-local.mjs'] });
  } else if (group === 'install') pnpm('install', '--frozen-lockfile');
  else invalid();
  if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== 'signaltrail')
    throw new Error('This runner belongs in the SignalTrail repository');
  if (dryRun) {
    console.log(JSON.stringify({ cwd: root, tasks }, null, 2));
    process.exit(0);
  }
  // Do not install or change Node globally. Prefer an existing Node 24 installation.
  let nodeDirectory;
  if (process.versions.node.split('.')[0] === '24') nodeDirectory = dirname(process.execPath);
  else {
    const versions = join(homedir(), '.nvm', 'versions', 'node');
    const candidates = existsSync(versions)
      ? readdirSync(versions)
          .filter((version) => /^v24\.\d+\.\d+$/.test(version))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      : [];
    nodeDirectory = candidates
      .map((version) => join(versions, version, 'bin'))
      .find((directory) => existsSync(join(directory, 'node')));
  }
  if (!nodeDirectory) throw new Error('Node 24 is required; activate it before running operations');
  const environment = { ...process.env, PATH: `${nodeDirectory}:${process.env.PATH ?? ''}` };
  for (const task of tasks) {
    if (task.url) {
      const response = await fetch(task.url, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Collector metrics returned HTTP ${response.status}`);
      const body = await response.text();
      const lines = body
        .split('\n')
        .filter((line) =>
          /^(prometheus_forwarded_samples_total|prometheus_remote_storage_samples_(total|failed_total|retried_total|pending))\{/.test(
            line,
          ),
        );
      if (!lines.length) throw new Error('Collector exposed no expected delivery counters');
      console.log(lines.join('\n'));
      continue;
    }
    console.log(`Running: ${task.command} ${task.args.join(' ')}`);
    await new Promise((done, reject) => {
      const child = spawn(task.command, task.args, {
        cwd: root,
        env: environment,
        stdio: 'inherit',
        shell: false,
      });
      const interrupt = () => child.kill('SIGINT');
      const terminate = () => child.kill('SIGTERM');
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', terminate);
      const cleanup = () => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
      };
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('exit', (code, signal) => {
        cleanup();
        if (code === 0) done();
        else reject(new Error(`${task.command} exited ${signal ?? code}`));
      });
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
