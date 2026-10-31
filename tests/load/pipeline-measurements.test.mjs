import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureSourceLag } from './pipeline-measurements.mjs';

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
