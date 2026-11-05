import { expect, it, vi } from 'vitest';
import { createQueryClient, type QueryClientOptions } from '../../src/query-client.ts';

const window = { projectId: 'trusted', from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' };
const event = {
  eventId: 'event-1',
  eventName: 'view',
  sessionId: 'session',
  sequence: '18446744073709551615',
  receivedAt: '2026-11-01T12:00:00.000Z',
};
const response = (body: unknown) =>
  Response.json(body, { headers: { 'cache-control': 'no-store' } });

it('calls injected session-aware fetch and preserves an exact count string', async () => {
  const send = vi.fn<typeof fetch>(async () => response({ count: '18446744073709551615' }));
  const client = createQueryClient({ endpoint: 'https://query.invalid/', fetch: send });
  expect(await client.countReceivedEvents(window)).toEqual({ count: '18446744073709551615' });
  const [target, options] = send.mock.calls[0]!;
  expect(new URL(String(target)).pathname).toBe('/v1/analytics/count');
  expect(new URL(String(target)).searchParams.get('projectId')).toBe('trusted');
  expect(options?.method).toBe('GET');
  expect(options?.cache).toBe('no-store');
  expect(options?.redirect).toBe('error');
  expect(new Headers(options?.headers).has('Authorization')).toBe(false);
});

it('preserves a reduced page and opaque cursor with exact filter encoding', async () => {
  const page = { events: [event], hasMore: true, nextCursor: 'opaque-cursor' };
  const send = vi.fn<typeof fetch>(async () => response(page));
  const client = createQueryClient({ endpoint: 'https://query.invalid/api', fetch: send });
  expect(
    await client.listReceivedEvents({
      ...window,
      limit: 100,
      eventName: " viewed\n'",
      sessionId: 'session\\literal',
      cursor: 'previous-cursor',
    }),
  ).toEqual(page);
  const target = new URL(String(send.mock.calls[0]![0]));
  expect(target.pathname).toBe('/api/v1/analytics/events');
  expect(target.searchParams.get('eventName')).toBe(" viewed\n'");
  expect(target.searchParams.get('sessionId')).toBe('session\\literal');
  expect(target.searchParams.get('cursor')).toBe('previous-cursor');
});

it.each([
  { count: 7 },
  { count: '01' },
  { count: '18446744073709551616' },
  { count: '1', privateSql: 'secret' },
])('rejects incompatible count data privately', async (body) => {
  const client = createQueryClient({
    endpoint: 'https://query.invalid',
    fetch: async () => response(body),
  });
  await expect(client.countReceivedEvents(window)).rejects.toThrow(
    'Analytics response was not confirmed',
  );
});

it('rejects list data containing private extra fields', async () => {
  const client = createQueryClient({
    endpoint: 'https://query.invalid',
    fetch: async () =>
      response({ events: [{ ...event, url: 'https://private.invalid' }], hasMore: false }),
  });
  await expect(client.listReceivedEvents(window)).rejects.toThrow(
    'Analytics response was not confirmed',
  );
});

it.each([
  { endpoint: 'not-a-url' },
  { endpoint: 'file:///tmp/query' },
  { endpoint: 'https://user:secret@query.invalid' },
  { endpoint: 'https://query.invalid/?key=secret' },
  { endpoint: 'https://query.invalid/#fragment' },
  { fetch: undefined },
  { timeoutMs: 0 },
  { timeoutMs: 30001 },
  { maxConcurrentRequests: 0 },
  { maxConcurrentRequests: 33 },
])('rejects invalid client configuration before fetching', (invalid) => {
  const send = vi.fn<typeof fetch>();
  expect(() =>
    createQueryClient({
      endpoint: 'https://query.invalid',
      fetch: send,
      ...invalid,
    } as QueryClientOptions),
  ).toThrow('Invalid query client configuration');
  expect(send).not.toHaveBeenCalled();
});

it.each([
  { projectId: '' },
  { projectId: 'x'.repeat(1025) },
  { from: '2026-02-30T00:00:00Z' },
  { to: window.from },
  { to: '2027-01-01T00:00:00Z' },
  { eventName: '\ud800' },
  { sessionId: ' ' },
  { ingestionKey: 'must-not-be-used' },
])('rejects invalid request values before fetching', async (invalid) => {
  const send = vi.fn<typeof fetch>();
  const client = createQueryClient({ endpoint: 'https://query.invalid', fetch: send });
  await expect(client.countReceivedEvents({ ...window, ...invalid })).rejects.toThrow(
    'Invalid analytics query',
  );
  expect(send).not.toHaveBeenCalled();
});

it('checks the encoded URL limit before making a request', async () => {
  const send = vi.fn<typeof fetch>();
  const client = createQueryClient({ endpoint: 'https://query.invalid', fetch: send });
  await expect(
    client.countReceivedEvents({ ...window, eventName: 'x' + '\u0000'.repeat(1500) }),
  ).rejects.toThrow('Analytics query URL exceeded its bound');
  expect(send).not.toHaveBeenCalled();
});

it.each([
  { events: [event], hasMore: true },
  { events: [event], hasMore: false, nextCursor: 'unexpected' },
  { events: [], hasMore: true, nextCursor: 'cursor' },
  { events: [event, event], hasMore: false },
  { events: [{ ...event, eventName: '\ud800' }], hasMore: false },
  { events: [{ ...event, eventId: 'é'.repeat(2049) }], hasMore: false },
  { events: [{ ...event, receivedAt: '2026-02-30T00:00:00Z' }], hasMore: false },
  { events: [{ ...event, sequence: '18446744073709551616' }], hasMore: false },
])('rejects incompatible event-page data privately', async (page) => {
  const client = createQueryClient({
    endpoint: 'https://query.invalid',
    fetch: async () => response(page),
  });
  await expect(client.listReceivedEvents(window)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    message: 'Analytics response was not confirmed',
  });
});

