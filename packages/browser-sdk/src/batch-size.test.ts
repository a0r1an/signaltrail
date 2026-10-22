import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnalyticsEventSchema } from '@signaltrail/contracts';
import { openBatchTransport } from './batch-transport.ts';
const config = { projectKey: 'batch-size', ingestionUrl: 'https://ingest.example.com/events' };
const event = AnalyticsEventSchema.parse({
  schemaVersion: 1,
  eventId: 'first',
  eventName: 'view',
  distinctId: 'visitor',
  sessionId: 'session',
  clientTimestamp: '2026-10-22T12:00:00.000Z',
  sequence: 0,
  url: 'https://example.com',
  properties: { text: '🚀'.repeat(20) },
  context: { sdkVersion: '0.1.0' },
});
const bytes = (events: unknown[]) =>
  new TextEncoder().encode(JSON.stringify({ events })).byteLength;
const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
  const body = JSON.parse(init!.body as string) as { events: { eventId: string }[] };
  return Response.json({
    results: body.events.map((item, index) => ({
      index,
      eventId: item.eventId,
      status: 'accepted',
    })),
  });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(event.clientTimestamp));
  fetch.mockClear();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const database of await indexedDB.databases())
    if (database.name) await deleteDB(database.name);
});
it('limits each complete UTF-8 request body while retaining events for later batches', async () => {
  const second = { ...event, eventId: 'other' };
  const maxRequestBytes = bytes([event]);
  const transport = await openBatchTransport(config, { fetch, maxRequestBytes });
  try {
    await transport.queue.enqueue(event);
    await transport.queue.enqueue(second);
    expect(await transport.flush()).toEqual({ status: 'applied' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new TextEncoder().encode(fetch.mock.calls[0]![1]!.body as string).byteLength).toBe(
      maxRequestBytes,
    );
    expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [second] });
    expect(await transport.flush()).toEqual({ status: 'applied' });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    transport.close();
  }
});
it('reduces a 413 batch and independently acknowledges smaller requests with unchanged IDs', async () => {
  const send = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 413 }))
    .mockImplementation(fetch);
  const transport = await openBatchTransport(config, { fetch: send });
  const events = [event, { ...event, eventId: 'second' }, { ...event, eventId: 'third' }];
  try {
    for (const item of events) await transport.queue.enqueue(item);
    expect(await transport.flush()).toMatchObject({ status: 'batch_resized' });
    expect(transport.deliveryState).toBe('ready');
    expect(await transport.queue.getAll()).toEqual({ status: 'read', events });
    for (const item of events) {
      expect(await transport.flush()).toEqual({ status: 'applied' });
      expect(JSON.parse(send.mock.calls.at(-1)![1]!.body as string)).toEqual({ events: [item] });
    }
    expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [] });
  } finally {
    transport.close();
  }
});
it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid byte limit %s before opening storage or fetching',
  async (maxRequestBytes) => {
    await expect(openBatchTransport(config, { fetch, maxRequestBytes })).rejects.toThrow(
      RangeError,
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);
it('rejects an oversized event before enqueueing without sending a request', async () => {
  const transport = await openBatchTransport(config, {
    fetch,
    maxRequestBytes: bytes([event]) - 1,
  });
  try {
    expect(await transport.queue.enqueue(event)).toEqual({
      status: 'dropped',
      reason: 'event_too_large',
    });
    expect(await transport.flush()).toEqual({ status: 'empty' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [] });
  } finally {
    transport.close();
  }
});

it('drops only an event rejected with 413 when alone and continues with its sibling', async () => {
  const send = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 413 }))
    .mockImplementation(fetch);
  const transport = await openBatchTransport(config, { fetch: send });
  const second = { ...event, eventId: 'second' };
  try {
    await transport.queue.enqueue(event);
    await transport.queue.enqueue(second);
    expect(await transport.flush(event.eventId)).toEqual({
      status: 'dropped',
      reason: 'event_too_large',
      eventId: event.eventId,
      source: 'server_413',
    });
    expect(transport.deliveryState).toBe('ready');
    expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [second] });
    expect(await transport.flush()).toEqual({ status: 'applied' });
  } finally {
    transport.close();
  }
});
it('discards a previously persisted event that no longer fits after lowering the limit', async () => {
  const { openEventQueue } = await import('./event-queue.ts');
  const raw = await openEventQueue(config);
  await raw.enqueue(event);
  raw.close();
  const transport = await openBatchTransport(config, {
    fetch,
    maxRequestBytes: bytes([event]) - 1,
  });
  try {
    expect(await transport.flush()).toEqual({
      status: 'dropped',
      reason: 'event_too_large',
      eventId: event.eventId,
      source: 'client_limit',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [] });
  } finally {
    transport.close();
  }
});
it('reports an oversized event through a callback even when automatic delivery owns the flush', async () => {
  const { openAutomaticDelivery } = await import('./automatic-delivery.ts');
  const onEventDropped = vi.fn();
  const delivery = await openAutomaticDelivery(config, {
    fetch,
    maxRequestBytes: bytes([event]) - 1,
    onEventDropped,
  });
  try {
    expect(await delivery.enqueue(event, { sendImmediately: true })).toEqual({
      status: 'dropped',
      reason: 'event_too_large',
    });
    expect(onEventDropped).toHaveBeenCalledExactlyOnceWith({
      eventId: event.eventId,
      reason: 'event_too_large',
      source: 'client_limit',
    });
    expect(await delivery.getAll()).toEqual({ status: 'read', events: [] });
  } finally {
    delivery.close();
  }
});
it('reports a server-side oversized drop only after durable removal succeeds', async () => {
  const onEventDropped = vi.fn();
  const send = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null, { status: 413 }));
  const transport = await openBatchTransport(config, { fetch: send, onEventDropped });
  try {
    await transport.queue.enqueue(event);
    const failure = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => {
      throw new DOMException('write failed', 'UnknownError');
    });
    expect(await transport.flush()).toEqual({ status: 'storage_error' });
    expect(onEventDropped).not.toHaveBeenCalled();
    failure.mockRestore();
    const { openEventQueue } = await import('./event-queue.ts');
    const reopened = await openEventQueue(config);
    try {
      expect(await reopened.getAll()).toEqual({ status: 'read', events: [event] });
    } finally {
      reopened.close();
    }
  } finally {
    transport.close();
  }
});
it('isolates throwing or rejected drop diagnostics from delivery', async () => {
  const onEventDropped = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('diagnostic failed');
    })
    .mockRejectedValueOnce(new Error('async diagnostic failed'));
  const transport = await openBatchTransport(config, {
    fetch,
    maxRequestBytes: bytes([event]) - 1,
    onEventDropped,
  });
  try {
    expect(await transport.queue.enqueue(event)).toEqual({
      status: 'dropped',
      reason: 'event_too_large',
    });
    expect(await transport.queue.enqueue(event)).toEqual({
      status: 'dropped',
      reason: 'event_too_large',
    });
    expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [] });
    expect(onEventDropped).toHaveBeenCalledTimes(2);
  } finally {
    transport.close();
  }
});
it('enforces the pre-enqueue request limit in memory fallback as well', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const transport = await openBatchTransport(config, {
    fetch,
    maxRequestBytes: bytes([event]) - 1,
  });
  try {
    expect(transport.queue.storageMode).toBe('memory');
    expect(await transport.queue.enqueue(event)).toEqual({
      status: 'dropped',
      reason: 'event_too_large',
    });
    expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [] });
  } finally {
    transport.close();
  }
});
it('does not drop a 413 event after its upload lease expires', async () => {
  const onEventDropped = vi.fn();
  const send = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
    vi.setSystemTime(Date.parse(event.clientTimestamp) + 60_000);
    return new Response(null, { status: 413 });
  });
  const transport = await openBatchTransport(config, { fetch: send, onEventDropped });
  try {
    await transport.queue.enqueue(event);
    expect(await transport.flush()).toEqual({ status: 'not_owned' });
    expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [event] });
    expect(onEventDropped).not.toHaveBeenCalled();
  } finally {
    transport.close();
  }
});
