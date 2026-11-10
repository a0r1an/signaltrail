import assert from 'node:assert/strict';
import { test } from 'node:test';
import { persistIntervalBatch } from './interval-history.mjs';

test('streams each interval once and rejects gaps before appending misleading evidence', async () => {
  const writes = [];
  const append = async (body) => writes.push(body);
  const cursor = await persistIntervalBatch({
    cursor: 0,
    payload: { totalRecords: 2, missingBefore: 0, records: [{ sequence: 1 }, { sequence: 2 }] },
    append,
  });
  assert.equal(cursor, 2);
  assert.equal(writes[0], '{"sequence":1}\n{"sequence":2}\n');
  assert.equal(
    await persistIntervalBatch({
      cursor,
      payload: { totalRecords: 2, missingBefore: 0, records: [] },
      append,
    }),
    2,
  );
  assert.equal(writes.length, 1);
  await assert.rejects(
    persistIntervalBatch({
      cursor,
      payload: { totalRecords: 5, missingBefore: 1, records: [{ sequence: 4 }, { sequence: 5 }] },
      append,
    }),
  );
  assert.equal(writes.length, 1);
});