it('preserves valid Unicode scalar identifiers including a leading BOM', async () => {
  const page = {
    events: [{ ...event, eventName: '\ufeffname', sessionId: '😀'.repeat(1024) }],
    hasMore: false,
  };
  const client = createQueryClient({
    endpoint: 'https://query.invalid',
    fetch: async () => response(page),
  });
  expect(await client.listReceivedEvents(window)).toEqual(page);
});

it.each([401, 403, 429, 500, 503])(
  'returns sanitized HTTP status %s without automatic retry',
  async (status) => {
    const send = vi.fn<typeof fetch>(async () => new Response('private proxy body', { status }));
    const client = createQueryClient({ endpoint: 'https://query.invalid', fetch: send });
    await expect(client.countReceivedEvents(window)).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status,
      retryable: status === 429 || status >= 500,
      message: 'Analytics request was not confirmed',
    });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('never exposes private network error details or causes', async () => {
  const client = createQueryClient({
    endpoint: 'https://query.invalid',
    fetch: async () => {
      throw new Error('private session credential');
    },
  });
  const result = await client.countReceivedEvents(window).catch((error: unknown) => error);
  expect(result).toMatchObject({
    code: 'NETWORK',
    retryable: true,
    message: 'Analytics request was not confirmed',
  });
  expect((result as Error).cause).toBeUndefined();
});

