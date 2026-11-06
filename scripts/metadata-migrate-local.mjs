import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readControlPlanePlan } from './control-plane-plan.mjs';
try {
  if (process.argv.length !== 2) throw new Error();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { statement, migrations } = await readControlPlanePlan(root);
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '--no-psqlrc',
      '-U',
      'signaltrail',
      '-d',
      'signaltrail',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '-',
    ],
    {
      cwd: root,
      input: statement,
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  console.log(
    JSON.stringify({
      target: 'local-compose',
      appliedVersions: migrations.map((m) => m.version),
      completed: true,
    }),
  );
} catch {
  console.error(
    'Local metadata migration was not confirmed. Inspect metadata status before retrying.',
  );
  process.exitCode = 1;
}
