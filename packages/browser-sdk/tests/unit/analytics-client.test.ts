import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnalyticsEventSchema } from '@signaltrail/contracts';
import { openAnalyticsClient } from '../../src/analytics-client.ts';
import { openEventQueue } from '../../src/event-queue.ts';
const config = { projectKey: 'capture', ingestionUrl: 'https://ingest.example.com/events' };
const timestamp = '2026-11-05T12:00:00.000Z';
const getUrl = () =>
  'https://example.com/products?email=private&utm_source=email&utm_campaign=launch#token';
const send = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
  const body = JSON.parse(init!.body as string) as { events: { eventId: string }[] };
  return Response.json({
    results: body.events.map((event, index) => ({
      index,
      eventId: event.eventId,
      status: 'accepted',
    })),
  });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date(timestamp));
  send.mockClear();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const db of await indexedDB.databases()) if (db.name) await deleteDB(db.name);
});
it('builds a validated anonymous event with sanitized URL/campaign and delivers after batching', async () => {
  const client = await openAnalyticsClient(config, { getUrl, fetch: send });
  try {
    const result = await client.track('product_viewed', { productId: '123' });
    expect(result.status).toBe('queued');
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const body = JSON.parse(send.mock.calls[0]![1]!.body as string) as { events: unknown[] };
    const event = AnalyticsEventSchema.parse(body.events[0]);
    expect(event).toEqual({
      schemaVersion: 1,
      eventId: expect.any(String),
      eventName: 'product_viewed',
      properties: { productId: '123' },
      distinctId: expect.any(String),
      sessionId: expect.any(String),
      sequence: 0,
      clientTimestamp: timestamp,
      url: 'https://example.com/products',
      context: { sdkVersion: '0.1.0', campaign: { utm_source: 'email', utm_campaign: 'launch' } },
    });
    expect(result).toMatchObject({ eventId: event.eventId });
  } finally {
    client.close();
  }
});
async function queued() {
  const queue = await openEventQueue(config);
  try {
    const result = await queue.getAll();
    if (result.status !== 'read') throw new Error('fixture queue unavailable');
    return result.events;
  } finally {
    queue.close();
  }
}
it('snapshots properties, URL and immediate mode before asynchronous storage', async () => {
  let url = 'https://example.com/first?utm_source=first';
  const client = await openAnalyticsClient(config, { getUrl: () => url, fetch: send });
  try {
    const properties = { nested: { value: 'original' } };
    const capture = { sendImmediately: false };
    const pending = client.track('page_viewed', properties, capture);
    properties.nested.value = 'changed';
    url = 'https://example.com/second';
    capture.sendImmediately = true;
    expect((await pending).status).toBe('queued');
    expect(send).not.toHaveBeenCalled();
    expect((await queued())[0]).toMatchObject({
      properties: { nested: { value: 'original' } },
      url: 'https://example.com/first',
      context: { campaign: { utm_source: 'first' } },
    });
  } finally {
    client.close();
  }
});
it.each([
  ['', {}],
  ['bad', { value: undefined }],
  ['bad', { value: Infinity }],
])('rejects invalid capture before allocating session activity: %s', async (name, properties) => {
  const client = await openAnalyticsClient(config, { getUrl, fetch: send });
  try {
    expect(await client.track(name, properties as Record<string, never>)).toEqual({
      status: 'invalid_event',
    });
    expect((await queued()).length).toBe(0);
    await client.track('valid');
    expect((await queued())[0]!.sequence).toBe(0);
  } finally {
    client.close();
  }
});
it('handles cyclic properties and throwing URL providers without raw errors', async () => {
  const client = await openAnalyticsClient(config, {
    getUrl: () => {
      throw new Error('private source');
    },
    fetch: send,
  });
  try {
    expect(await client.track('valid')).toEqual({ status: 'invalid_event' });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(await client.track('valid', cycle as Record<string, never>)).toEqual({
      status: 'invalid_event',
    });
    expect(await queued()).toEqual([]);
  } finally {
    client.close();
  }
});
it('supports immediate send while a previous event stays batched', async () => {
  const client = await openAnalyticsClient(config, { getUrl, fetch: send });
  try {
    await client.track('ordinary');
    const urgent = await client.track('urgent', {}, { sendImmediately: true });
    expect(urgent.status).toBe('queued');
    expect(send).toHaveBeenCalledTimes(1);
    expect((await queued()).map((event) => event.eventName)).toEqual(['ordinary']);
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toMatchObject({
      events: [{ eventName: 'urgent', sequence: 1 }],
    });
  } finally {
    client.close();
  }
});
it('retains the same event ID and captured campaign across a network retry', async () => {
  send.mockRejectedValueOnce(new TypeError('offline'));
  const client = await openAnalyticsClient(config, {
    getUrl,
    fetch: send,
    queue: { random: () => 0.5 },
  });
  try {
    const result = await client.track('purchase', {}, { sendImmediately: true });
    expect(result.status).toBe('queued');
    const before = JSON.parse(send.mock.calls[0]![1]!.body as string) as unknown;
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(JSON.parse(send.mock.calls[1]![1]!.body as string)).toEqual(before);
  } finally {
    client.close();
  }
});
it('shares visitor/session and sequence across clients and reset preserves queued history', async () => {
  const first = await openAnalyticsClient(config, { getUrl, fetch: send });
  const second = await openAnalyticsClient(config, { getUrl, fetch: send });
  try {
    await Promise.all([first.track('one'), second.track('two')]);
    const old = await queued();
    expect(new Set(old.map((event) => event.distinctId)).size).toBe(1);
    expect(new Set(old.map((event) => event.sessionId)).size).toBe(1);
    expect(old.map((event) => event.sequence).sort()).toEqual([0, 1]);
    expect(await second.reset()).toEqual({ status: 'reset' });
    await first.track('after_reset');
    const all = await queued();
    expect(all.slice(0, 2)).toEqual(old);
    expect(all[2]!.distinctId).not.toBe(old[0]!.distinctId);
    expect(all[2]!.sessionId).not.toBe(old[0]!.sessionId);
    expect(all[2]!.sequence).toBe(0);
  } finally {
    first.close();
    second.close();
  }
});
it('does not create a new identity/session when campaigns change', async () => {
  let url = 'https://example.com/?utm_source=google';
  const client = await openAnalyticsClient(config, { getUrl: () => url, fetch: send });
  try {
    await client.track('first');
    url = 'https://example.com/?utm_source=email';
    await client.track('second');
    const events = await queued();
    expect(events[0]!.distinctId).toBe(events[1]!.distinctId);
    expect(events[0]!.sessionId).toBe(events[1]!.sessionId);
    expect(events.map((event) => event.context.campaign)).toEqual([
      { utm_source: 'google' },
      { utm_source: 'email' },
    ]);
  } finally {
    client.close();
  }
});
it('reports failed identity writes and reset without sending new events', async () => {
  const client = await openAnalyticsClient(config, { getUrl, fetch: send });
  try {
    const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new Error('private detail');
    });
    expect(await client.track('valid')).toEqual({ status: 'identity_unavailable' });
    expect(await client.reset()).toEqual({ status: 'identity_unavailable' });
    fail.mockRestore();
    expect(await queued()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  } finally {
    client.close();
  }
});
it('closes idempotently and rejects subsequent captures and resets', async () => {
  const client = await openAnalyticsClient(config, { getUrl, fetch: send });
  client.close();
  client.close();
  expect(await client.track('later')).toEqual({ status: 'closed' });
  expect(await client.reset()).toEqual({ status: 'closed' });
  expect(client.deliveryState).toBe('closed');
  expect(await client.flush()).toEqual({ status: 'closed' });
});
it('closes identity resources if delivery initialization fails', async () => {
  await expect(openAnalyticsClient(config, { getUrl, flushIntervalMs: 0 })).rejects.toThrow(
    'Analytics client initialization failed',
  );
  // afterEach deletes every fixture database; a leaked connection would block it.
});
it('preserves queue size/drop policies and reports oversize capture with its event ID', async () => {
  const client = await openAnalyticsClient(config, { getUrl, fetch: send, maxRequestBytes: 512 });
  try {
    const result = await client.track('large', { padding: 'a'.repeat(1000) });
    expect(result).toMatchObject({
      status: 'dropped',
      reason: 'event_too_large',
      eventId: expect.any(String),
    });
    expect(await queued()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  } finally {
    client.close();
  }
});
it('captures identified events and preserves anonymous history across logout', async () => {
  const client = await openAnalyticsClient(config, { getUrl, fetch: send });
  try {
    await client.track('before');
    const before = (await queued())[0]!;
    expect(await client.identify('customer-1')).toEqual({ status: 'identified', changed: true });
    await client.track('after');
    const after = (await queued()).find((event) => event.eventName === 'after')!;
    expect(after.distinctId).toBe('customer-1');
    expect(after.context.identity).toEqual({
      kind: 'identified',
      anonymousId: before.distinctId,
      userId: 'customer-1',
    });
    await client.reset();
    await client.track('logout');
    const events = await queued();
    expect(events.find((event) => event.eventName === 'before')).toEqual(before);
    expect(events.find((event) => event.eventName === 'logout')!.distinctId).not.toBe(
      before.distinctId,
    );
    expect(events.find((event) => event.eventName === 'logout')!.context.identity).toBeUndefined();
  } finally {
    client.close();
  }
});
it('retains a stable link across reopening until a validated acceptance is received', async () => {
  let client = await openAnalyticsClient(config, { getUrl, fetch: send });
  try {
    await client.identify('customer-1');
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(async () =>
      expect((await queued()).some((event) => event.eventName === '$identify')).toBe(true),
    );
    await client.flush();
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    const sent = send.mock.calls.flatMap(
      (call) =>
        (
          JSON.parse(call[1]!.body as string) as {
            events: ReturnType<typeof AnalyticsEventSchema.parse>[];
          }
        ).events,
    );
    expect(sent.filter((event) => event.eventName === '$identify')).toHaveLength(1);
    await vi.waitFor(async () => {
      const { openIdentityStore } = await import('../../src/identity-store.ts');
      const store = await openIdentityStore(config);
      try {
        expect(await store.pendingLinks()).toEqual([]);
      } finally {
        store.close();
      }
    });
    client.close();
    send.mockClear();
    client = await openAnalyticsClient(config, { getUrl, fetch: send });
    await vi.advanceTimersByTimeAsync(4000);
    expect(send).not.toHaveBeenCalled();
  } finally {
    client.close();
  }
});
it('rejects reserved control names and invalid user IDs without identifying the visitor', async () => {
  const client = await openAnalyticsClient(config, { getUrl, fetch: send });
  try {
    expect(await client.identify(' ')).toEqual({ status: 'invalid_user' });
    expect(await client.track('$identify')).toEqual({ status: 'invalid_event' });
    await client.track('normal');
    expect((await queued())[0]!.context.identity).toBeUndefined();
  } finally {
    client.close();
  }
});