it('retains admission after timeout until an abort-ignoring fetch actually settles', async () => {
  vi.useFakeTimers();
  let resolve!: (response: Response) => void;
  try {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((finish) => {
            resolve = finish;
          }),
      )
      .mockImplementation(async () => response({ count: '3' }));
    const client = createQueryClient({
      endpoint: 'https://query.invalid',
      fetch: send,
      timeoutMs: 20,
      maxConcurrentRequests: 1,
    });
    const first = client.countReceivedEvents(window).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(client.snapshot().inFlight).toBe(1);
    await expect(client.countReceivedEvents(window)).rejects.toMatchObject({ code: 'CAPACITY' });
    expect(send).toHaveBeenCalledTimes(1);
    resolve(response({ count: 'late' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.snapshot().inFlight).toBe(0);
    expect(await client.countReceivedEvents(window)).toEqual({ count: '3' });
    client.close();
  } finally {
    vi.useRealTimers();
  }
});

it('cancels a stalled response body at the same request deadline', async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const stalled = new Response(new ReadableStream({ cancel }), {
      headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    });
    const client = createQueryClient({
      endpoint: 'https://query.invalid',
      fetch: async () => stalled,
      timeoutMs: 20,
    });
    const result = client.countReceivedEvents(window).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ code: 'TIMEOUT' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(client.snapshot().inFlight).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('handles caller abort and close without releasing unsettled fetch capacity', async () => {
  let finish!: (response: Response) => void;
  const send = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const client = createQueryClient({ endpoint: 'https://query.invalid', fetch: send });
  const controller = new AbortController();
  const pending = client
    .countReceivedEvents(window, controller.signal)
    .catch((error: unknown) => error);
  controller.abort();
  expect(await pending).toMatchObject({ code: 'ABORTED', retryable: false });
  expect(send.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  expect(client.snapshot().inFlight).toBe(1);
  client.close();
  client.close();
  await expect(client.countReceivedEvents(window)).rejects.toMatchObject({ code: 'CLOSED' });
  finish(response({ count: '1' }));
  await Promise.resolve();
  await Promise.resolve();
  expect(client.snapshot()).toEqual({ closed: true, inFlight: 0, capacity: 4 });
});

it.each([
  () => Response.json({ count: '1' }),
  () =>
    new Response('{"count":"1"}', {
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
    }),
  () =>
    new Response(new Uint8Array([255]), {
      headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    }),
  () =>
    new Response(' '.repeat(4097), {
      headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    }),
])('rejects invalid headers, UTF-8, or oversized count bodies', async (make) => {
  const client = createQueryClient({
    endpoint: 'https://query.invalid',
    fetch: async () => make(),
  });
  await expect(client.countReceivedEvents(window)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});

it('cancels a response body rejected before JSON parsing', async () => {
  const cancel = vi.fn();
  const invalid = new Response(new ReadableStream({ cancel }), {
    headers: { 'content-type': 'text/plain' },
  });
  const client = createQueryClient({
    endpoint: 'https://query.invalid',
    fetch: async () => invalid,
  });
  await expect(client.countReceivedEvents(window)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('rejects a redirected response even if a custom fetch followed it', async () => {
  const redirected = response({ count: '1' });
  Object.defineProperty(redirected, 'redirected', { value: true });
  const client = createQueryClient({
    endpoint: 'https://query.invalid',
    fetch: async () => redirected,
  });
  await expect(client.countReceivedEvents(window)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});

it('aborts an active request on close and retains capacity until it settles', async () => {
  let finish!: (response: Response) => void;
  const send = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const client = createQueryClient({ endpoint: 'https://query.invalid', fetch: send });
  const pending = client.countReceivedEvents(window).catch((error: unknown) => error);
  client.close();
  expect(await pending).toMatchObject({ code: 'CLOSED' });
  expect(send.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  expect(client.snapshot().inFlight).toBe(1);
  finish(response({ count: '1' }));
  await Promise.resolve();
  await Promise.resolve();
  expect(client.snapshot().inFlight).toBe(0);
});

it('does not fetch for a pre-aborted caller', async () => {
  const send = vi.fn<typeof fetch>();
  const client = createQueryClient({ endpoint: 'https://query.invalid', fetch: send });
  await expect(client.countReceivedEvents(window, AbortSignal.abort())).rejects.toMatchObject({
    code: 'ABORTED',
  });
  expect(send).not.toHaveBeenCalled();
});

it('enforces the requested maximum event count even for a valid larger page', async () => {
  const client = createQueryClient({
    endpoint: 'https://query.invalid',
    fetch: async () =>
      response({ events: [event, { ...event, eventId: 'event-2' }], hasMore: false }),
  });
  await expect(client.listReceivedEvents({ ...window, limit: 1 })).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});

it('decodes valid UTF-8 split across body chunks without changing identifiers', async () => {
  const page = { events: [{ ...event, eventName: '😀' }], hasMore: false };
  const bytes = new TextEncoder().encode(JSON.stringify(page));
  const start = bytes.findIndex((byte) => byte === 240);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, start + 1));
      controller.enqueue(bytes.slice(start + 1));
      controller.close();
    },
  });
  const client = createQueryClient({
    endpoint: 'https://query.invalid',
    fetch: async () =>
      new Response(stream, {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      }),
  });
  expect(await client.listReceivedEvents(window)).toEqual(page);
});
