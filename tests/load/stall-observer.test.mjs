import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { startStallObserver } from './stall-observer.mjs';

test('interval telemetry does not overlap a slow database observation and records unavailable evidence', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let resolveQuery,
    calls = 0;
  const database = {
    query: () => {
      calls++;
      return new Promise((resolve) => {
        resolveQuery = resolve;
      });
    },
  };
  const observer = startStallObserver({
    database,
    snapshot: () => ({ marker: 1 }),
    readResources: async () => ({ marker: 'fixture' }),
  });
  try {
    t.mock.timers.tick(1000);
    t.mock.timers.tick(5000);
    assert.equal(calls, 1);
    resolveQuery({ rows: [{ waits: [] }] });
    await setImmediate();
    const result = observer.records();
    assert.equal(result.totalRecords, 1);
    assert.deepEqual(result.records[0].resources, { marker: 'fixture' });
    assert.equal(result.records[0].postgres.available, true);
    database.query = async () => {
      throw new Error('fixture failure');
    };
    t.mock.timers.tick(1000);
    await setImmediate();
    assert.deepEqual(observer.records().records[1].postgres, { available: false });
  } finally {
    observer.stop();
  }
  const before = observer.records().totalRecords;
  t.mock.timers.tick(5000);
  await setImmediate();
  assert.equal(observer.records().totalRecords, before);
});
