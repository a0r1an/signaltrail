#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `SignalTrail operations (run from the repository root)
  ./scripts/signaltrail-ops.mjs check contracts|ingestion|sdk
  ./scripts/signaltrail-ops.mjs browser test|install
  ./scripts/signaltrail-ops.mjs broker test|status|metrics
  ./scripts/signaltrail-ops.mjs load baseline|burst|saturation|bytes
  ./scripts/signaltrail-ops.mjs monitoring validate|up|down|status|logs|delivery
  ./scripts/signaltrail-ops.mjs compose validate
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
};
function invalid() {
  throw new Error(`Unknown operation.\n${help}`);
}
try {
  if (args.length !== (group === 'install' ? 1 : 2)) invalid();
  if (group === 'check' && Object.hasOwn(packages, action)) {
    // Browser typechecks import ingestion declarations; build dependencies first.
    if (action !== 'contracts') pnpm('--filter', '@signaltrail/contracts', 'build');
    if (action === 'sdk') pnpm('--filter', '@signaltrail/ingestion', 'build');
    for (const script of ['lint', 'test', 'typecheck', 'build'])
      pnpm('--filter', packages[action], script);
  } else if (group === 'browser' && action === 'test')
    pnpm('--filter', '@signaltrail/browser-sdk', 'test:browser');
  else if (group === 'browser' && action === 'install')
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
  else if (group === 'load' && ['baseline', 'burst', 'saturation', 'bytes'].includes(action))
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
