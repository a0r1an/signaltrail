import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsEventSchema } from '@signaltrail/contracts';
import { openEventQueue, type EventQueue } from './event-queue.ts';

const event = AnalyticsEventSchema.parse({
  schemaVersion: 1,
  eventId: 'event-1',
  eventName: 'pageview',
  distinctId: 'visitor-1',
  sessionId: 'session-1',
  clientTimestamp: '2026-10-20T16:00:00.000Z',
  sequence: 0,
  url: 'https://example.com',
  properties: {},
  context: { sdkVersion: '0.1.0' },
});
const captureTime = Date.parse(event.clientTimestamp);
const config = { projectKey: 'project-A', ingestionUrl: 'https://ingest.example.com' };

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
  if (result.status !== 'claimed') throw new Error('Expected an eligible batch');
  return result;
}

async function retry(
  queue: EventQueue,
  batch: Awaited<ReturnType<typeof claim>>,
  retryAfterMs?: number,
) {
  expect(
    await queue.applyResponse(batch.claimId, {
      results: batch.events.map((item, index) => ({
        index,
        status: 'retry',
        eventId: item.eventId,
        code: 'PUBLICATION_UNCONFIRMED',
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      })),
    }),
  ).toEqual({ status: 'applied' });
}

describe('event queue retry timing', () => {
  it('shares retry eligibility across connections and claims due events atomically', async () => {
    let time = captureTime;
    const options = { now: () => time, random: () => 0.5 };
    const first = await openEventQueue(config, options);
    const second = await openEventQueue(config, options);
    try {
      await first.enqueue(event);
      await retry(first, await claim(first));
      expect(await second.claimBatch()).toEqual({ status: 'empty' });
      time += 500;
      const results = await Promise.all([first.claimBatch(), second.claimBatch()]);
      expect(results.map((result) => result.status).sort()).toEqual(['claimed', 'empty']);
      const claimed = results.find((result) => result.status === 'claimed');
      expect(claimed?.events).toEqual([event]);
    } finally {
      first.close();
      second.close();
    }
  });

  it('upgrades a version-2 queue with existing events and claims support', async () => {
    const legacy = await openDB(
      'signaltrail:analytics:v1:["https://ingest.example.com/","project-A"]',
      2,
      {
        upgrade(database) {
          const events = database.createObjectStore('events', { autoIncrement: true });
          events.createIndex('byEventId', 'eventId', { unique: true });
          const claims = database.createObjectStore('claims', { keyPath: 'eventKey' });
          claims.createIndex('byClaimId', 'claimId');
        },
      },
    );
    await legacy.add('events', event);
    legacy.close();
    let time = captureTime;
    const queue = await openEventQueue(config, { now: () => time, random: () => 0.5 });
    try {
      expect(queue.storageMode).toBe('indexeddb');
      await retry(queue, await claim(queue));
      time += 500;
      expect((await claim(queue)).events).toEqual([event]);
    } finally {
      queue.close();
    }
  });

  it('rolls back retry counts, eligible times, and claim releases when a metadata write fails', async () => {
    let time = captureTime;
    const options = { now: () => time, random: () => 0.5 };
    const queue = await openEventQueue(config, options);
    let reopened: EventQueue | undefined;
    const second = { ...event, eventId: 'event-2' };
    try {
      await queue.enqueue(event);
      await queue.enqueue(second);
      const batch = await claim(queue);
      const originalPut = IDBObjectStore.prototype.put;
      let writes = 0;
      const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        value,
        key,
      ) {
        if (++writes === 2) throw new DOMException('Retry metadata write failed', 'UnknownError');
        return originalPut.call(this, value, key);
      });
      expect(
        await queue.applyResponse(batch.claimId, {
          results: batch.events.map((item, index) => ({
            index,
            status: 'retry',
            eventId: item.eventId,
            code: 'PUBLICATION_UNCONFIRMED',
          })),
        }),
      ).toEqual({ status: 'storage_error' });
      failure.mockRestore();
      reopened = await openEventQueue(config, options);
      expect(await reopened.claimBatch()).toEqual({ status: 'empty' });
      time = batch.expiresAt;
      const recovered = await claim(reopened);
      expect(recovered.events).toEqual([event, second]);
      await retry(reopened, recovered);
      time += 499;
      expect(await reopened.claimBatch()).toEqual({ status: 'empty' });
      time += 1;
      expect((await claim(reopened)).events).toEqual([event, second]);
    } finally {
      queue.close();
      reopened?.close();
    }
  });

  it.each(['indexeddb', 'memory'] as const)(
    'clears retry state on acceptance before the same ID is queued again in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      let time = captureTime;
      const queue = await openEventQueue(config, { now: () => time, random: () => 0.5 });
      try {
        await queue.enqueue(event);
        await retry(queue, await claim(queue));
        time += 500;
        const batch = await claim(queue);
        expect(
          await queue.applyResponse(batch.claimId, {
            results: [{ index: 0, status: 'accepted', eventId: event.eventId }],
          }),
        ).toEqual({ status: 'applied' });
        await queue.enqueue(event);
        await retry(queue, await claim(queue));
        time += 499;
        expect(await queue.claimBatch()).toEqual({ status: 'empty' });
        time += 1;
        expect((await claim(queue)).events).toEqual([event]);
      } finally {
        queue.close();
      }
    },
  );

  it.each(['indexeddb', 'memory'] as const)(
    'counts waiting events toward capacity in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      const queue = await openEventQueue(config, {
        maxEvents: 1,
        memory: { maxEvents: 1 },
        random: () => 0.5,
      });
      try {
        await queue.enqueue(event);
        await retry(queue, await claim(queue));
        expect(await queue.enqueue({ ...event, eventId: 'newer-event' })).toEqual({
          status: 'dropped',
          reason: 'capacity',
        });
        expect(await queue.getAll()).toEqual({ status: 'read', events: [event] });
      } finally {
        queue.close();
      }
    },
  );

  it('preserves retry count and eligibility through reopening without resetting on duplicate enqueue', async () => {
    let time = captureTime;
    const options = { now: () => time, random: () => 0.5 };
    let queue = await openEventQueue(config, options);
    try {
      await queue.enqueue(event);
      await retry(queue, await claim(queue));
      expect(await queue.enqueue({ ...event, eventName: 'changed' })).toEqual({
        status: 'already_queued',
      });
      queue.close();
      queue = await openEventQueue(config, options);
      time += 499;
      expect(await queue.claimBatch()).toEqual({ status: 'empty' });
      time += 1;
      await retry(queue, await claim(queue));
      queue.close();
      queue = await openEventQueue(config, options);
      time += 999;
      expect(await queue.claimBatch()).toEqual({ status: 'empty' });
      time += 1;
      expect((await claim(queue)).events).toEqual([event]);
    } finally {
      queue.close();
    }
  });

  it.each(['indexeddb', 'memory'] as const)(
    'grows the backoff window to five minutes without an attempt cutoff in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      let time = captureTime;
      const queue = await openEventQueue(config, { now: () => time, random: () => 0.5 });
      try {
        await queue.enqueue(event);
        const released = await claim(queue);
        await queue.releaseClaim(released.claimId);
        let batch = await claim(queue);
        for (const window of [
          1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
        ]) {
          await retry(queue, batch);
          time += window / 2 - 1;
          expect(await queue.claimBatch()).toEqual({ status: 'empty' });
          time += 1;
          batch = await claim(queue);
          expect(batch.events).toEqual([event]);
        }
      } finally {
        queue.close();
      }
    },
  );

  describe.each(['indexeddb', 'memory'] as const)('server delays in %s', (mode) => {
    it.each([
      [50, 500],
      [5000, 5000],
      [600_000, 600_000],
    ])(
      'honors server delay %s with eligibility after %s ms',
      async (serverDelay, expectedDelay) => {
        if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
        let time = captureTime;
        const queue = await openEventQueue(config, { now: () => time, random: () => 0.5 });
        try {
          await queue.enqueue(event);
          await retry(queue, await claim(queue), serverDelay);
          time += expectedDelay - 1;
          expect(await queue.claimBatch()).toEqual({ status: 'empty' });
          time += 1;
          expect((await claim(queue)).events).toEqual([event]);
        } finally {
          queue.close();
        }
      },
    );
  });

  it.each([0, 0.999])('uses the full first retry window for random draw %s', async (draw) => {
    let time = captureTime;
    const queue = await openEventQueue(config, { now: () => time, random: () => draw });
    try {
      await queue.enqueue(event);
      await retry(queue, await claim(queue));
      const delay = Math.floor(draw * 1000);
      if (delay > 0) {
        time += delay - 1;
        expect(await queue.claimBatch()).toEqual({ status: 'empty' });
        time += 1;
      }
      expect((await claim(queue)).events).toEqual([event]);
    } finally {
      queue.close();
    }
  });

  it.each(['indexeddb', 'memory'] as const)(
    'lets new events bypass older waiting events in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      let time = captureTime;
      const queue = await openEventQueue(config, { now: () => time, random: () => 0.5 });
      try {
        await queue.enqueue(event);
        await retry(queue, await claim(queue));
        const newer = { ...event, eventId: 'newer-event' };
        await queue.enqueue(newer);
        expect((await claim(queue)).events).toEqual([newer]);
        time += 500;
        expect((await claim(queue)).events).toEqual([event]);
      } finally {
        queue.close();
      }
    },
  );

  it.each(['indexeddb', 'memory'] as const)(
    'expires waiting events at 24 hours and clears their retry state in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      let time = captureTime;
      const queue = await openEventQueue(config, { now: () => time, random: () => 0.5 });
      try {
        await queue.enqueue(event);
        await retry(queue, await claim(queue), 30 * 60 * 60 * 1000);
        time += 24 * 60 * 60 * 1000;
        expect(await queue.claimBatch()).toEqual({ status: 'empty' });
        expect(await queue.getAll()).toEqual({ status: 'read', events: [] });
        const fresh = { ...event, clientTimestamp: new Date(time).toISOString() };
        await queue.enqueue(fresh);
        await retry(queue, await claim(queue));
        time += 499;
        expect(await queue.claimBatch()).toEqual({ status: 'empty' });
        time += 1;
        expect((await claim(queue)).events).toEqual([fresh]);
      } finally {
        queue.close();
      }
    },
  );

  it.each(['indexeddb', 'memory'] as const)(
    'waits for the first jittered eligibility time in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      let time = captureTime;
      const queue = await openEventQueue(config, { now: () => time, random: () => 0.5 });
      try {
        await queue.enqueue(event);
        await retry(queue, await claim(queue));
        expect(await queue.claimBatch()).toEqual({ status: 'empty' });
        time += 499;
        expect(await queue.claimBatch()).toEqual({ status: 'empty' });
        time += 1;
        expect((await claim(queue)).events).toEqual([event]);
      } finally {
        queue.close();
      }
    },
  );
});
