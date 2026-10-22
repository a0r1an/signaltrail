import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsEventSchema } from '@signaltrail/contracts';
import { openEventQueue, type EventQueue } from '../../src/event-queue.ts';

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
const config = { projectKey: 'project-A', ingestionUrl: 'https://ingest.example.com' };
const captureTime = Date.parse(event.clientTimestamp);
const accepted = (eventId: string, index = 0) => ({ index, eventId, status: 'accepted' });

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
  if (result.status !== 'claimed') throw new Error('Expected a batch claim');
  return result;
}

describe('applying batch responses', () => {
  it.each(['indexeddb', 'memory'] as const)(
    'applies concurrent responses only once in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      const queue = await openEventQueue(config);
      try {
        await queue.enqueue(event);
        const batch = await claim(queue);
        const response = { results: [accepted(event.eventId)] };
        const results = await Promise.all([
          queue.applyResponse(batch.claimId, response),
          queue.applyResponse(batch.claimId, response),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual(['applied', 'not_owned']);
        expect(await queue.getAll()).toEqual({ status: 'read', events: [] });
      } finally {
        queue.close();
      }
    },
  );

  it('rechecks lease expiry in the transaction after the initial ownership check', async () => {
    let time = captureTime;
    const queue = await openEventQueue(config, { now: () => time });
    try {
      await queue.enqueue(event);
      const batch = await claim(queue);
      const originalGetAll = IDBIndex.prototype.getAll;
      const advanceClock = vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (
        this: IDBIndex,
        query,
        count,
      ) {
        const request = originalGetAll.call(this, query, count);
        request.addEventListener('success', () => {
          time = batch.expiresAt;
        });
        return request;
      });
      expect(
        await queue.applyResponse(batch.claimId, { results: [accepted(event.eventId)] }),
      ).toEqual({ status: 'not_owned' });
      advanceClock.mockRestore();
      expect(await queue.getAll()).toEqual({ status: 'read', events: [event] });
    } finally {
      queue.close();
    }
  });

  it('rejects response application after the queue is closed', async () => {
    const queue = await openEventQueue(config);
    await queue.enqueue(event);
    const batch = await claim(queue);
    queue.close();
    await expect(
      queue.applyResponse(batch.claimId, { results: [accepted(event.eventId)] }),
    ).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  it.each(['indexeddb', 'memory'] as const)(
    'rejects foreign, released, expired, and replaced claims in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      let time = captureTime;
      const first = await openEventQueue(config, { now: () => time });
      const other = await openEventQueue(config, { now: () => time });
      const response = { results: [accepted(event.eventId)] };
      try {
        await first.enqueue(event);
        const original = await claim(first);
        expect(await other.applyResponse(original.claimId, response)).toEqual({
          status: 'not_owned',
        });
        expect(await first.releaseClaim(original.claimId)).toEqual({ status: 'released' });
        expect(await first.applyResponse(original.claimId, response)).toEqual({
          status: 'not_owned',
        });
        const current = await claim(first);
        time = current.expiresAt;
        expect(await first.applyResponse(current.claimId, response)).toEqual({
          status: 'not_owned',
        });
        const replacement = await claim(first);
        expect(await first.applyResponse(current.claimId, response)).toEqual({
          status: 'not_owned',
        });
        expect(await first.getAll()).toEqual({ status: 'read', events: [event] });
        expect(await first.applyResponse(replacement.claimId, response)).toEqual({
          status: 'applied',
        });
      } finally {
        first.close();
        other.close();
      }
    },
  );

  it.each(['indexeddb', 'memory'] as const)(
    'matches the private original snapshot rather than caller-mutated claim events in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      const queue = await openEventQueue(config);
      try {
        await queue.enqueue(event);
        const batch = await claim(queue);
        batch.events[0]!.eventId = 'tampered';
        expect(
          await queue.applyResponse(batch.claimId, { results: [accepted('tampered')] }),
        ).toEqual({ status: 'invalid_response' });
        expect(
          await queue.applyResponse(batch.claimId, { results: [accepted(event.eventId)] }),
        ).toEqual({ status: 'applied' });
      } finally {
        queue.close();
      }
    },
  );

  it.each(['indexeddb', 'memory'] as const)(
    'does not reinterpret a shortened batch after some events expire in %s',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      let time = captureTime;
      const queue = await openEventQueue(config, { maxAgeMs: 100, now: () => time });
      try {
        await queue.enqueue(event);
        time += 50;
        const second = {
          ...event,
          eventId: 'event-2',
          clientTimestamp: new Date(time).toISOString(),
        };
        await queue.enqueue(second);
        const batch = await claim(queue);
        time += 50;
        expect(await queue.getAll()).toEqual({ status: 'read', events: [second] });
        expect(
          await queue.applyResponse(batch.claimId, { results: [accepted(second.eventId)] }),
        ).toEqual({ status: 'invalid_response' });
        expect(
          await queue.applyResponse(batch.claimId, {
            results: [accepted(event.eventId), accepted(second.eventId, 1)],
          }),
        ).toEqual({ status: 'not_owned' });
        expect(await queue.getAll()).toEqual({ status: 'read', events: [second] });
      } finally {
        queue.close();
      }
    },
  );

  it('reports a failed atomic update, rolls back removals, and preserves the durable claims', async () => {
    let time = captureTime;
    const queue = await openEventQueue(config, { now: () => time });
    let reopened: EventQueue | undefined;
    const second = { ...event, eventId: 'event-2' };
    try {
      await queue.enqueue(event);
      await queue.enqueue(second);
      const batch = await claim(queue);
      const originalDelete = IDBObjectStore.prototype.delete;
      let deletes = 0;
      const failure = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
        this: IDBObjectStore,
        key,
      ) {
        if (++deletes === 3)
          throw new DOMException('Cannot finish response update', 'UnknownError');
        return originalDelete.call(this, key);
      });
      expect(
        await queue.applyResponse(batch.claimId, {
          results: [accepted(event.eventId), accepted(second.eventId, 1)],
        }),
      ).toEqual({ status: 'storage_error' });
      expect(queue.storageMode).toBe('memory');
      failure.mockRestore();
      reopened = await openEventQueue(config, { now: () => time });
      expect(await reopened.getAll()).toEqual({ status: 'read', events: [event, second] });
      expect(await reopened.claimBatch()).toEqual({ status: 'empty' });
      time = batch.expiresAt;
      expect((await claim(reopened)).events).toEqual([event, second]);
    } finally {
      queue.close();
      reopened?.close();
    }
  });

  describe.each(['indexeddb', 'memory'] as const)('response validation in %s', (mode) => {
    it.each([
      ['non-object', null],
      ['empty results', { results: [] }],
      ['unknown status', { results: [{ index: 0, eventId: event.eventId, status: 'approved' }] }],
      ['mismatched ID', { results: [accepted('another-event'), accepted('event-2', 1)] }],
      [
        'mismatched retry ID',
        {
          results: [
            {
              index: 0,
              status: 'retry',
              eventId: 'another-event',
              code: 'PUBLICATION_UNCONFIRMED',
            },
            accepted('event-2', 1),
          ],
        },
      ],
      ['missing result', { results: [accepted(event.eventId)] }],
      ['duplicate index', { results: [accepted(event.eventId), accepted(event.eventId)] }],
      ['out-of-range index', { results: [accepted(event.eventId), accepted('event-2', 2)] }],
    ])('retains the complete batch and its claim for %s', async (_name, response) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      const queue = await openEventQueue(config);
      const second = { ...event, eventId: 'event-2' };
      try {
        await queue.enqueue(event);
        await queue.enqueue(second);
        const batch = await claim(queue);
        expect(await queue.applyResponse(batch.claimId, response)).toEqual({
          status: 'invalid_response',
        });
        expect(await queue.getAll()).toEqual({ status: 'read', events: [event, second] });
        expect(await queue.claimBatch()).toEqual({ status: 'empty' });
        expect(
          await queue.applyResponse(batch.claimId, {
            results: [accepted(event.eventId), accepted(second.eventId, 1)],
          }),
        ).toEqual({ status: 'applied' });
      } finally {
        queue.close();
      }
    });
  });

  it.each(['indexeddb', 'memory'] as const)(
    'applies mixed outcomes by original index in %s, keeping retry entries and unrelated events',
    async (mode) => {
      if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
      const queue = await openEventQueue(config);
      const events = Array.from({ length: 4 }, (_, index) => ({
        ...event,
        eventId: `event-${index}`,
      }));
      try {
        for (const item of events) await queue.enqueue(item);
        const batch = await claim(queue, 3);
        expect(
          await queue.applyResponse(batch.claimId, {
            results: [
              {
                index: 2,
                status: 'retry',
                eventId: events[2]!.eventId,
                code: 'PUBLICATION_UNCONFIRMED',
                retryAfterMs: 1000,
              },
              accepted(events[0]!.eventId, 0),
              { index: 1, status: 'rejected', code: 'INVALID_EVENT' },
            ],
          }),
        ).toEqual({ status: 'applied' });
        expect(await queue.getAll()).toEqual({ status: 'read', events: events.slice(2) });
        expect((await claim(queue)).events).toEqual(events.slice(3));
        vi.setSystemTime(captureTime + 1000);
        expect((await claim(queue)).events).toEqual([events[2]]);
        expect(
          await queue.applyResponse(batch.claimId, { results: [accepted(events[0]!.eventId)] }),
        ).toEqual({ status: 'not_owned' });
      } finally {
        queue.close();
      }
    },
  );

  it('removes an accepted event after a matching response to its owned claim', async () => {
    const queue = await openEventQueue(config);
    try {
      await queue.enqueue(event);
      const batch = await claim(queue);
      expect(
        await queue.applyResponse(batch.claimId, { results: [accepted(event.eventId)] }),
      ).toEqual({ status: 'applied' });
      expect(await queue.getAll()).toEqual({ status: 'read', events: [] });
      expect(await queue.releaseClaim(batch.claimId)).toEqual({ status: 'not_owned' });
    } finally {
      queue.close();
    }
  });
});
