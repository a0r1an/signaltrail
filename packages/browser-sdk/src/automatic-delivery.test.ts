import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnalyticsEventSchema } from '@signaltrail/contracts';
import { openAutomaticDelivery } from './automatic-delivery.ts';

const config = { projectKey: 'automatic', ingestionUrl: 'https://ingest.example.com/events' };
const event = AnalyticsEventSchema.parse({
  schemaVersion: 1,
  eventId: 'one',
  eventName: 'pageview',
  distinctId: 'visitor',
  sessionId: 'session',
  clientTimestamp: '2026-10-22T12:00:00.000Z',
  sequence: 0,
  url: 'https://example.com',
  properties: {},
  context: { sdkVersion: '0.1.0' },
});
const acknowledge = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
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
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(Date.parse(event.clientTimestamp));
  acknowledge.mockClear();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const database of await indexedDB.databases())
    if (database.name) await deleteDB(database.name);
});
it('persists an event and sends it after the batching interval', async () => {
  const delivery = await openAutomaticDelivery(config, { fetch: acknowledge });
  try {
    await delivery.enqueue(event);
    expect(acknowledge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1));
    expect(await delivery.getAll()).toEqual({ status: 'read', events: [] });
  } finally {
    delivery.close();
  }
});
it('bypasses the timer for an immediate event while keeping older events queued', async () => {
  const delivery = await openAutomaticDelivery(config, { fetch: acknowledge });
  try {
    await delivery.enqueue(event);
    await delivery.enqueue({ ...event, eventId: 'urgent' }, { sendImmediately: true });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(JSON.parse(acknowledge.mock.calls[0]![1]!.body as string)).toEqual({
      events: [{ ...event, eventId: 'urgent' }],
    });
    expect(await delivery.getAll()).toEqual({ status: 'read', events: [event] });
  } finally {
    delivery.close();
  }
});
it('flushes as soon as 100 eligible events accumulate', async () => {
  const delivery = await openAutomaticDelivery(config, { fetch: acknowledge });
  try {
    for (let index = 0; index < 100; index++)
      await delivery.enqueue({ ...event, eventId: `event-${index}` });
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1));
    expect(
      (JSON.parse(acknowledge.mock.calls[0]![1]!.body as string) as { events: unknown[] }).events,
    ).toHaveLength(100);
  } finally {
    delivery.close();
  }
});
it('automatically retries at the persisted eligibility time without waiting another batch interval', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockImplementation(acknowledge);
  const delivery = await openAutomaticDelivery(config, { fetch, queue: { random: () => 0.5 } });
  try {
    await delivery.enqueue(event, { sendImmediately: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () =>
      expect(await delivery.getAll()).toEqual({ status: 'read', events: [] }),
    );
  } finally {
    delivery.close();
  }
});
it('resumes persisted eligible backlog immediately after initialization', async () => {
  const { openEventQueue } = await import('./event-queue.ts');
  const queue = await openEventQueue(config);
  await queue.enqueue(event);
  queue.close();
  const delivery = await openAutomaticDelivery(config, { fetch: acknowledge });
  try {
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1));
  } finally {
    delivery.close();
  }
});
it('sends a prepared beacon when the document becomes hidden and retains events', async () => {
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  const sendBeacon = vi.fn().mockReturnValue(true);
  const delivery = await openAutomaticDelivery(config, {
    fetch: acknowledge,
    document,
    sendBeacon,
  });
  try {
    await delivery.enqueue(event);
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0]![0]).toBe(config.ingestionUrl);
    const body = sendBeacon.mock.calls[0]![1] as Blob;
    expect(body.type).toBe('text/plain;charset=utf-8');
    expect(JSON.parse(await body.text())).toEqual({
      projectKey: config.projectKey,
      events: [event],
    });
    expect(await delivery.getAll()).toEqual({ status: 'read', events: [event] });
    expect(acknowledge).not.toHaveBeenCalled();
  } finally {
    delivery.close();
  }
});
it('sends an immediate event queued during an active request without an extra timer delay', async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    )
    .mockImplementation(acknowledge);
  const delivery = await openAutomaticDelivery(config, { fetch });
  try {
    const first = delivery.enqueue(event, { sendImmediately: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await delivery.enqueue({ ...event, eventId: 'urgent-two' }, { sendImmediately: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(Response.json({ results: [{ index: 0, eventId: event.eventId, status: 'accepted' }] }));
    await first;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string).events[0].eventId).toBe(
      'urgent-two',
    );
  } finally {
    delivery.close();
  }
});
it('keeps later immediate events urgent across a failed earlier immediate request', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockImplementation(acknowledge);
  const delivery = await openAutomaticDelivery(config, { fetch, queue: { random: () => 0.5 } });
  try {
    await delivery.enqueue(event, { sendImmediately: true });
    await delivery.enqueue({ ...event, eventId: 'other' }, { sendImmediately: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(fetch.mock.calls[1]![1]!.body as string).events.map(
        (item: { eventId: string }) => item.eventId,
      ),
    ).toEqual(['other']);
  } finally {
    delivery.close();
  }
});
it('honors a rate-limit cooldown for immediate sends and departure beacons', async () => {
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  const sendBeacon = vi.fn().mockReturnValue(true);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '10' } }))
    .mockImplementation(acknowledge);
  const delivery = await openAutomaticDelivery(config, { fetch, document, sendBeacon });
  try {
    await delivery.enqueue(event, { sendImmediately: true });
    await delivery.enqueue({ ...event, eventId: 'other' }, { sendImmediately: true });
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  } finally {
    delivery.close();
  }
});
it('keeps events when the browser refuses or throws during a beacon send', async () => {
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'hidden' as DocumentVisibilityState,
  });
  const sendBeacon = vi
    .fn()
    .mockReturnValueOnce(false)
    .mockImplementationOnce(() => {
      throw new Error('beacon unavailable');
    });
  const delivery = await openAutomaticDelivery(config, {
    fetch: acknowledge,
    document,
    sendBeacon,
  });
  try {
    await delivery.enqueue(event);
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(2);
    expect(await delivery.getAll()).toEqual({ status: 'read', events: [event] });
    await delivery.flush();
    expect(await delivery.getAll()).toEqual({ status: 'read', events: [] });
  } finally {
    delivery.close();
  }
});
it('deduplicates hidden/pagehide signals and resets after the page becomes visible', async () => {
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  const page = new EventTarget();
  const sendBeacon = vi.fn().mockReturnValue(true);
  const delivery = await openAutomaticDelivery(config, {
    fetch: acknowledge,
    document,
    page,
    sendBeacon,
  });
  try {
    await delivery.enqueue(event);
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    page.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  } finally {
    delivery.close();
  }
});
it('bounds beacon UTF-8 payload size and retains events that do not fit', async () => {
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  const sendBeacon = vi.fn().mockReturnValue(true);
  const delivery = await openAutomaticDelivery(config, {
    fetch: acknowledge,
    document,
    sendBeacon,
  });
  const large = { ...event, eventId: 'large', properties: { text: '🚀'.repeat(17000) } };
  try {
    await delivery.enqueue(large);
    await delivery.enqueue(event);
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = sendBeacon.mock.calls[0]![1] as Blob;
    expect(body.size).toBeLessThanOrEqual(60 * 1024);
    expect(JSON.parse(await body.text()).events).toEqual([event]);
    expect(await delivery.getAll()).toEqual({ status: 'read', events: [large, event] });
  } finally {
    delivery.close();
  }
});
it('drains a full batch accumulated during an upload as soon as that upload finishes', async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    )
    .mockImplementation(acknowledge);
  const delivery = await openAutomaticDelivery(config, { fetch });
  try {
    const first = delivery.enqueue(event, { sendImmediately: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 100; i++) await delivery.enqueue({ ...event, eventId: `next-${i}` });
    resolve(Response.json({ results: [{ index: 0, eventId: event.eventId, status: 'accepted' }] }));
    await first;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  } finally {
    delivery.close();
  }
});
it('removes timers and lifecycle listeners on close while retaining the durable queue', async () => {
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  const page = new EventTarget();
  const sendBeacon = vi.fn().mockReturnValue(true);
  const delivery = await openAutomaticDelivery(config, {
    fetch: acknowledge,
    document,
    page,
    sendBeacon,
  });
  await delivery.enqueue(event);
  delivery.close();
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  page.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(5000);
  expect(sendBeacon).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(await delivery.flush()).toEqual({ status: 'closed' });
  await expect(delivery.enqueue(event)).rejects.toMatchObject({ name: 'InvalidStateError' });
  const { openEventQueue } = await import('./event-queue.ts');
  const queue = await openEventQueue(config);
  try {
    expect(await queue.getAll()).toEqual({ status: 'read', events: [event] });
  } finally {
    queue.close();
  }
});
it('never sends retry-delayed events in a departure beacon', async () => {
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  const sendBeacon = vi.fn().mockReturnValue(true);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null, { status: 503 }));
  const delivery = await openAutomaticDelivery(config, {
    fetch,
    document,
    sendBeacon,
    queue: { random: () => 0.5 },
  });
  try {
    await delivery.enqueue(event, { sendImmediately: true });
    await delivery.enqueue({ ...event, eventId: 'new' });
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await (sendBeacon.mock.calls[0]![1] as Blob).text()).events.map(
        (item: { eventId: string }) => item.eventId,
      ),
    ).toEqual(['new']);
  } finally {
    delivery.close();
  }
});
it('does not beacon events currently leased by another queue connection', async () => {
  const { openEventQueue } = await import('./event-queue.ts');
  const queue = await openEventQueue(config);
  await queue.enqueue(event);
  await queue.claimBatch();
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'hidden' as DocumentVisibilityState,
  });
  const sendBeacon = vi.fn().mockReturnValue(true);
  const delivery = await openAutomaticDelivery(config, {
    fetch: acknowledge,
    document,
    sendBeacon,
  });
  try {
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999);
    expect(acknowledge).not.toHaveBeenCalled();
  } finally {
    queue.close();
    delivery.close();
  }
});
it('stops automatic and beacon sends while authentication is paused', async () => {
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  const sendBeacon = vi.fn().mockReturnValue(true);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null, { status: 401 }));
  const delivery = await openAutomaticDelivery(config, { fetch, document, sendBeacon });
  try {
    await delivery.enqueue(event, { sendImmediately: true });
    await delivery.enqueue({ ...event, eventId: 'new' });
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    delivery.close();
  }
});
it('rechecks expiry before sending an already prepared beacon', async () => {
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  const sendBeacon = vi.fn().mockReturnValue(true);
  const delivery = await openAutomaticDelivery(config, {
    fetch: acknowledge,
    document,
    sendBeacon,
    queue: { maxAgeMs: 1000 },
  });
  try {
    await delivery.enqueue(event);
    vi.setSystemTime(Date.parse(event.clientTimestamp) + 1000);
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).not.toHaveBeenCalled();
  } finally {
    delivery.close();
  }
});
it('aborts an in-flight automatic request when closed and leaves its persisted event intact', async () => {
  let signal: AbortSignal | null | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  });
  const delivery = await openAutomaticDelivery(config, { fetch });
  const pending = delivery.enqueue(event, { sendImmediately: true });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  delivery.close();
  expect(signal?.aborted).toBe(true);
  expect(await pending).toEqual({ status: 'queued' });
  expect(vi.getTimerCount()).toBe(0);
});
it('uses the configured batching interval without requiring browser globals', async () => {
  const delivery = await openAutomaticDelivery(config, {
    fetch: acknowledge,
    flushIntervalMs: 250,
  });
  try {
    await delivery.enqueue(event);
    await vi.advanceTimersByTimeAsync(249);
    expect(acknowledge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1));
  } finally {
    delivery.close();
  }
});
