import assert from 'node:assert/strict';
import test from 'node:test';
import { observeUntil } from './observation-loop.mjs';

test('reports an analytical rejection before retrying and preserves later successful observations', async () => {
  const events = [];
  let attempts = 0;
  await observeUntil({
    done: () => attempts === 3,
    observe: async () => {
      attempts++;
      events.push(`attempt ${attempts}`);
      if (attempts === 1) throw new Error('MEMORY_LIMIT_EXCEEDED');
    },
    onError: async (error) => events.push(error.message),
    wait: async () => events.push('wait'),
  });
  assert.deepEqual(events, [
    'attempt 1',
    'MEMORY_LIMIT_EXCEEDED',
    'wait',
    'attempt 2',
    'wait',
    'attempt 3',
  ]);
});

test('a pending analytical request does not block the independent interval collector', async () => {
  let releaseQuery;
  let collected = 0;
  let queryDone = false;
  const blocked = new Promise((resolve) => {
    releaseQuery = resolve;
  });
  const query = observeUntil({
    done: () => queryDone,
    observe: async () => {
      await blocked;
      queryDone = true;
    },
    onError: assert.fail,
  });
  await observeUntil({
    done: () => collected === 3,
    observe: async () => {
      collected++;
    },
    onError: assert.fail,
    wait: async () => {},
  });
  assert.equal(queryDone, false);
  releaseQuery();
  await query;
});

test('artifact persistence failures surface instead of silently losing the error', async () => {
  await assert.rejects(
    observeUntil({
      done: () => false,
      observe: async () => {
        throw new Error('query failed');
      },
      onError: async () => {
        throw new Error('disk full');
      },
    }),
    /disk full/,
  );
});
