import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupResources } from './cleanup.mjs';

test('attempts remaining cleanup after a failed artifact write', async () => {
  const completed = [];
  await assert.rejects(
    cleanupResources([
      {
        name: 'save samples',
        run: async () => {
          throw new Error('disk full');
        },
      },
      {
        name: 'disconnect publisher',
        run: async () => {
          completed.push('publisher');
        },
      },
      {
        name: 'remove isolated infrastructure',
        run: async () => {
          completed.push('docker');
        },
      },
    ]),
  );
  assert.deepEqual(completed, ['publisher', 'docker']);
});

test('bounds a hung cleanup step and continues removing resources', async () => {
  let removed = false;
  await assert.rejects(
    cleanupResources([
      { name: 'hung publisher', timeoutMs: 10, run: async () => new Promise(() => {}) },
      {
        name: 'remove isolated infrastructure',
        run: async () => {
          removed = true;
        },
      },
    ]),
    /hung publisher/,
  );
  assert.equal(removed, true);
});

test('aborts timed-out work and retains errors from every failing action', async () => {
  let signal;
  try {
    await cleanupResources([
      {
        name: 'timeout',
        timeoutMs: 5,
        run: async (value) => {
          signal = value;
          await new Promise(() => {});
        },
      },
      {
        name: 'second failure',
        run: async () => {
          throw new Error('second');
        },
      },
    ]);
    assert.fail('Expected cleanup failures');
  } catch (error) {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(signal.aborted, true);
    assert.match(error.errors[0].cause.message, /Timed out/);
    assert.equal(error.errors[1].cause.message, 'second');
  }
});
