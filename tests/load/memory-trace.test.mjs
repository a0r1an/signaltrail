import assert from 'node:assert/strict';
import test from 'node:test';
import { captureMemoryTrace } from './memory-trace.mjs';

test('persists partial memory evidence and errors when one category is unavailable', async () => {
  const records = [];
  const calls = [];
  await captureMemoryTrace({
    request: async (sql) => {
      calls.push(sql);
      if (sql.includes('system.merges')) throw new Error('memory rejected');
      return '{"metric":"jemalloc.allocated","value":123}\n';
    },
    append: async (record) => records.push(record),
  });
  assert.equal(calls.length, 3);
  assert.equal(records.length, 1);
  assert.equal(records[0].observations.length, 2);
  assert.equal(records[0].errors.length, 1);
  assert.match(records[0].errors[0].message, /memory rejected/);
  assert.ok(records[0].startedAt && records[0].finishedAt);
});
