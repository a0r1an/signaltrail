import assert from 'node:assert/strict';

export async function persistIntervalBatch({ cursor, payload, append }) {
  assert.ok(Number.isSafeInteger(cursor) && cursor >= 0);
  assert.ok(
    Number.isSafeInteger(payload.totalRecords) && payload.totalRecords >= cursor,
    'Interval counter reset',
  );
  assert.equal(payload.missingBefore, 0, 'Interval history was overwritten before collection');
  assert.ok(Array.isArray(payload.records) && payload.records.length <= 600);
  let next = cursor;
  for (const record of payload.records)
    assert.equal(record.sequence, ++next, 'Interval sequence gap');
  assert.equal(next, payload.totalRecords, 'Incomplete interval response');
  if (payload.records.length)
    await append(payload.records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return next;
}
