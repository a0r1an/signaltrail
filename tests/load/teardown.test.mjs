import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teardownIsolatedRun } from './teardown.mjs';

test('does not release the run lock when Docker reports success but containers remain', async () => {
  let released = false;
  await assert.rejects(
    teardownIsolatedRun({
      remove: async () => {},
      remaining: async () => ['leftover-profile-container'],
      release: async () => {
        released = true;
      },
    }),
    /remain/,
  );
  assert.equal(released, false);
});

test('releases the lock only after removal and an empty container inventory', async () => {
  const steps = [];
  await teardownIsolatedRun({
    remove: async () => {
      steps.push('remove');
    },
    remaining: async () => {
      steps.push('inventory');
      return [];
    },
    release: async () => {
      steps.push('release');
    },
  });
  assert.deepEqual(steps, ['remove', 'inventory', 'release']);
});
