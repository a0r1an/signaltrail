import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRunLock } from './run-lock.mjs';

test('rejects concurrent load runs before either can change shared infrastructure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signaltrail-run-lock-'));
  let release;
  try {
    const path = join(directory, 'load.lock');
    release = await acquireRunLock(path);
    await assert.rejects(acquireRunLock(path), /already running/);
  } finally {
    await release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test('has only one winner when two runs acquire the lock concurrently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signaltrail-run-lock-'));
  const path = join(directory, 'load.lock');
  const results = await Promise.allSettled([acquireRunLock(path), acquireRunLock(path)]);
  try {
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  } finally {
    for (const result of results) if (result.status === 'fulfilled') await result.value();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an old release cannot remove a newer run lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signaltrail-run-lock-'));
  const path = join(directory, 'load.lock');
  let releaseSecond;
  try {
    const releaseFirst = await acquireRunLock(path);
    await releaseFirst();
    releaseSecond = await acquireRunLock(path);
    await releaseFirst();
    await assert.rejects(acquireRunLock(path), /already running/);
  } finally {
    await releaseSecond?.();
    await rm(directory, { recursive: true, force: true });
  }
});
