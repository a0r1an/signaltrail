import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchDashboardServices } from '../../scripts/local-dashboard-env.mjs';
test('replaces service fields without changing auth and removes duplicate service assignments', () => {
  const values = Object.fromEntries(
    [
      'SIGNALTRAIL_CLICKHOUSE_READ_URL',
      'SIGNALTRAIL_CLICKHOUSE_READ_USER',
      'SIGNALTRAIL_CLICKHOUSE_READ_PASSWORD',
      'SIGNALTRAIL_MEMBERSHIP_DATABASE_URL',
      'SIGNALTRAIL_MEMBERSHIP_TLS',
    ].map((key) => [key, 'fixture']),
  );
  const source =
    'CLERK_SECRET_KEY=private-fixture\n# comment\nSIGNALTRAIL_MEMBERSHIP_TLS=true\nexport SIGNALTRAIL_MEMBERSHIP_TLS=false\n';
  const result = patchDashboardServices(source, values);
  assert.ok(result.startsWith('CLERK_SECRET_KEY=private-fixture\n# comment\n'));
  assert.equal(result.match(/SIGNALTRAIL_MEMBERSHIP_TLS=/g).length, 1);
  assert.equal(patchDashboardServices(result, values), result);
  assert.throws(() =>
    patchDashboardServices(source, { ...values, SIGNALTRAIL_MEMBERSHIP_TLS: 'false\nBYPASS=true' }),
  );
});
