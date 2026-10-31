import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runStorageInterruption } from './storage-interruption.mjs';

test('resumes owned storage when interruption waiting fails after the pause', async () => {
  const calls = [];
  let waits = 0;
  await assert.rejects(
    runStorageInterruption({
      pause: async () => {
        calls.push('pause');
      },
      resume: async () => {
        calls.push('resume');
      },
      wait: async () => {
        if (++waits === 2) throw new Error('interrupted');
      },
    }),
    /interrupted/,
  );
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('cancels before the pause without touching storage', async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  await runStorageInterruption({
    signal: controller.signal,
    wait: async () => {},
    pause: async () => {
      calls.push('pause');
    },
    resume: async () => {
      calls.push('resume');
    },
  });
  assert.deepEqual(calls, []);
});

test('resumes storage before completing cancellation during the paused window', async () => {
  const controller = new AbortController();
  const calls = [];
  await runStorageInterruption({
    signal: controller.signal,
    wait: async () => {
      controller.signal.throwIfAborted();
    },
    pause: async () => {
      calls.push('pause');
      controller.abort();
    },
    resume: async () => {
      calls.push('resume');
    },
  });
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('retains both pause and resume failures for cleanup diagnostics', async () => {
  const failedPause = new Error('pause uncertain');
  const failedResume = new Error('resume failed');
  await assert.rejects(
    runStorageInterruption({
      wait: async () => {},
      pause: async () => {
        throw failedPause;
      },
      resume: async () => {
        throw failedResume;
      },
    }),
    (error) => {
      assert.deepEqual(error.errors, [failedPause, failedResume]);
      return true;
    },
  );
});
