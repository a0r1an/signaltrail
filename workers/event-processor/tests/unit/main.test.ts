import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('fails configuration startup without echoing unrelated environment secrets', () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(new URL('../../src/main.ts', import.meta.url))],
    {
      env: { PRIVATE_TEST_SECRET: 'do-not-print-this-secret' },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Missing SIGNALTRAIL_CLICKHOUSE_PASSWORD');
  expect(result.stdout + result.stderr).not.toContain('do-not-print-this-secret');
  expect(result.stdout).not.toContain('event processor started');
});
