import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsEventSchema } from '@signaltrail/contracts';
import { openEventQueue, type EventQueue } from '../../src/event-queue.ts';

const validEvent = AnalyticsEventSchema.parse({
  schemaVersion: 1,
  eventId: 'event-1',
  eventName: 'product_viewed',
  distinctId: 'visitor-1',
  sessionId: 'session-1',
  clientTimestamp: '2026-10-16T16:00:00.000Z',
  sequence: 0,
  url: 'https://example.com/products/123',
  properties: { productId: '123' },
  context: { sdkVersion: '0.1.0' },
});

const captureTime = Date.parse(validEvent.clientTimestamp);

function projectConfig(projectKey: string) {
  return { projectKey, ingestionUrl: 'https://ingest.signaltrail.test' };
}

async function readEvents(queue: EventQueue) {
  const result = await queue.getAll();
  expect(result.status).toBe('read');
  if (result.status !== 'read') throw new Error('Expected a successful queue read');
  return result.events;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(captureTime);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Discover names only for test cleanup; assertions use the public queue API.
  for (const database of await indexedDB.databases()) {
    if (database.name !== undefined) await deleteDB(database.name);
  }
});

describe('event queue', () => {
  it('keeps both events when concurrent persistent operations fail', async () => {
    const queue = await openEventQueue(projectConfig('project-A'));
    const failure = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'UnknownError');
    });
    try {
      const second = { ...validEvent, eventId: 'event-2' };
      expect(await Promise.all([queue.enqueue(validEvent), queue.enqueue(second)])).toEqual([
        { status: 'storage_error', fallback: { status: 'queued' } },
        { status: 'storage_error', fallback: { status: 'queued' } },
      ]);
      expect(await readEvents(queue)).toEqual([validEvent, second]);
      expect(queue.storageMode).toBe('memory');
    } finally {
      failure.mockRestore();
      queue.close();
    }
  });

  it('reports when an event cannot fit in memory after a persistent write fails', async () => {
    const size = new TextEncoder().encode(JSON.stringify(validEvent)).byteLength;
    const queue = await openEventQueue(projectConfig('project-A'), {
      memory: { maxBytes: size - 1 },
    });
    const failure = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new DOMException('Disk unavailable', 'UnknownError');
    });
    try {
      expect(await queue.enqueue(validEvent)).toEqual({
        status: 'storage_error',
        fallback: { status: 'dropped', reason: 'capacity' },
      });
      expect(await readEvents(queue)).toEqual([]);
      expect(queue.storageMode).toBe('memory');
    } finally {
      failure.mockRestore();
      queue.close();
    }
  });

  it('preserves the ID when durable presence cannot be confirmed and both backlogs contain the event', async () => {
    const config = projectConfig('project-A');
    const queue = await openEventQueue(config);
    let reopened: EventQueue | undefined;
    try {
      await queue.enqueue(validEvent);
      const failure = vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(() => {
        throw new DOMException('Cannot confirm existing event', 'UnknownError');
      });
      expect(await queue.enqueue(validEvent)).toEqual({
        status: 'storage_error',
        fallback: { status: 'queued' },
      });
      failure.mockRestore();
      expect(await readEvents(queue)).toEqual([validEvent]);
      reopened = await openEventQueue(config);
      expect(await readEvents(reopened)).toEqual([validEvent]);
      expect(queue.storageMode).toBe('memory');
    } finally {
      queue.close();
      reopened?.close();
    }
  });

  it('does not reopen a closed persistent queue in memory', async () => {
    const queue = await openEventQueue(projectConfig('project-A'));
    queue.close();
    await expect(queue.enqueue(validEvent)).rejects.toMatchObject({ name: 'InvalidStateError' });
    await expect(queue.getAll()).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(queue.storageMode).toBe('indexeddb');
  });

  it('preserves the captured event and ID if the caller mutates it while a write fails', async () => {
    const queue = await openEventQueue(projectConfig('project-A'));
    const failure = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => {
      throw new DOMException('Disk full', 'QuotaExceededError');
    });
    try {
      const event = structuredClone(validEvent);
      const pending = queue.enqueue(event);
      event.eventId = 'changed-by-caller';
      event.properties.productId = 'changed-by-caller';
      expect(await pending).toEqual({ status: 'storage_error', fallback: { status: 'queued' } });
      expect(await readEvents(queue)).toEqual([validEvent]);
    } finally {
      failure.mockRestore();
      queue.close();
    }
  });

  it('handles a rejected write request and its aborted transaction without an unhandled rejection', async () => {
    const config = projectConfig('project-A');
    const queue = await openEventQueue(config);
    let reopened: EventQueue | undefined;
    try {
      await queue.enqueue(validEvent);
      const originalAdd = IDBObjectStore.prototype.add;
      const failure = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
        this: IDBObjectStore,
        value,
      ) {
        // Force a real asynchronous uniqueness violation at the storage boundary.
        return originalAdd.call(this, { ...value, eventId: validEvent.eventId });
      });
      const next = { ...validEvent, eventId: 'event-2' };
      expect(await queue.enqueue(next)).toEqual({
        status: 'storage_error',
        fallback: { status: 'queued' },
      });
      expect(await readEvents(queue)).toEqual([next]);
      failure.mockRestore();
      reopened = await openEventQueue(config);
      expect(await readEvents(reopened)).toEqual([validEvent]);
    } finally {
      queue.close();
      reopened?.close();
    }
  });

  it('recovers from an asynchronous transaction abort after an add request succeeds', async () => {
    const config = projectConfig('project-A');
    const queue = await openEventQueue(config);
    let reopened: EventQueue | undefined;
    try {
      await queue.enqueue(validEvent);
      const originalAdd = IDBObjectStore.prototype.add;
      const failure = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
        this: IDBObjectStore,
        value,
        key,
      ) {
        const request = originalAdd.call(this, value, key);
        request.addEventListener('success', () => this.transaction.abort());
        return request;
      });
      const next = { ...validEvent, eventId: 'event-2' };
      expect(await queue.enqueue(next)).toEqual({
        status: 'storage_error',
        fallback: { status: 'queued' },
      });
      expect(await readEvents(queue)).toEqual([next]);
      failure.mockRestore();
      reopened = await openEventQueue(config);
      expect(await readEvents(reopened)).toEqual([validEvent]);
    } finally {
      queue.close();
      reopened?.close();
    }
  });

  it('reports a failed read instead of an empty queue, then stays in memory until reinitialization', async () => {
    const config = projectConfig('project-A');
    const queue = await openEventQueue(config);
    let reopened: EventQueue | undefined;
    try {
      await queue.enqueue(validEvent);
      const failure = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
        throw new DOMException('Read failed', 'UnknownError');
      });
      expect(await queue.getAll()).toEqual({ status: 'storage_error' });
      expect(queue.storageMode).toBe('memory');
      failure.mockRestore();
      const next = { ...validEvent, eventId: 'event-2' };
      expect(await queue.enqueue(next)).toEqual({ status: 'queued' });
      expect(await readEvents(queue)).toEqual([next]);
      reopened = await openEventQueue(config);
      expect(reopened.storageMode).toBe('indexeddb');
      expect(await readEvents(reopened)).toEqual([validEvent]);
      expect(queue.storageMode).toBe('memory');
    } finally {
      queue.close();
      reopened?.close();
    }
  });

  it('reports a failed persistent write, keeps its ID in memory, and preserves the disk backlog', async () => {
    const config = projectConfig('project-A');
    const queue = await openEventQueue(config);
    let reopened: Awaited<ReturnType<typeof openEventQueue>> | undefined;
    const next = { ...validEvent, eventId: 'event-2' };
    try {
      expect(queue.storageMode).toBe('indexeddb');
      await queue.enqueue(validEvent);
      const failure = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
        throw new DOMException('Storage operation failed', 'UnknownError');
      });
      expect(await queue.enqueue(next)).toEqual({
        status: 'storage_error',
        fallback: { status: 'queued' },
      });
      expect(queue.storageMode).toBe('memory');
      failure.mockRestore();
      expect(await readEvents(queue)).toEqual([next]);
      reopened = await openEventQueue(config);
      expect(await readEvents(reopened)).toEqual([validEvent]);
    } finally {
      queue.close();
      reopened?.close();
    }
  });

  it('does not hide configuration errors when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(openEventQueue(projectConfig(''))).rejects.toThrow('projectKey');
    await expect(openEventQueue(projectConfig('project-A'), { maxEvents: 0 })).rejects.toThrow(
      'maxEvents',
    );
    await expect(
      openEventQueue(projectConfig('project-A'), {
        memory: { maxEvents: 0 },
      }),
    ).rejects.toThrow('memory.maxEvents');
  });

  it('does not retain memory events after closing and reopening a queue', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const config = projectConfig('project-A');
    const first = await openEventQueue(config);
    await first.enqueue(validEvent);
    first.close();
    const reopened = await openEventQueue(config);
    try {
      expect(await readEvents(reopened)).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it('falls back when opening IndexedDB throws a storage access error', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('Storage access denied', 'SecurityError');
    });
    const queue = await openEventQueue(projectConfig('project-A'));
    try {
      expect(queue.storageMode).toBe('memory');
      expect(await queue.enqueue(validEvent)).toEqual({ status: 'queued' });
    } finally {
      queue.close();
    }
  });

  it('falls back when the IndexedDB open request fails asynchronously', async () => {
    // A lower-version open produces a real asynchronous VersionError request.
    const incompatible = await openDB('signaltrail-incompatible-version-test', 2);
    incompatible.close();
    const originalOpen = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation(() =>
      originalOpen('signaltrail-incompatible-version-test', 1),
    );
    const queue = await openEventQueue(projectConfig('project-A'));
    try {
      expect(queue.storageMode).toBe('memory');
      expect(await queue.enqueue(validEvent)).toEqual({ status: 'queued' });
    } finally {
      queue.close();
    }
  });

  it('keeps memory queues isolated by project and endpoint', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const first = await openEventQueue(projectConfig('project-A'));
    const second = await openEventQueue(projectConfig('project-B'));
    const otherEndpoint = await openEventQueue({
      projectKey: 'project-A',
      ingestionUrl: 'https://other.signaltrail.test',
    });

    try {
      await first.enqueue(validEvent);
      expect(await readEvents(second)).toEqual([]);
      expect(await readEvents(otherEndpoint)).toEqual([]);
      expect(await second.enqueue(validEvent)).toEqual({ status: 'queued' });
      expect(await otherEndpoint.enqueue(validEvent)).toEqual({ status: 'queued' });
    } finally {
      first.close();
      second.close();
      otherEndpoint.close();
    }
  });

  it('copies memory events on enqueue and read so callers cannot mutate the queue', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const queue = await openEventQueue(projectConfig('project-A'));
    const event = { ...validEvent, properties: { nested: { value: 'original' } } };
    const expected = structuredClone(event);

    try {
      await queue.enqueue(event);
      event.properties.nested.value = 'changed';
      const stored = await readEvents(queue);
      expect(stored).toEqual([expected]);
      stored[0]!.eventName = 'changed';
      expect(await readEvents(queue)).toEqual([expected]);
    } finally {
      queue.close();
    }
  });

  it('rejects operations on a closed memory queue', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const queue = await openEventQueue(projectConfig('project-A'));
    await queue.enqueue(validEvent);
    queue.close();

    await expect(queue.enqueue(validEvent)).rejects.toMatchObject({ name: 'InvalidStateError' });
    await expect(queue.getAll()).rejects.toMatchObject({ name: 'InvalidStateError' });
    queue.close();
  });

  describe.each(['maxEvents', 'maxBytes'] as const)('memory.%s configuration', (option) => {
    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
      'rejects invalid limits before opening storage: %s',
      async (value) => {
        let queue: Awaited<ReturnType<typeof openEventQueue>> | undefined;
        try {
          await expect(
            openEventQueue(projectConfig('project-A'), {
              memory: { [option]: value },
            }).then((opened) => {
              queue = opened;
              return opened;
            }),
          ).rejects.toThrow(`memory.${option} must be a positive safe integer`);
        } finally {
          queue?.close();
        }
      },
    );
  });

  it('reclaims expired count and byte capacity in the memory queue', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const maxBytes = new TextEncoder().encode(JSON.stringify(validEvent)).byteLength;
    let time = captureTime;
    const queue = await openEventQueue(projectConfig('project-A'), {
      maxAgeMs: 100,
      now: () => time,
      memory: { maxEvents: 1, maxBytes },
    });

    try {
      await queue.enqueue(validEvent);
      expect(await queue.enqueue({ ...validEvent, eventId: 'event-2' })).toEqual({
        status: 'dropped',
        reason: 'capacity',
      });
      time += 100;
      const fresh = {
        ...validEvent,
        eventId: 'event-2',
        clientTimestamp: new Date(time).toISOString(),
      };
      expect(await queue.enqueue(fresh)).toEqual({ status: 'queued' });
      expect(await readEvents(queue)).toEqual([fresh]);
      expect(await queue.enqueue({ ...fresh, eventId: 'event-3' })).toEqual({
        status: 'dropped',
        reason: 'capacity',
      });
    } finally {
      queue.close();
    }
  });

  it('honors a configured memory byte limit', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const size = new TextEncoder().encode(JSON.stringify(validEvent)).byteLength;
    const queue = await openEventQueue(projectConfig('project-A'), {
      memory: { maxBytes: size - 1 },
    });

    try {
      expect(await queue.enqueue(validEvent)).toEqual({ status: 'dropped', reason: 'capacity' });
      expect(await readEvents(queue)).toEqual([]);
    } finally {
      queue.close();
    }
  });

  it('honors a configured memory count limit', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const queue = await openEventQueue(projectConfig('project-A'), {
      memory: { maxEvents: 1 },
    });

    try {
      await queue.enqueue(validEvent);
      expect(await queue.enqueue({ ...validEvent, eventName: 'changed' })).toEqual({
        status: 'already_queued',
      });
      expect(await queue.enqueue({ ...validEvent, eventId: 'overflow' })).toEqual({
        status: 'dropped',
        reason: 'capacity',
      });
      expect(await readEvents(queue)).toEqual([validEvent]);
    } finally {
      queue.close();
    }
  });

  it('expires memory events at 24 hours from capture without extending duplicates', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const day = 24 * 60 * 60 * 1000;
    let time = captureTime;
    const queue = await openEventQueue(projectConfig('project-A'), { now: () => time });

    try {
      await queue.enqueue(validEvent);
      time = captureTime + day - 1;
      expect(
        await queue.enqueue({
          ...validEvent,
          clientTimestamp: new Date(time).toISOString(),
        }),
      ).toEqual({ status: 'already_queued' });
      expect(await readEvents(queue)).toEqual([validEvent]);
      time += 1;
      expect(await readEvents(queue)).toEqual([]);
      expect(await queue.enqueue(validEvent)).toEqual({ status: 'dropped', reason: 'expired' });
    } finally {
      queue.close();
    }
  });

  it('preserves the original memory event when its ID is enqueued again', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const queue = await openEventQueue(projectConfig('project-A'));

    try {
      await queue.enqueue(validEvent);
      expect(await queue.enqueue({ ...validEvent, eventName: 'changed' })).toEqual({
        status: 'already_queued',
      });
      expect(await readEvents(queue)).toEqual([validEvent]);
    } finally {
      queue.close();
    }
  });

  it('uses a 256 KiB UTF-8 budget in memory, accepting an exact fit', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const queue = await openEventQueue(projectConfig('project-A'));
    const base = { ...validEvent, properties: { label: '🛒 café', padding: '' } };
    const size = new TextEncoder().encode(JSON.stringify(base)).byteLength;
    const event = {
      ...base,
      properties: { ...base.properties, padding: 'x'.repeat(256 * 1024 - size) },
    };

    try {
      expect(await queue.enqueue(event)).toEqual({ status: 'queued' });
      expect(await queue.enqueue({ ...validEvent, eventId: 'overflow' })).toEqual({
        status: 'dropped',
        reason: 'capacity',
      });
      expect(await readEvents(queue)).toEqual([event]);
    } finally {
      queue.close();
    }
  });

  it('bounds the memory queue to 100 events while preserving the oldest', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const queue = await openEventQueue(projectConfig('project-A'));
    const events = Array.from({ length: 100 }, (_, sequence) => ({
      ...validEvent,
      eventId: `event-${sequence}`,
      sequence,
    }));

    try {
      const results = await Promise.all(events.map((event) => queue.enqueue(event)));
      expect(results.every((result) => result.status === 'queued')).toBe(true);
      expect(await queue.enqueue({ ...validEvent, eventId: 'overflow' })).toEqual({
        status: 'dropped',
        reason: 'capacity',
      });
      expect(await readEvents(queue)).toEqual(events);
    } finally {
      queue.close();
    }
  });

  it('falls back to a usable memory queue when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const queue = await openEventQueue(projectConfig('project-A'));

    try {
      expect(queue.storageMode).toBe('memory');
      expect(await queue.enqueue(validEvent)).toEqual({ status: 'queued' });
      expect(await readEvents(queue)).toEqual([validEvent]);
    } finally {
      queue.close();
    }
  });

  it('reopens each project independently without moving pending events', async () => {
    const firstEvent = { ...validEvent, eventName: 'project_A' };
    const secondEvent = { ...validEvent, eventName: 'project_B' };
    let first = await openEventQueue(projectConfig('project-A'));
    let second = await openEventQueue(projectConfig('project-B'));

    try {
      await first.enqueue(firstEvent);
      await second.enqueue(secondEvent);
      first.close();
      second.close();
      first = await openEventQueue(projectConfig('project-A'));
      second = await openEventQueue(projectConfig('project-B'));
      expect(await readEvents(first)).toEqual([firstEvent]);
      expect(await readEvents(second)).toEqual([secondEvent]);
    } finally {
      first.close();
      second.close();
    }
  });

  it.each([
    'not-a-url',
    '/ingest',
    'ftp://ingest.signaltrail.test/',
    'https://user:password@ingest.signaltrail.test/',
    'https://ingest.signaltrail.test/#fragment',
  ])('rejects an invalid ingestion endpoint: %s', async (ingestionUrl) => {
    let queue: Awaited<ReturnType<typeof openEventQueue>> | undefined;
    try {
      await expect(
        openEventQueue({ projectKey: 'project-A', ingestionUrl }).then((opened) => {
          queue = opened;
          return opened;
        }),
      ).rejects.toThrow(
        'ingestionUrl must be an absolute HTTP(S) URL without credentials or a fragment',
      );
    } finally {
      queue?.close();
    }
  });

  it.each(['', ' \t '])('rejects a blank project key: %s', async (projectKey) => {
    let queue: Awaited<ReturnType<typeof openEventQueue>> | undefined;
    try {
      await expect(
        openEventQueue(projectConfig(projectKey)).then((opened) => {
          queue = opened;
          return opened;
        }),
      ).rejects.toThrow('projectKey must be a nonblank string');
    } finally {
      queue?.close();
    }
  });

  it.each([
    'http://ingest.signaltrail.test/',
    'https://other.signaltrail.test/',
    'https://ingest.signaltrail.test:8443/',
    'https://ingest.signaltrail.test/ingest',
    'https://ingest.signaltrail.test/?environment=development',
  ])('isolates the same project key at another endpoint: %s', async (ingestionUrl) => {
    const first = await openEventQueue(projectConfig('project-A'));
    const second = await openEventQueue({ projectKey: 'project-A', ingestionUrl });

    try {
      await first.enqueue(validEvent);
      expect(await readEvents(second)).toEqual([]);
      expect(await second.enqueue(validEvent)).toEqual({ status: 'queued' });
      expect(await readEvents(first)).toEqual([validEvent]);
      expect(await readEvents(second)).toEqual([validEvent]);
    } finally {
      first.close();
      second.close();
    }
  });

  it('keeps count and byte budgets independent for each project', async () => {
    const maxBytes = new TextEncoder().encode(JSON.stringify(validEvent)).byteLength;
    const options = { maxEvents: 1, maxBytes };
    const first = await openEventQueue(projectConfig('project-A'), options);
    const second = await openEventQueue(projectConfig('project-B'), options);

    try {
      const results = await Promise.all([first.enqueue(validEvent), second.enqueue(validEvent)]);
      expect(results).toEqual([{ status: 'queued' }, { status: 'queued' }]);
      expect(await first.enqueue({ ...validEvent, eventId: 'event-2' })).toEqual({
        status: 'dropped',
        reason: 'capacity',
      });
      expect(await second.enqueue({ ...validEvent, eventId: 'event-2' })).toEqual({
        status: 'dropped',
        reason: 'capacity',
      });
    } finally {
      first.close();
      second.close();
    }
  });

  it('keeps an open queue bound to its original configuration', async () => {
    const config = projectConfig('project-A');
    const queue = await openEventQueue(config);
    config.projectKey = 'project-B';
    config.ingestionUrl = 'https://other.signaltrail.test';
    const original = await openEventQueue(projectConfig('project-A'));
    const changed = await openEventQueue(config);

    try {
      await queue.enqueue(validEvent);
      expect(await readEvents(original)).toEqual([validEvent]);
      expect(await readEvents(changed)).toEqual([]);
    } finally {
      queue.close();
      original.close();
      changed.close();
    }
  });

  it('shares a queue across equivalent endpoint URLs and independently created configurations', async () => {
    const first = await openEventQueue({
      projectKey: 'project-A',
      ingestionUrl: 'https://INGEST.signaltrail.test:443',
    });
    let reopened: Awaited<ReturnType<typeof openEventQueue>> | undefined;

    try {
      await first.enqueue(validEvent);
      first.close();
      reopened = await openEventQueue({
        projectKey: 'project-A',
        ingestionUrl: 'https://ingest.signaltrail.test/',
      });
      expect(await readEvents(reopened)).toEqual([validEvent]);
    } finally {
      first.close();
      reopened?.close();
    }
  });

  it('keeps different project keys isolated at the same endpoint', async () => {
    const first = await openEventQueue(projectConfig('project-A'));
    const second = await openEventQueue(projectConfig('project-B'));

    try {
      await first.enqueue(validEvent);
      expect(await readEvents(second)).toEqual([]);
      const other = { ...validEvent, eventName: 'other_project' };
      expect(await second.enqueue(other)).toEqual({ status: 'queued' });
      expect(await readEvents(first)).toEqual([validEvent]);
      expect(await readEvents(second)).toEqual([other]);
    } finally {
      first.close();
      second.close();
    }
  });

  it('uses a 1 MiB byte budget by default', async () => {
    const config = projectConfig('signaltrail-queue-default-bytes-test');
    const queue = await openEventQueue(config);

    try {
      expect(
        await queue.enqueue({
          ...validEvent,
          properties: { payload: 'x'.repeat(1024 * 1024) },
        }),
      ).toEqual({ status: 'dropped', reason: 'capacity' });
      expect(await readEvents(queue)).toEqual([]);
    } finally {
      queue.close();
    }
  });

  it('reclaims expired capacity atomically across concurrent connections', async () => {
    const config = projectConfig('signaltrail-queue-concurrent-expiry-test');
    let time = captureTime;
    const options = { maxEvents: 1, maxAgeMs: 100, now: () => time };
    const first = await openEventQueue(config, options);
    const second = await openEventQueue(config, options);

    try {
      await first.enqueue(validEvent);
      time += 100;
      const fresh = { ...validEvent, clientTimestamp: new Date(time).toISOString() };
      const results = await Promise.all([
        first.enqueue({ ...fresh, eventId: 'event-A' }),
        second.enqueue({ ...fresh, eventId: 'event-B' }),
      ]);
      expect(results.filter((result) => result.status === 'queued')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'dropped')).toHaveLength(1);
      const remaining = await readEvents(first);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.eventId).not.toBe(validEvent.eventId);
    } finally {
      first.close();
      second.close();
    }
  });

  it('does not move a duplicate or extend its original expiry', async () => {
    const config = projectConfig('signaltrail-queue-duplicate-expiry-test');
    let time = captureTime;
    const queue = await openEventQueue(config, { maxAgeMs: 100, now: () => time });
    const second = { ...validEvent, eventId: 'event-2', sequence: 1 };

    try {
      await queue.enqueue(validEvent);
      time += 50;
      const newer = { ...second, clientTimestamp: new Date(time).toISOString() };
      await queue.enqueue(newer);
      expect(
        await queue.enqueue({
          ...validEvent,
          clientTimestamp: new Date(time).toISOString(),
          eventName: 'changed',
        }),
      ).toEqual({ status: 'already_queued' });
      expect(await readEvents(queue)).toEqual([validEvent, newer]);
      time = captureTime + 100;
      expect(await readEvents(queue)).toEqual([newer]);
    } finally {
      queue.close();
    }
  });

  it('handles the same ID concurrently without storing two copies', async () => {
    const config = projectConfig('signaltrail-queue-concurrent-duplicate-test');
    const first = await openEventQueue(config);
    const second = await openEventQueue(config);

    try {
      const results = await Promise.all([first.enqueue(validEvent), second.enqueue(validEvent)]);
      expect(results.filter((result) => result.status === 'queued')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'already_queued')).toHaveLength(1);
      expect(await readEvents(first)).toEqual([validEvent]);
    } finally {
      first.close();
      second.close();
    }
  });

  it('drops an incoming event that has already expired', async () => {
    const config = projectConfig('signaltrail-queue-stale-input-test');
    const queue = await openEventQueue(config, {
      maxAgeMs: 100,
      now: () => captureTime + 100,
    });

    try {
      expect(await queue.enqueue(validEvent)).toEqual({ status: 'dropped', reason: 'expired' });
      expect(await readEvents(queue)).toEqual([]);
    } finally {
      queue.close();
    }
  });

  it('removes expired events before checking count and byte capacity', async () => {
    const config = projectConfig('signaltrail-queue-expired-capacity-test');
    const maxBytes = new TextEncoder().encode(JSON.stringify(validEvent)).byteLength;
    let time = captureTime;
    const queue = await openEventQueue(config, {
      maxEvents: 1,
      maxBytes,
      maxAgeMs: 100,
      now: () => time,
    });

    try {
      await queue.enqueue(validEvent);
      time += 100;
      const next = {
        ...validEvent,
        eventId: 'event-2',
        clientTimestamp: new Date(time).toISOString(),
      };
      expect(await queue.enqueue(next)).toEqual({ status: 'queued' });
      expect(await readEvents(queue)).toEqual([next]);
    } finally {
      queue.close();
    }
  });

  it('expires events at 24 hours from capture, including after reopening', async () => {
    const config = projectConfig('signaltrail-queue-expiry-test');
    const day = 24 * 60 * 60 * 1000;
    let time = captureTime + 1000;
    let queue = await openEventQueue(config, { now: () => time });

    try {
      await queue.enqueue(validEvent);
      queue.close();
      queue = await openEventQueue(config, { now: () => time });
      time = captureTime + day - 1;
      expect(await readEvents(queue)).toEqual([validEvent]);
      time = captureTime + day;
      expect(await readEvents(queue)).toEqual([]);
      time = captureTime;
      expect(await readEvents(queue)).toEqual([]);
    } finally {
      queue.close();
    }
  });

  it('drops a single event one UTF-8 byte over the budget even when its string length fits', async () => {
    const config = projectConfig('signaltrail-queue-unicode-size-test');
    const event = { ...validEvent, properties: { label: '🛒 café' } };
    const serialized = JSON.stringify(event);
    const maxBytes = new TextEncoder().encode(serialized).byteLength - 1;
    expect(serialized.length).toBeLessThan(maxBytes);
    const queue = await openEventQueue(config, { maxBytes });

    try {
      expect(await queue.enqueue(event)).toEqual({ status: 'dropped', reason: 'capacity' });
      expect(await readEvents(queue)).toEqual([]);
    } finally {
      queue.close();
    }
  });

  it('shares the byte budget across concurrent connections and reopening', async () => {
    const config = projectConfig('signaltrail-queue-concurrent-bytes-test');
    const first = { ...validEvent, eventId: 'event-A' };
    const second = { ...validEvent, eventId: 'event-B' };
    const maxBytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;
    const firstQueue = await openEventQueue(config, { maxBytes });
    let secondQueue = await openEventQueue(config, { maxBytes });

    try {
      const results = await Promise.all([firstQueue.enqueue(first), secondQueue.enqueue(second)]);
      expect(results.filter((result) => result.status === 'queued')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'dropped')).toHaveLength(1);
      secondQueue.close();
      secondQueue = await openEventQueue(config, { maxBytes });
      expect(await secondQueue.enqueue({ ...validEvent, eventId: 'event-C' })).toEqual({
        status: 'dropped',
        reason: 'capacity',
      });
      expect(await readEvents(secondQueue)).toHaveLength(1);
    } finally {
      firstQueue.close();
      secondQueue.close();
    }
  });

  it('accepts the exact UTF-8 byte budget and drops the next event', async () => {
    const config = projectConfig('signaltrail-queue-byte-capacity-test');
    const first = { ...validEvent, properties: { label: '🛒 café' } };
    const maxBytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;
    const queue = await openEventQueue(config, { maxBytes });

    try {
      expect(await queue.enqueue(first)).toEqual({ status: 'queued' });
      expect(await queue.enqueue({ ...first, eventId: 'event-2' })).toEqual({
        status: 'dropped',
        reason: 'capacity',
      });
      expect(await readEvents(queue)).toEqual([first]);
    } finally {
      queue.close();
    }
  });

  it('preserves the original event when its ID is enqueued again at capacity', async () => {
    const config = projectConfig('signaltrail-queue-duplicate-test');
    const queue = await openEventQueue(config, { maxEvents: 1 });

    try {
      await queue.enqueue(validEvent);
      expect(await queue.enqueue({ ...validEvent, eventName: 'changed' })).toEqual({
        status: 'already_queued',
      });
      expect(await readEvents(queue)).toEqual([validEvent]);
    } finally {
      queue.close();
    }
  });

  describe.each(['maxBytes', 'maxAgeMs'] as const)('%s configuration', (option) => {
    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
      'rejects invalid limit: %s',
      async (value) => {
        const config = projectConfig('signaltrail-queue-invalid-limit-test');
        let queue: Awaited<ReturnType<typeof openEventQueue>> | undefined;

        try {
          await expect(
            openEventQueue(config, { [option]: value }).then((opened) => {
              queue = opened;
              return opened;
            }),
          ).rejects.toThrow(`${option} must be a positive safe integer`);
        } finally {
          queue?.close();
        }
      },
    );
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxEvents: %s',
    async (maxEvents) => {
      const config = projectConfig('signaltrail-queue-invalid-options-test');
      let queue: Awaited<ReturnType<typeof openEventQueue>> | undefined;

      try {
        await expect(
          openEventQueue(config, { maxEvents }).then((opened) => {
            queue = opened;
            return opened;
          }),
        ).rejects.toThrow('maxEvents must be a positive safe integer');
      } finally {
        queue?.close();
      }
    },
  );

  it('preserves an event after closing and reopening the connection', async () => {
    const config = projectConfig('signaltrail-queue-reopen-test');
    let queue = await openEventQueue(config);

    try {
      await queue.enqueue(validEvent);
      queue.close();

      queue = await openEventQueue(config);

      expect(await readEvents(queue)).toEqual([validEvent]);
    } finally {
      queue.close();
    }
  });

  it('returns events in enqueue order rather than eventId order', async () => {
    const config = projectConfig('signaltrail-queue-order-test');
    const queue = await openEventQueue(config);

    const first = { ...validEvent, eventId: 'event-z', sequence: 0 };
    const second = { ...validEvent, eventId: 'event-a', sequence: 1 };

    try {
      await queue.enqueue(first);
      await queue.enqueue(second);

      expect(await readEvents(queue)).toEqual([first, second]);
    } finally {
      queue.close();
    }
  });

  it('drops a new event at capacity and preserves older events', async () => {
    const config = projectConfig('signaltrail-queue-capacity-test');
    const queue = await openEventQueue(config, { maxEvents: 2 });

    const first = { ...validEvent, eventId: 'event-1', sequence: 0 };
    const second = { ...validEvent, eventId: 'event-2', sequence: 1 };
    const third = { ...validEvent, eventId: 'event-3', sequence: 2 };

    try {
      expect(await queue.enqueue(first)).toEqual({ status: 'queued' });
      expect(await queue.enqueue(second)).toEqual({ status: 'queued' });
      expect(await queue.enqueue(third)).toEqual({
        status: 'dropped',
        reason: 'capacity',
      });

      expect(await readEvents(queue)).toEqual([first, second]);
    } finally {
      queue.close();
    }
  });

  it('enforces capacity across concurrent queue connections', async () => {
    const config = projectConfig('signaltrail-queue-concurrent-capacity-test');
    const firstQueue = await openEventQueue(config, { maxEvents: 1 });
    const secondQueue = await openEventQueue(config, { maxEvents: 1 });

    try {
      const results = await Promise.all([
        firstQueue.enqueue({
          ...validEvent,
          eventId: 'event-A',
        }),
        secondQueue.enqueue({
          ...validEvent,
          eventId: 'event-B',
        }),
      ]);

      expect(results.filter((result) => result.status === 'queued')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'dropped')).toHaveLength(1);
      expect(await readEvents(firstQueue)).toHaveLength(1);
    } finally {
      firstQueue.close();
      secondQueue.close();
    }
  });
});
