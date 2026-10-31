import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureSourceLag, verifyPipelineTotals } from './pipeline-measurements.mjs';

test('measures exact source lag including partitions with no committed offset', () => {
  const lag = measureSourceLag(
    [
      { partition: 0, low: '0', offset: '9007199254740997' },
      { partition: 1, low: '0', offset: '12' },
    ],
    [
      { partition: 0, offset: '9007199254740993' },
      { partition: 1, offset: '-1' },
    ],
  );
  assert.equal(lag.total, '16');
  assert.deepEqual(
    lag.partitions.map(({ lag }) => lag),
    ['4', '12'],
  );
});

test('flags source retention gaps rather than reporting a drained consumer', () => {
  const lag = measureSourceLag(
    [{ partition: 0, low: '50', offset: '70' }],
    [{ partition: 0, offset: '40' }],
  );
  assert.equal(lag.partitions[0].retentionGap, true);
  assert.equal(lag.partitions[0].lag, '20');
});

test('rejects incomplete or inconsistent broker snapshots instead of fabricating zero lag', () => {
  for (const high of [
    [],
    [
      { partition: 0, low: '0', offset: '10' },
      { partition: 0, low: '0', offset: '10' },
    ],
    [{ partition: 0, low: '0', offset: '3' }],
  ]) {
    assert.throws(() => measureSourceLag(high, [{ partition: 0, offset: '4' }]));
  }
});

test('requires accepted events, drained source offsets, unique stored rows and no dead letters', async () => {
  const { verifyPipelineTotals } = await import('./pipeline-measurements.mjs');
  const valid = {
    accepted: 10,
    retried: 0,
    rejected: 0,
    brokerRecords: '11',
    uniqueRows: 10,
    sourceLag: '0',
    deadLetters: '0',
    droppedIterations: 0,
    malformedResponses: 0,
  };
  assert.doesNotThrow(() => verifyPipelineTotals(valid));
  for (const wrong of [
    { accepted: 0 },
    { retried: 1 },
    { uniqueRows: 9 },
    { sourceLag: '1' },
    { deadLetters: '1' },
    { brokerRecords: '9' },
  ])
    assert.throws(() => verifyPipelineTotals({ ...valid, ...wrong }));
});

test('does not call a run successful when the generator drops requests or receives malformed responses', () => {
  const valid = {
    accepted: 10,
    retried: 0,
    rejected: 0,
    brokerRecords: '10',
    uniqueRows: 10,
    sourceLag: '0',
    deadLetters: '0',
    droppedIterations: 0,
    malformedResponses: 0,
  };
  assert.doesNotThrow(() => verifyPipelineTotals(valid));
  for (const wrong of [{ droppedIterations: 1 }, { malformedResponses: 1 }])
    assert.throws(() => verifyPipelineTotals({ ...valid, ...wrong }));
});

test('distinguishes an unsustained offered load from missing accepted data', () => {
  const totals = {
    accepted: 10,
    retried: 1,
    rejected: 0,
    brokerRecords: '10',
    uniqueRows: 10,
    sourceLag: '0',
    deadLetters: '0',
    droppedIterations: 1,
    malformedResponses: 0,
  };
  assert.throws(() => verifyPipelineTotals(totals), /Offered load target/);
  assert.throws(
    () => verifyPipelineTotals({ ...totals, uniqueRows: 9 }),
    /storage\/offset reconciliation/,
  );
});
