import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupResources } from '../load/cleanup.mjs';
import { finishRun } from '../load/run-result.mjs';

const cwd = fileURLToPath(new URL('../../apps/dashboard/', import.meta.url));
const require = createRequire(new URL('../../apps/dashboard/package.json', import.meta.url));
const directory = fileURLToPath(
  new URL(
    `../../test-results/dashboard-auth/${new Date().toISOString().replaceAll(':', '-')}/`,
    import.meta.url,
  ),
);
await mkdir(directory, { recursive: true });
const result = { passed: false, node: process.version, cases: {} };
let runError,
  child,
  exited,
  settled = false,
  origin;
try {
  // Explicit blanks override .env files; this probe never uses a real Clerk account.
  child = spawn(
    process.execPath,
    [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '0'],
    {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
        CLERK_SECRET_KEY: '',
        SIGNALTRAIL_OWNER_CLERK_USER_ID: '',
        SIGNALTRAIL_CLERK_ISSUER: '',
        SIGNALTRAIL_DASHBOARD_ORIGIN: '',
      },
    },
  );
  let output = '';
  child.stdout.on('data', (data) => {
    output = (output + data.toString()).slice(-4096);
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match && Number(match[1]) > 0) origin = match[0];
  });
  exited = new Promise((resolve) => {
    child.once('error', () => {
      settled = true;
      resolve();
    });
    child.once('exit', () => {
      settled = true;
      resolve();
    });
  });
  const deadline = Date.now() + 15000;
  while (!origin && !settled && Date.now() < deadline) await delay(50);
  assert.ok(origin, 'Owned Next server did not publish an ephemeral listener');
  const get = (path, headers = {}) =>
    fetch(`${origin}${path}`, { redirect: 'manual', headers, signal: AbortSignal.timeout(5000) });
  for (const path of ['/', '/dashboard', '/api/session']) {
    const response = await get(path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'AUTH_UNAVAILABLE' });
  }
  result.cases.missingConfigurationDeniesProtectedResources = true;
  const forged = await get('/api/session', {
    Authorization: 'Bearer fixture-forged-token',
    Cookie: '__session=fixture-forged-token',
    'x-clerk-auth-status': 'signed-in',
    'x-clerk-auth-user-id': 'user_owner',
  });
  assert.equal(forged.status, 503);
  assert.deepEqual(await forged.json(), { error: 'AUTH_UNAVAILABLE' });
  result.cases.requestHeadersCannotEnableAuth = true;
  const signIn = await get('/sign-in');
  assert.equal(signIn.status, 200);
  const body = await signIn.text();
  assert.ok(body.includes('Sign-in unavailable'));
  assert.ok(!body.includes('Private dashboard access confirmed'));
  result.cases.signInShowsSetupState = true;
  result.passed = true;
} catch (error) {
  runError = error;
} finally {
  const completed = await finishRun({
    result,
    runError,
    cleanup: () =>
      cleanupResources([
        {
          name: 'stop owned Next server',
          timeoutMs: 8000,
          async run() {
            if (!child || settled) return;
            child.kill('SIGTERM');
            await Promise.race([exited, delay(3000)]);
            if (!settled) {
              child.kill('SIGKILL');
              await Promise.race([exited, delay(2000)]);
            }
            if (!settled) throw new Error('Owned Next server failed to exit');
          },
        },
      ]),
    writeResult: (value) =>
      writeFile(`${directory}report.json`, `${JSON.stringify(value, null, 2)}\n`),
  });
  console.log(JSON.stringify({ directory, ...completed }, null, 2));
}
