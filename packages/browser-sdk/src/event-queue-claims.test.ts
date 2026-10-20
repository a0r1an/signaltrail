import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsEventSchema } from '@signaltrail/contracts';
import { openEventQueue, type EventQueue } from './event-queue.ts';

const event = AnalyticsEventSchema.parse({
  schemaVersion: 1,
  eventId: 'event-z',
  eventName: 'pageview',
  distinctId: 'visitor-1',
  sessionId: 'session-1',
  clientTimestamp: '2026-10-20T16:00:00.000Z',
  sequence: 0,
  url: 'https://example.com',
  properties: {},
  context: { sdkVersion: '0.1.0' },
});
const config = { projectKey: 'project-A', ingestionUrl: 'https://ingest.example.com' };
const captureTime = Date.parse(event.clientTimestamp);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(captureTime);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const database of await indexedDB.databases()) {
    if (database.name !== undefined) await deleteDB(database.name);
  }
});

async function claim(queue: EventQueue, limit?: number) {
  const result = await queue.claimBatch(limit);
  expect(result.status).toBe('claimed');
  if (result.status !== 'claimed') throw new Error('Expected a batch claim');
  return result;
}

describe('event queue upload claims', () => {
  it('rolls back a partially written batch claim when a later claim write fails', async () => {
    const queue = await openEventQueue(config);
    let reopened: EventQueue | undefined;
    const second = { ...event, eventId: 'event-2' };
    try {
      await queue.enqueue(event);
      await queue.enqueue(second);
      const originalPut = IDBObjectStore.prototype.put;
      let writes = 0;
      const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        value,
        key,
      ) {
        if (++writes === 2) throw new DOMException('Claim write failed', 'UnknownError');
        return originalPut.call(this, value, key);
      });
      expect(await queue.claimBatch()).toEqual({ status: 'storage_error' });
      failure.mockRestore();
      reopened = await openEventQueue(config);
      expect((await claim(reopened)).events).toEqual([event, second]);
    } finally {
      queue.close();
      reopened?.close();
    }
  });

  it.each(['indexeddb', 'memory'] as const)(
    'keeps claims and release tokens isolated by project in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      const first = await openEventQueue(config);
      const second = await openEventQueue({ ...config, projectKey: 'project-B' });
      try {
        await first.enqueue(event);
        await second.enqueue(event);
        const original = await claim(first);
        expect(await second.releaseClaim(original.claimId)).toEqual({ status: 'not_owned' });
        expect((await claim(second)).events).toEqual([event]);
        expect(await first.claimBatch()).toEqual({ status: 'empty' });
      } finally {
        first.close();
        second.close();
      }
    },
  );

  it('upgrades a version-1 queue without losing existing events', async () => {
    // Historical namespace/schema fixture, intentionally independent of the current implementation.
    const legacy = await openDB(
      'signaltrail:analytics:v1:["https://ingest.example.com/","project-A"]',
      1,
      {
        upgrade(database) {
          const store = database.createObjectStore('events', { autoIncrement: true });
          store.createIndex('byEventId', 'eventId', { unique: true });
        },
      },
    );
    await legacy.add('events', event);
    legacy.close();
    const queue = await openEventQueue(config);
    try {
      expect(queue.storageMode).toBe('indexeddb');
      expect((await claim(queue)).events).toEqual([event]);
    } finally {
      queue.close();
    }
  });

  it('defaults to claiming 100 events and leaves the remainder available', async () => {
    const queue = await openEventQueue(config);
    const events = Array.from({ length: 101 }, (_, sequence) => ({
      ...event,
      eventId: `event-${sequence}`,
      sequence,
    }));
    try {
      for (const item of events) await queue.enqueue(item);
      expect((await claim(queue)).events).toEqual(events.slice(0, 100));
      expect((await claim(queue)).events).toEqual(events.slice(100));
      expect(await queue.claimBatch()).toEqual({ status: 'empty' });
    } finally {
      queue.close();
    }
  });

  it.each(['indexeddb', 'memory'] as const)(
    'drops expired events and stale claims before selecting in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      let time = captureTime;
      const queue = await openEventQueue(config, { maxAgeMs: 100, now: () => time });
      try {
        await queue.enqueue(event);
        const original = await claim(queue);
        time += 100;
        expect(await queue.claimBatch()).toEqual({ status: 'empty' });
        expect(await queue.releaseClaim(original.claimId)).toEqual({ status: 'not_owned' });
        const fresh = { ...event, clientTimestamp: new Date(time).toISOString() };
        await queue.enqueue(fresh);
        expect((await claim(queue)).events).toEqual([fresh]);
      } finally {
        queue.close();
      }
    },
  );

  it.each(['indexeddb', 'memory'] as const)(
    'rejects claim operations after a %s queue closes',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      const queue = await openEventQueue(config);
      queue.close();
      await expect(queue.claimBatch()).rejects.toMatchObject({ name: 'InvalidStateError' });
      await expect(queue.releaseClaim('old-claim')).rejects.toMatchObject({
        name: 'InvalidStateError',
      });
    },
  );

  it.each(['', ' \t '])(
    'rejects a blank claim token without degrading storage: %s',
    async (claimId) => {
      const queue = await openEventQueue(config);
      try {
        await expect(queue.releaseClaim(claimId)).rejects.toThrow(
          'claimId must be a nonblank string',
        );
        expect(queue.storageMode).toBe('indexeddb');
      } finally {
        queue.close();
      }
    },
  );

  it('reports release failures and leaves the durable lease for expiry', async () => {
    let time = captureTime;
    const queue = await openEventQueue(config, { now: () => time });
    let reopened: EventQueue | undefined;
    try {
      await queue.enqueue(event);
      const original = await claim(queue);
      const failure = vi.spyOn(IDBCursor.prototype, 'delete').mockImplementation(() => {
        throw new DOMException('Cannot release claim', 'UnknownError');
      });
      expect(await queue.releaseClaim(original.claimId)).toEqual({ status: 'storage_error' });
      expect(queue.storageMode).toBe('memory');
      failure.mockRestore();
      reopened = await openEventQueue(config, { now: () => time });
      expect(await reopened.claimBatch()).toEqual({ status: 'empty' });
      time = original.expiresAt;
      expect((await claim(reopened)).events).toEqual([event]);
    } finally {
      queue.close();
      reopened?.close();
    }
  });

  it('reports claim failures, retains the disk backlog, and switches to memory', async () => {
    const queue = await openEventQueue(config);
    let reopened: EventQueue | undefined;
    try {
      await queue.enqueue(event);
      const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
        throw new DOMException('Cannot save claim', 'QuotaExceededError');
      });
      expect(await queue.claimBatch()).toEqual({ status: 'storage_error' });
      expect(queue.storageMode).toBe('memory');
      failure.mockRestore();
      expect(await queue.claimBatch()).toEqual({ status: 'empty' });
      reopened = await openEventQueue(config);
      expect((await claim(reopened)).events).toEqual([event]);
    } finally {
      queue.close();
      reopened?.close();
    }
  });

  it('claims, releases, and reclaims expiring leases in memory without changing event IDs', async () => {
    vi.stubGlobal('indexedDB', undefined);
    let time = captureTime;
    const queue = await openEventQueue(config, { now: () => time });
    try {
      await queue.enqueue(event);
      const first = await claim(queue);
      expect(await queue.claimBatch()).toEqual({ status: 'empty' });
      expect(await queue.releaseClaim(first.claimId)).toEqual({ status: 'released' });
      const second = await claim(queue);
      expect(second.events).toEqual([event]);
      expect(await queue.releaseClaim(first.claimId)).toEqual({ status: 'not_owned' });
      time = second.expiresAt;
      const third = await claim(queue);
      expect(third.claimId).not.toBe(second.claimId);
      expect(third.events).toEqual([event]);
      expect(await queue.releaseClaim(second.claimId)).toEqual({ status: 'not_owned' });
      third.events[0]!.eventId = 'changed-by-caller';
      expect(await queue.getAll()).toEqual({ status: 'read', events: [event] });
    } finally {
      queue.close();
    }
  });

  it.each([0, -1, 1.5, 101, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid batch limit without degrading storage: %s',
    async (limit) => {
      const queue = await openEventQueue(config);
      try {
        await expect(queue.claimBatch(limit)).rejects.toThrow(
          'limit must be an integer from 1 to 100',
        );
        expect(queue.storageMode).toBe('indexeddb');
      } finally {
        queue.close();
      }
    },
  );

  it('rejects stale claim tokens after expiry even when the same owner reclaims the events', async () => {
    let time = captureTime;
    const queue = await openEventQueue(config, { now: () => time });
    try {
      await queue.enqueue(event);
      const original = await claim(queue);
      time = original.expiresAt;
      expect(await queue.releaseClaim(original.claimId)).toEqual({ status: 'not_owned' });
      const current = await claim(queue);
      expect(await queue.releaseClaim(original.claimId)).toEqual({ status: 'not_owned' });
      expect(await queue.claimBatch()).toEqual({ status: 'empty' });
      expect(await queue.releaseClaim(current.claimId)).toEqual({ status: 'released' });
      expect((await claim(queue)).events).toEqual([event]);
    } finally {
      queue.close();
    }
  });

  it('lets only the claiming connection release a batch without deleting its events', async () => {
    const first = await openEventQueue(config);
    const second = await openEventQueue(config);
    try {
      await first.enqueue(event);
      const original = await claim(first);
      expect(await second.releaseClaim(original.claimId)).toEqual({ status: 'not_owned' });
      expect(await second.claimBatch()).toEqual({ status: 'empty' });
      expect(await first.releaseClaim(original.claimId)).toEqual({ status: 'released' });
      const replacement = await claim(second);
      expect(replacement.events).toEqual([event]);
      expect(replacement.claimId).not.toBe(original.claimId);
    } finally {
      first.close();
      second.close();
    }
  });

  it('retains claims after closing a connection and reclaims them at the exact lease boundary', async () => {
    let time = captureTime;
    const first = await openEventQueue(config, { now: () => time });
    let reopened: EventQueue | undefined;
    try {
      await first.enqueue(event);
      const original = await claim(first);
      first.close();
      reopened = await openEventQueue(config, { now: () => time });
      time = original.expiresAt - 1;
      expect(await reopened.claimBatch()).toEqual({ status: 'empty' });
      time += 1;
      const replacement = await claim(reopened);
      expect(replacement.claimId).not.toBe(original.claimId);
      expect(replacement.events).toEqual([event]);
      expect(replacement.expiresAt).toBe(time + 60_000);
    } finally {
      first.close();
      reopened?.close();
    }
  });

  it('atomically gives concurrent connections disjoint batches and skips claimed events', async () => {
    const first = await openEventQueue(config);
    const second = await openEventQueue(config);
    const events = [event, { ...event, eventId: 'event-a' }, { ...event, eventId: 'event-b' }];
    try {
      for (const item of events) await first.enqueue(item);
      const claims = await Promise.all([claim(first, 2), claim(second, 2)]);
      const ids = claims.flatMap((batch) => batch.events.map((item) => item.eventId));
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      expect(claims[0].claimId).not.toBe(claims[1].claimId);
      expect(await first.claimBatch()).toEqual({ status: 'empty' });
      expect(await second.claimBatch()).toEqual({ status: 'empty' });
    } finally {
      first.close();
      second.close();
    }
  });

  it('claims a bounded batch in enqueue order with a 60-second lease without removing events', async () => {
    const queue = await openEventQueue(config);
    const second = { ...event, eventId: 'event-a', sequence: 1 };
    try {
      await queue.enqueue(event);
      await queue.enqueue(second);
      const result = await claim(queue, 1);
      expect(result.claimId).toEqual(expect.any(String));
      expect(result.claimId.length).toBeGreaterThan(0);
      expect(result.expiresAt).toBe(captureTime + 60_000);
      expect(result.events).toEqual([event]);
      expect(await queue.getAll()).toEqual({ status: 'read', events: [event, second] });
    } finally {
      queue.close();
    }
  });
});
