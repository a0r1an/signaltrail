import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMetadataStatus } from '../../scripts/metadata-status.mjs';
test('reports an empty database without querying a missing ledger', async () => {
  let calls = 0;
  const status = await readMetadataStatus(async () => {
    calls++;
    return JSON.stringify({ ledgerPresent: false, projectsPresent: false, keysPresent: false });
  }, [{ sha256: 'a' }]);
  assert.equal(calls, 1);
  assert.equal(status.ready, false);
  assert.deepEqual(status.appliedVersions, []);
});
test('requires exact registered checksums and complete schema for readiness', async () => {
  for (const [applied, ready] of [
    [[{ version: 1, checksum: 'a' }], true],
    [[{ version: 1, checksum: 'changed' }], false],
    [[{ version: 2, checksum: 'a' }], false],
    [[], false],
  ]) {
    let calls = 0;
    const result = await readMetadataStatus(
      async () =>
        JSON.stringify(
          calls++ === 0
            ? { ledgerPresent: true, projectsPresent: true, keysPresent: true }
            : applied,
        ),
      [{ sha256: 'a' }],
    );
    assert.equal(result.ready, ready);
  }
});
