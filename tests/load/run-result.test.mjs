import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishRun } from './run-result.mjs';

test('records a cleanup failure as a failed run even when measurements passed', async () => {
  let saved;
  await assert.rejects(
    finishRun({
      result: { passed: true, final: { outstandingEvents: 0 } },
      cleanup: async () => {
        throw new Error('Docker teardown failed');
      },
      writeResult: async (value) => {
        saved = value;
      },
    }),
  );
  assert.equal(saved.passed, false);
  assert.match(saved.errors[0].message, /Docker teardown failed/);
});

test('preserves the original run error and nested teardown causes in the artifact', async () => {
  const original = new Error('Broker recovery failed');
  const nested = new AggregateError(
    [new Error('Cleanup action failed', { cause: new Error('disk full') })],
    'Cleanup failed',
  );
  let saved;
  await assert.rejects(
    finishRun({
      result: { passed: false },
      runError: original,
      cleanup: async () => {
        throw nested;
      },
      writeResult: async (value) => {
        saved = value;
      },
    }),
    (error) => {
      assert.deepEqual(error.errors, [original, nested]);
      return true;
    },
  );
  assert.equal(saved.passed, false);
  assert.equal(saved.errors[0].message, 'Broker recovery failed');
  assert.equal(saved.errors[1].errors[0].cause.message, 'disk full');
});

test('attempts cleanup before an artifact-write failure can interrupt finalization', async () => {
  const order = [];
  await assert.rejects(
    finishRun({
      result: { passed: true },
      cleanup: async () => {
        order.push('cleanup');
      },
      writeResult: async () => {
        order.push('write');
        throw new Error('disk full');
      },
    }),
  );
  assert.deepEqual(order, ['cleanup', 'write']);
});

test('records success only after cleanup and preserves measurements', async () => {
  let cleaned = false;
  const completed = await finishRun({
    result: { passed: true, final: { peakEvents: 2 } },
    cleanup: async () => {
      cleaned = true;
    },
    writeResult: async (value) => {
      assert.equal(cleaned, true);
      assert.equal(value.passed, true);
    },
  });
  assert.deepEqual(completed, { passed: true, final: { peakEvents: 2 }, errors: [] });
});
