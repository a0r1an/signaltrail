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

test('interval history supports cursor reads and explicitly reports an overwritten gap', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const observer = startStallObserver({
    database: { query: async () => ({ rows: [] }) },
    snapshot: () => ({}),
    readResources: async () => ({}),
  });
  try {
    for (let i = 0; i < 602; i++) {
      t.mock.timers.tick(1000);
      await setImmediate();
    }
    const recent = observer.records(600);
    assert.equal(recent.totalRecords, 602);
    assert.deepEqual(
      recent.records.map((r) => r.sequence),
      [601, 602],
    );
    assert.equal(recent.missingBefore, 0);
    const old = observer.records(0);
    assert.equal(old.records.length, 600);
    assert.equal(old.missingBefore, 2);
  } finally {
    observer.stop();
  }
});
