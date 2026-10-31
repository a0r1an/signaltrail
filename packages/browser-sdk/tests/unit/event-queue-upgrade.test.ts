import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, expect, it, vi } from 'vitest';
import { openEventQueue } from '../../src/event-queue.ts';

async function promptly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Queue initialization remained blocked')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of await indexedDB.databases())
    if (database.name) await deleteDB(database.name);
});

it('falls back promptly when an older connection blocks the queue upgrade and closes any late connection', async () => {
  const legacy = await openDB('queue-blocked-upgrade', 2, {
    upgrade(database) {
      const events = database.createObjectStore('events', { autoIncrement: true });
      events.createIndex('byEventId', 'eventId', { unique: true });
      const claims = database.createObjectStore('claims', { keyPath: 'eventKey' });
      claims.createIndex('byClaimId', 'claimId');
    },
  });
  await legacy.add('events', { eventId: 'preserved-legacy-event' });
  const originalOpen = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, 'open').mockImplementation((_name, version) =>
    originalOpen('queue-blocked-upgrade', version),
  );
  const opening = openEventQueue({
    projectKey: 'upgrade-project',
    ingestionUrl: 'https://ingest.example.com',
  });
  try {
    const queue = await promptly(opening);
    expect(queue.storageMode).toBe('memory');
    expect(await legacy.getAll('events')).toEqual([{ eventId: 'preserved-legacy-event' }]);
    queue.close();
  } finally {
    legacy.close();
    (await opening).close();
    // A late successful open must be closed so this deletion can complete.
    await promptly(deleteDB('queue-blocked-upgrade'));
  }
});

it('releases an existing connection for a future upgrade and degrades subsequent operations without deleting durable events', async () => {
  const config = { projectKey: 'future-upgrade', ingestionUrl: 'https://ingest.example.com' };
  const queue = await openEventQueue(config);
  const event = {
    schemaVersion: 1 as const,
    eventId: 'durable-event',
    eventName: 'view',
    distinctId: 'visitor',
    sessionId: 'session',
    sequence: 0,
    clientTimestamp: new Date().toISOString(),
    url: 'https://example.com',
    properties: {},
    context: { sdkVersion: 'upgrade-test' },
  };
  await queue.enqueue(event);
  const name = (await indexedDB.databases())[0]?.name;
  if (!name) throw new Error('Expected a persisted queue database');
  const opening = openDB(name, 4);
  let future;
  try {
    future = await promptly(opening);
    expect(await future.getAll('events')).toEqual([event]);
    expect(await queue.enqueue({ ...event, eventId: 'memory-event' })).toEqual({
      status: 'storage_error',
      fallback: { status: 'queued' },
    });
    expect(queue.storageMode).toBe('memory');
    expect(await future.getAll('events')).toEqual([event]);
  } finally {
    queue.close();
    (future ?? (await opening)).close();
  }
});

it('falls back after five seconds when an open request never settles', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const request = new IDBOpenDBRequest();
  vi.spyOn(indexedDB, 'open').mockReturnValue(request);
  let resolved = false;
  const opening = openEventQueue({
    projectKey: 'silent-open',
    ingestionUrl: 'https://ingest.example.com',
  }).then((queue) => {
    resolved = true;
    queue.close();
    return queue;
  });
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(resolved).toBe(true);
    expect((await opening).storageMode).toBe('memory');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
