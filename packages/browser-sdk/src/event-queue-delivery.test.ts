import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsEventSchema } from '@signaltrail/contracts';
import { openEventQueue } from './event-queue.ts';
const config = { projectKey: 'delivery-inspection', ingestionUrl: 'https://ingest.example.com' };
const event = AnalyticsEventSchema.parse({
  schemaVersion: 1,
  eventId: 'first',
  eventName: 'view',
  distinctId: 'visitor',
  sessionId: 'session',
  clientTimestamp: '2026-10-22T12:00:00.000Z',
  sequence: 0,
  url: 'https://example.com',
  properties: {},
  context: { sdkVersion: '0.1.0' },
});
const time = Date.parse(event.clientTimestamp);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(time);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of await indexedDB.databases())
    if (database.name) await deleteDB(database.name);
});
describe.each(['indexeddb', 'memory'] as const)('%s delivery inspection', (mode) => {
  it('selects an immediate event by ID without leasing its older sibling', async () => {
    if (mode === 'memory') vi.stubGlobal('indexedDB', undefined);
    const queue = await openEventQueue(config);
    try {
      await queue.enqueue(event);
      const urgent = { ...event, eventId: 'urgent' };
      await queue.enqueue(urgent);
      const claim = await queue.claimBatch(1, urgent.eventId);
      expect(claim).toMatchObject({ status: 'claimed', events: [urgent] });
      expect(await queue.inspectDelivery()).toEqual({
        status: 'read',
        events: [event],
        nextEligibleAt: time + 60_000,
      });
    } finally {
      queue.close();
    }
  });
});
