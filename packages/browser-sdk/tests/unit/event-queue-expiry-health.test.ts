import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, expect, it, vi } from 'vitest';
import { openEventQueue } from '../../src/event-queue.ts';

const capturedAt = Date.parse('2026-10-30T12:00:00.000Z');
const event = {
  schemaVersion: 1 as const,
  eventId: 'expiry-health-event',
  eventName: 'view',
  distinctId: 'visitor',
  sessionId: 'session',
  clientTimestamp: new Date(capturedAt).toISOString(),
  sequence: 0,
  url: 'https://example.com',
  properties: {},
  context: { sdkVersion: '0.1.0' },
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of await indexedDB.databases())
    if (database.name) await deleteDB(database.name);
});

it('counts queued events removed by expiry once after a committed persistent prune', async () => {
  let now = capturedAt;
  const queue = await openEventQueue(
    { projectKey: 'expiry-health', ingestionUrl: 'https://ingest.example.com' },
    { now: () => now, maxAgeMs: 1000 },
  );
  try {
    await queue.enqueue(event);
    now += 1000;
    expect(await queue.getAll()).toEqual({ status: 'read', events: [] });
    expect(queue.expiredEvents).toBe(1);
    await queue.getAll();
    expect(queue.expiredEvents).toBe(1);
  } finally {
    queue.close();
  }
});

it('includes pruned queued events in transport health without counting repeated reads', async () => {
  const { openBatchTransport } = await import('../../src/batch-transport.ts');
  let now = capturedAt;
  const transport = await openBatchTransport(
    { projectKey: 'expiry-transport', ingestionUrl: 'https://ingest.example.com' },
    { queue: { now: () => now, maxAgeMs: 1000 } },
  );
  try {
    await transport.queue.enqueue(event);
    now += 1000;
    await transport.queue.inspectDelivery();
    expect((await transport.getHealth()).counters.droppedExpired).toBe(1);
    expect((await transport.getHealth()).counters.droppedExpired).toBe(1);
  } finally {
    transport.close();
  }
});

it('counts committed removals once across concurrent connections', async () => {
  let now = capturedAt;
  const config = { projectKey: 'expiry-tabs', ingestionUrl: 'https://ingest.example.com' };
  const options = { now: () => now, maxAgeMs: 1000 };
  const first = await openEventQueue(config, options);
  const second = await openEventQueue(config, options);
  try {
    await first.enqueue(event);
    now += 1000;
    await Promise.all([first.getAll(), second.claimBatch()]);
    expect(first.expiredEvents + second.expiredEvents).toBe(1);
  } finally {
    first.close();
    second.close();
  }
});

it('does not count removals rolled back by an aborted IndexedDB transaction', async () => {
  let now = capturedAt;
  const config = { projectKey: 'expiry-abort', ingestionUrl: 'https://ingest.example.com' };
  const queue = await openEventQueue(config, { now: () => now, maxAgeMs: 1000 });
  let reopened;
  try {
    await queue.enqueue(event);
    now += 1000;
    // Fail after event deletion has been requested, before the transaction commits.
    const original = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
      this: IDBObjectStore,
      key,
    ) {
      if (this.name === 'claims') throw new DOMException('Storage lost', 'UnknownError');
      return original.call(this, key);
    });
    expect(await queue.getAll()).toEqual({ status: 'storage_error' });
    expect(queue.expiredEvents).toBe(0);
    vi.restoreAllMocks();
    reopened = await openEventQueue(config, { now: () => capturedAt, maxAgeMs: 1000 });
    expect(await reopened.getAll()).toEqual({ status: 'read', events: [event] });
  } finally {
    vi.restoreAllMocks();
    queue.close();
    reopened?.close();
  }
});

it('counts memory expiry and preserves earlier counts when persistent storage degrades', async () => {
  let now = capturedAt;
  const queue = await openEventQueue(
    { projectKey: 'expiry-degrade', ingestionUrl: 'https://ingest.example.com' },
    { now: () => now, maxAgeMs: 1000 },
  );
  try {
    await queue.enqueue(event);
    now += 1000;
    await queue.getAll();
    const failure = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new DOMException('Disk failed', 'UnknownError');
    });
    await queue.enqueue({
      ...event,
      eventId: 'in-memory',
      clientTimestamp: new Date(now).toISOString(),
    });
    failure.mockRestore();
    expect(queue.storageMode).toBe('memory');
    expect(queue.expiredEvents).toBe(1);
    now += 1000;
    await queue.inspectDelivery();
    expect(queue.expiredEvents).toBe(2);
  } finally {
    queue.close();
  }
});

it('keeps expiry observed during a health read for the next reporting interval', async () => {
  const { createSdkHealth } = await import('../../src/sdk-health.ts');
  let now = capturedAt;
  const queue = await openEventQueue(
    { projectKey: 'expiry-interval', ingestionUrl: 'https://ingest.example.com' },
    { now: () => now, maxAgeMs: 1000 },
  );
  const health = createSdkHealth(queue, () => now);
  try {
    await queue.enqueue(event);
    now += 1000;
    expect((await health.take()).counters.droppedExpired).toBeUndefined();
    expect((await health.take()).counters.droppedExpired).toBe(1);
    expect((await health.take()).counters.droppedExpired).toBeUndefined();
  } finally {
    queue.close();
  }
});
