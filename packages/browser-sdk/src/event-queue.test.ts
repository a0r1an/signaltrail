import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { AnalyticsEventSchema } from '@signaltrail/contracts';
import { openEventQueue } from './event-queue.ts';

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

describe('event queue', () => {
  it('preserves an event after closing and reopening the connection', async () => {
    const databaseName = 'signaltrail-queue-reopen-test';
    let queue = await openEventQueue(databaseName);

    try {
      await queue.enqueue(validEvent);
      queue.close();

      queue = await openEventQueue(databaseName);

      expect(await queue.getAll()).toEqual([validEvent]);
    } finally {
      queue.close();
      await deleteDB(databaseName);
    }
  });

  it('returns events in enqueue order rather than eventId order', async () => {
    const databaseName = 'signaltrail-queue-order-test';
    const queue = await openEventQueue(databaseName);

    const first = { ...validEvent, eventId: 'event-z', sequence: 0 };
    const second = { ...validEvent, eventId: 'event-a', sequence: 1 };

    try {
      await queue.enqueue(first);
      await queue.enqueue(second);

      expect(await queue.getAll()).toEqual([first, second]);
    } finally {
      queue.close();
      await deleteDB(databaseName);
    }
  });

  it('drops a new event at capacity and preserves older events', async () => {
    const databaseName = 'signaltrail-queue-capacity-test';
    const queue = await openEventQueue(databaseName, { maxEvents: 2 });

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

      expect(await queue.getAll()).toEqual([first, second]);
    } finally {
      queue.close();
      await deleteDB(databaseName);
    }
  });

  it('enforces capacity across concurrent queue connections', async () => {
    const databaseName = 'signaltrail-queue-concurrent-capacity-test';
    const firstQueue = await openEventQueue(databaseName, { maxEvents: 1 });
    const secondQueue = await openEventQueue(databaseName, { maxEvents: 1 });

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
      expect(await firstQueue.getAll()).toHaveLength(1);
    } finally {
      firstQueue.close();
      secondQueue.close();
      await deleteDB(databaseName);
    }
  });
});
