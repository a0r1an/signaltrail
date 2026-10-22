import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsEventSchema } from '@signaltrail/contracts';
import { openBatchTransport } from '../../src/batch-transport.ts';

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
const config = { projectKey: 'project-A', ingestionUrl: 'https://INGEST.example.com:443' };
const acceptedResponse = () =>
  new Response(
    JSON.stringify({ results: [{ index: 0, status: 'accepted', eventId: event.eventId }] }),
    { status: 200 },
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
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

describe('batch upload transport', () => {
  it('applies mixed per-event outcomes and retries only the unresolved event', async () => {
    const second = { ...event, eventId: 'event-2' };
    const third = { ...event, eventId: 'event-3' };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              { index: 0, status: 'accepted', eventId: event.eventId },
              { index: 1, status: 'rejected', code: 'INVALID_EVENT' },
              {
                index: 2,
                status: 'retry',
                eventId: third.eventId,
                code: 'PUBLICATION_UNCONFIRMED',
                retryAfterMs: 1000,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: [{ index: 0, status: 'accepted', eventId: third.eventId }] }),
          { status: 200 },
        ),
      );
    const transport = await openBatchTransport(config, { fetch });
    try {
      for (const item of [event, second, third]) await transport.queue.enqueue(item);
      expect(await transport.flush()).toEqual({ status: 'applied' });
      expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [third] });
      expect(await transport.flush()).toEqual({ status: 'empty' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await transport.flush()).toEqual({ status: 'applied' });
      expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ events: [third] });
    } finally {
      transport.close();
    }
  });

  it('does not apply a response after the claim lease has expired', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      vi.setSystemTime(captureTime + 60_000);
      return acceptedResponse();
    });
    const transport = await openBatchTransport(config, { fetch });
    try {
      await transport.queue.enqueue(event);
      expect(await transport.flush()).toEqual({ status: 'not_owned' });
      expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [event] });
    } finally {
      transport.close();
    }
  });

  it('uses a one-second cooldown when a 429 has no Retry-After header', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 429 }));
    const transport = await openBatchTransport(config, { fetch });
    try {
      await transport.queue.enqueue(event);
      expect((await transport.flush()).status).toBe('retry_scheduled');
      expect(await transport.flush()).toEqual({ status: 'waiting', retryAt: captureTime + 1000 });
    } finally {
      transport.close();
    }
  });

  it('includes a stalled response body in the 15-second deadline', async () => {
    let reading!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    vi.spyOn(Response.prototype, 'json').mockImplementation(() => {
      reading();
      return new Promise<never>(() => {});
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(acceptedResponse());
    const transport = await openBatchTransport(config, { fetch, queue: { random: () => 0.5 } });
    try {
      await transport.queue.enqueue(event);
      const pending = transport.flush();
      await bodyStarted;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toEqual({ status: 'retry_scheduled', reason: 'timeout' });
      expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [event] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      transport.close();
    }
  });

  it('does not apply a successful response that arrives after timeout', async () => {
    let started!: () => void;
    let resolveResponse!: (response: Response) => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => {
        started();
        return new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        });
      })
      .mockResolvedValueOnce(acceptedResponse());
    const transport = await openBatchTransport(config, { fetch, queue: { random: () => 0.5 } });
    try {
      await transport.queue.enqueue(event);
      const pending = transport.flush();
      await requestStarted;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toEqual({ status: 'retry_scheduled', reason: 'timeout' });
      resolveResponse(acceptedResponse());
      await vi.advanceTimersByTimeAsync(0);
      expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [event] });
      await vi.advanceTimersByTimeAsync(500);
      expect(await transport.flush()).toEqual({ status: 'applied' });
    } finally {
      transport.close();
    }
  });

  it('reinitializes after an authentication pause without losing the queued batch', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(acceptedResponse());
    let transport = await openBatchTransport(config, { fetch });
    try {
      await transport.queue.enqueue(event);
      expect((await transport.flush()).status).toBe('paused');
      transport.close();
      transport = await openBatchTransport(config, { fetch });
      expect(transport.deliveryState).toBe('ready');
      expect(await transport.flush()).toEqual({ status: 'applied' });
    } finally {
      transport.close();
    }
  });

  it('uses persisted request-failure backoff after transport reinitialization', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('Offline'))
      .mockResolvedValueOnce(acceptedResponse());
    let transport = await openBatchTransport(config, { fetch, queue: { random: () => 0.5 } });
    try {
      await transport.queue.enqueue(event);
      expect((await transport.flush()).status).toBe('retry_scheduled');
      transport.close();
      transport = await openBatchTransport(config, { fetch, queue: { random: () => 0.5 } });
      expect(await transport.flush()).toEqual({ status: 'empty' });
      await vi.advanceTimersByTimeAsync(500);
      expect(await transport.flush()).toEqual({ status: 'applied' });
    } finally {
      transport.close();
    }
  });

  it('does not fetch for an empty queue or after a storage claim failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = await openBatchTransport(config, { fetch });
    try {
      expect(await transport.flush()).toEqual({ status: 'empty' });
      await transport.queue.enqueue(event);
      vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
        throw new DOMException('Unavailable', 'UnknownError');
      });
      expect(await transport.flush()).toEqual({ status: 'storage_error' });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      transport.close();
    }
  });

  it('retains durable events when applying a successful upload response fails', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(acceptedResponse());
    const transport = await openBatchTransport(config, { fetch });
    let reopened: Awaited<ReturnType<typeof openBatchTransport>> | undefined;
    try {
      await transport.queue.enqueue(event);
      const failure = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => {
        throw new DOMException('Cannot apply acknowledgment', 'UnknownError');
      });
      expect(await transport.flush()).toEqual({ status: 'storage_error' });
      failure.mockRestore();
      reopened = await openBatchTransport(config, { fetch });
      expect(await reopened.queue.getAll()).toEqual({ status: 'read', events: [event] });
    } finally {
      transport.close();
      reopened?.close();
    }
  });

  it('works with the bounded memory fallback when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(acceptedResponse());
    const transport = await openBatchTransport(config, { fetch });
    try {
      expect(transport.queue.storageMode).toBe('memory');
      await transport.queue.enqueue(event);
      expect(await transport.flush()).toEqual({ status: 'applied' });
      expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [] });
    } finally {
      transport.close();
    }
  });

  it('allows only one in-flight flush and aborts it promptly when closed', async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
      signal = init?.signal;
      started();
      return new Promise<Response>(() => {});
    });
    const transport = await openBatchTransport(config, { fetch });
    let pending: ReturnType<typeof transport.flush> | undefined;
    try {
      await transport.queue.enqueue(event);
      pending = transport.flush();
      await requestStarted;
      expect(await transport.flush()).toEqual({ status: 'busy' });
      expect(fetch).toHaveBeenCalledTimes(1);
      transport.close();
      expect(signal?.aborted).toBe(true);
      expect(await pending).toEqual({ status: 'closed' });
      expect(await transport.flush()).toEqual({ status: 'closed' });
      expect(transport.deliveryState).toBe('closed');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      transport.close();
      await pending;
    }
  });

  it.each([
    ['2', 2000],
    [new Date(captureTime + 3000).toUTCString(), 3000],
    ['invalid', 1000],
    ['-1', 1000],
    ['1.5', 1000],
  ])('honors rate-limit cooldown %s for the whole transport', async (header, delay) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { 'Retry-After': header } }),
      )
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(init!.body as string) as { events: { eventId: string }[] };
        return new Response(
          JSON.stringify({
            results: body.events.map((item, index) => ({
              index,
              status: 'accepted',
              eventId: item.eventId,
            })),
          }),
          { status: 200 },
        );
      });
    const transport = await openBatchTransport(config, { fetch, queue: { random: () => 0.5 } });
    try {
      await transport.queue.enqueue(event);
      expect(await transport.flush()).toEqual({
        status: 'retry_scheduled',
        reason: 'rate_limit',
        httpStatus: 429,
      });
      await transport.queue.enqueue({ ...event, eventId: 'newer-event' });
      expect(await transport.flush()).toEqual({ status: 'waiting', retryAt: captureTime + delay });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect((await transport.flush()).status).toBe('waiting');
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await transport.flush()).toEqual({ status: 'applied' });
      expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [] });
    } finally {
      transport.close();
    }
  });

  it.each([
    ['malformed JSON', () => new Response('not-json', { status: 200 })],
    [
      'mismatched response',
      () =>
        new Response(
          JSON.stringify({ results: [{ index: 0, status: 'accepted', eventId: 'wrong-ID' }] }),
          { status: 200 },
        ),
    ],
    ['missing results', () => new Response(JSON.stringify({ results: [] }), { status: 200 })],
  ])('retains the whole batch and backs off for %s', async (_name, response) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(acceptedResponse());
    const transport = await openBatchTransport(config, { fetch, queue: { random: () => 0.5 } });
    try {
      await transport.queue.enqueue(event);
      expect(await transport.flush()).toEqual({
        status: 'retry_scheduled',
        reason: 'invalid_response',
      });
      expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [event] });
      await vi.advanceTimersByTimeAsync(500);
      expect(await transport.flush()).toEqual({ status: 'applied' });
    } finally {
      transport.close();
    }
  });

  it('aborts after 15 seconds and retains the event even if fetch ignores cancellation', async () => {
    let signal: AbortSignal | null | undefined;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
      signal = init?.signal;
      started();
      return new Promise<Response>(() => {});
    });
    const transport = await openBatchTransport(config, { fetch, queue: { random: () => 0.5 } });
    try {
      await transport.queue.enqueue(event);
      const pending = transport.flush();
      await requestStarted;
      await vi.advanceTimersByTimeAsync(14_999);
      expect(signal?.aborted ?? false).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(await pending).toEqual({ status: 'retry_scheduled', reason: 'timeout' });
      expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [event] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      transport.close();
    }
  });

  it.each([500, 502, 503, 504])(
    'retries HTTP %s with stable event IDs and persistent backoff',
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(acceptedResponse());
      const transport = await openBatchTransport(config, { fetch, queue: { random: () => 0.5 } });
      try {
        await transport.queue.enqueue(event);
        expect(await transport.flush()).toEqual({
          status: 'retry_scheduled',
          reason: 'server',
          httpStatus: status,
        });
        expect(await transport.flush()).toEqual({ status: 'empty' });
        await vi.advanceTimersByTimeAsync(500);
        expect(await transport.flush()).toEqual({ status: 'applied' });
        expect(fetch.mock.calls[0]![1]!.body).toBe(fetch.mock.calls[1]![1]!.body);
      } finally {
        transport.close();
      }
    },
  );

  it.each([401, 403, 400])(
    'retains events and pauses on HTTP %s instead of resending',
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(null, { status }));
      const transport = await openBatchTransport(config, { fetch });
      try {
        await transport.queue.enqueue(event);
        const reason =
          status === 413
            ? 'payload_too_large'
            : status === 401 || status === 403
              ? 'authentication'
              : 'unexpected_status';
        expect(await transport.flush()).toEqual({ status: 'paused', reason, httpStatus: status });
        expect(transport.deliveryState).toBe('paused');
        expect(await transport.flush()).toEqual({ status: 'paused', reason, httpStatus: status });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [event] });
      } finally {
        transport.close();
      }
    },
  );

  it('retains stable IDs and schedules backoff after a network failure', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('Offline'))
      .mockResolvedValueOnce(acceptedResponse());
    const transport = await openBatchTransport(config, { fetch, queue: { random: () => 0.5 } });
    try {
      await transport.queue.enqueue(event);
      expect(await transport.flush()).toEqual({ status: 'retry_scheduled', reason: 'network' });
      expect(await transport.flush()).toEqual({ status: 'empty' });
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(await transport.flush()).toEqual({ status: 'applied' });
      expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ events: [event] });
    } finally {
      transport.close();
    }
  });

  it('uploads its claimed batch to its fixed endpoint and key, then applies the response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(acceptedResponse());
    const mutableConfig = { ...config };
    const transport = await openBatchTransport(mutableConfig, { fetch });
    mutableConfig.projectKey = 'project-B';
    mutableConfig.ingestionUrl = 'https://other.example.com';
    try {
      await transport.queue.enqueue(event);
      expect(await transport.flush()).toEqual({ status: 'applied' });
      expect(fetch).toHaveBeenCalledWith(
        'https://ingest.example.com/',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer project-A', 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: [event] }),
        }),
      );
      expect(await transport.queue.getAll()).toEqual({ status: 'read', events: [] });
    } finally {
      transport.close();
    }
  });
});
