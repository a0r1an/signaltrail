import { expect, it, vi } from 'vitest';
import { createAnalyticsReader } from '../../src/index.ts';
const window = {
  projectId: 'trusted-project',
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-02T00:00:00.000Z',
};

it('returns exact unique-event counts without converting UInt64 values to Number', async () => {
  const send = vi.fn(async () => new Response('{"count":"9007199254740993"}\n'));
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'test',
    fetch: send,
  });
  expect(await reader.countReceivedEvents(window)).toEqual({ count: '9007199254740993' });
  expect(send).toHaveBeenCalledTimes(1);
});

it('binds trusted project bytes and a half-open received-time window to a fixed FINAL count query', async () => {
  let target = '';
  let init: RequestInit | undefined;
  const projectId = "tenant\\n' OR 1=1 --";
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: ' secret ',
    fetch: async (url, options) => {
      target = String(url);
      init = options;
      return new Response('{"count":"1"}\n');
    },
  });
  await reader.countReceivedEvents({ ...window, projectId });
  const url = new URL(target);
  expect(url.searchParams.get('query')).toContain(' FINAL ');
  expect(url.searchParams.get('query')).not.toContain(projectId);
  expect(Buffer.from(url.searchParams.get('param_project_hex')!, 'hex').toString()).toBe(projectId);
  expect(url.searchParams.get('param_from')).toBe(window.from);
  expect(url.searchParams.get('param_to')).toBe(window.to);
  expect(init?.method).toBe('GET');
  expect(url.searchParams.get('readonly')).toBeNull();
  expect(new Headers(init?.headers).get('Authorization')).toBe(
    'Basic ' + Buffer.from('reader: secret ').toString('base64'),
  );
});

it('rejects empty tenant scopes, invalid dates, reversed windows and windows over 31 days before querying', async () => {
  const send = vi.fn(async () => new Response('{"count":"0"}'));
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'test',
    fetch: send,
  });
  for (const invalid of [
    { projectId: '' },
    { projectId: '  ' },
    { from: 'invalid' },
    { from: '2026-02-30T00:00:00.000Z' },
    { to: window.from },
    { to: '2026-12-01T00:00:00.000Z' },
  ])
    await expect(reader.countReceivedEvents({ ...window, ...invalid })).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

it.each([
  { endpoint: 'http://user:secret@clickhouse:8123' },
  { endpoint: 'file:///tmp/data' },
  { endpoint: 'http://clickhouse:8123?query=DROP' },
  { database: 'db; DROP' },
  { username: 'reader:other' },
  { timeoutMs: 0 },
])('rejects unsafe reader configuration: %j', (invalid) => {
  expect(() =>
    createAnalyticsReader({
      endpoint: 'http://clickhouse:8123',
      username: 'reader',
      password: 'test',
      ...invalid,
    }),
  ).toThrow();
});

it.each([
  new Response('{"count":"1"}', { status: 500 }),
  new Response('{"count":"1"}', { headers: { 'X-ClickHouse-Exception-Code': '27' } }),
  new Response('{"count":9007199254740993}'),
  new Response('{"count":"-1"}'),
  new Response('{"count":"1"}\nprivate SQL error'),
  new Response(' '.repeat(5000) + '{"count":"1"}'),
])(
  'rejects unconfirmed, malformed or oversized query responses without leaking storage details',
  async (response) => {
    const reader = createAnalyticsReader({
      endpoint: 'http://clickhouse:8123',
      username: 'reader',
      password: 'secret',
      fetch: async () => response,
    });
    await expect(reader.countReceivedEvents(window)).rejects.toThrow(
      'Analytics query was not confirmed',
    );
  },
);

it.each(['fetch', 'body'] as const)(
  'bounds a stalled %s even when a custom fetch ignores cancellation',
  async (mode) => {
    vi.useFakeTimers();
    let cancelled = false;
    let signal: AbortSignal | undefined;
    try {
      const reader = createAnalyticsReader({
        endpoint: 'http://clickhouse:8123',
        username: 'reader',
        password: 'test',
        timeoutMs: 25,
        fetch: async (_url, init) => {
          signal = init?.signal ?? undefined;
          return mode === 'fetch'
            ? new Promise<Response>(() => {})
            : new Response(
                new ReadableStream({
                  cancel() {
                    cancelled = true;
                  },
                }),
              );
        },
      });
      const outcome = expect(reader.countReceivedEvents(window)).rejects.toThrow(
        'Analytics query was not confirmed',
      );
      await vi.advanceTimersByTimeAsync(26);
      await outcome;
      expect(signal?.aborted).toBe(true);
      if (mode === 'body') expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  },
);
