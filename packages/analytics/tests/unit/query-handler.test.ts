import { expect, it, vi } from 'vitest';
import { createAnalyticsQueryHandler } from '../../src/query-handler.ts';
import { createAnalyticsReader } from '../../src/index.ts';

const url =
  'https://dashboard.invalid/v1/analytics/count?projectId=requested&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z';

it('denies unauthenticated callers before any analytics read', async () => {
  const count = vi.fn(async () => ({ count: '1' }));
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: async () => ({ status: 'unauthenticated' }),
    countReceivedEvents: count,
  });
  const response = await handler(new Request(url));
  expect(response.status).toBe(401);
  expect(count).not.toHaveBeenCalled();
});

it('denies authenticated callers without project membership before reading', async () => {
  const count = vi.fn(async () => ({ count: '1' }));
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: async () => ({ status: 'forbidden' }),
    countReceivedEvents: count,
  });
  expect((await handler(new Request(url))).status).toBe(403);
  expect(count).not.toHaveBeenCalled();
});

it('reads only the resolver-authorized canonical project and prevents shared caching', async () => {
  const resolve = vi.fn(async () => ({ status: 'authorized' as const, projectId: 'canonical' }));
  const count = vi.fn(async () => ({ count: '9007199254740993' }));
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: resolve,
    countReceivedEvents: count,
  });
  const request = new Request(url, { headers: { Authorization: 'Bearer browser-ingestion-key' } });
  const response = await handler(request);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ count: '9007199254740993' });
  expect(resolve).toHaveBeenCalledWith(request, 'requested', expect.any(AbortSignal));
  expect(count).toHaveBeenCalledWith(
    {
      projectId: 'canonical',
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-02T00:00:00Z',
    },
    expect.any(AbortSignal),
  );
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
});

it.each([
  [url.replace('/v1/analytics/count', '/other'), 'GET', 404],
  [url, 'POST', 405],
  [url + '&projectId=other', 'GET', 400],
  [url + '&unexpected=1', 'GET', 400],
  [url.replace('projectId=requested&', ''), 'GET', 400],
  [url.replace('projectId=requested', 'projectId=%20'), 'GET', 400],
  [url + '&x=' + 'a'.repeat(4096), 'GET', 414],
])(
  'rejects invalid request shape before authorization: %s %s',
  async (target, method, expected) => {
    const resolve = vi.fn(async () => ({ status: 'authorized' as const, projectId: 'a' }));
    const handler = createAnalyticsQueryHandler({
      resolveProjectAccess: resolve,
      countReceivedEvents: async () => ({ count: '1' }),
    });
    const response = await handler(new Request(String(target), { method: String(method) }));
    expect(response.status).toBe(expected);
    expect(resolve).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  },
);

it.each(['authorization', 'storage'] as const)(
  'fails closed without leaking %s errors',
  async (failure) => {
    const count = vi.fn(async () => {
      throw new Error('private SQL and credentials');
    });
    const handler = createAnalyticsQueryHandler({
      resolveProjectAccess: async () => {
        if (failure === 'authorization') throw new Error('private token');
        return { status: 'authorized', projectId: 'canonical' };
      },
      countReceivedEvents: count,
    });
    const response = await handler(new Request(url));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'SERVICE_UNAVAILABLE' });
    if (failure === 'authorization') expect(count).not.toHaveBeenCalled();
  },
);

it('bounds a stalled resolver, retains its admission slot, and prevents late storage reads', async () => {
  vi.useFakeTimers();
  let finish!: (value: { status: 'authorized'; projectId: string }) => void;
  const count = vi.fn(async () => ({ count: '1' }));
  const resolve = vi.fn(
    async () =>
      new Promise<{ status: 'authorized'; projectId: string }>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const handler = createAnalyticsQueryHandler({
      timeoutMs: 25,
      maxConcurrentRequests: 1,
      resolveProjectAccess: resolve,
      countReceivedEvents: count,
    });
    const waiting = handler(new Request(url));
    await vi.advanceTimersByTimeAsync(26);
    expect((await waiting).status).toBe(503);
    expect((await handler(new Request(url))).status).toBe(503);
    finish({ status: 'authorized', projectId: 'canonical' });
    await vi.advanceTimersByTimeAsync(0);
    expect(count).not.toHaveBeenCalled();
    const next = handler(new Request(url));
    expect(resolve).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(26);
    expect((await next).status).toBe(503);
    finish({ status: 'authorized', projectId: 'canonical' });
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    vi.useRealTimers();
  }
});

it('cancels a disconnected request and prevents late authorization from starting a read', async () => {
  let finish!: (value: { status: 'authorized'; projectId: string }) => void;
  let signal: AbortSignal | undefined;
  const count = vi.fn(async () => ({ count: '1' }));
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: async (_request, _project, cancellation) => {
      signal = cancellation;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    countReceivedEvents: count,
  });
  const controller = new AbortController();
  const waiting = handler(new Request(url, { signal: controller.signal }));
  controller.abort();
  expect(signal?.aborted).toBe(true);
  expect((await waiting).status).toBe(503);
  finish({ status: 'authorized', projectId: 'a' });
  await Promise.resolve();
  expect(count).not.toHaveBeenCalled();
});

it('maps invalid authorized windows to 400 without querying ClickHouse', async () => {
  const send = vi.fn(async () => new Response('{"count":"1"}'));
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: send,
  });
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'a' }),
    countReceivedEvents: reader.countReceivedEvents,
  });
  const response = await handler(new Request(url.replace('2026-10-01T00:00:00Z', 'invalid')));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'INVALID_WINDOW' });
  expect(send).not.toHaveBeenCalled();
});

it.each(['deadline', 'disconnect'] as const)(
  'propagates %s cancellation into an already-started reader',
  async (reason) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    try {
      const reader = createAnalyticsReader({
        endpoint: 'http://clickhouse:8123',
        username: 'reader',
        password: 'test',
        fetch: async (_url, init) => {
          signal = init?.signal ?? undefined;
          return new Promise<Response>(() => {});
        },
      });
      const handler = createAnalyticsQueryHandler({
        timeoutMs: 25,
        resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'a' }),
        countReceivedEvents: reader.countReceivedEvents,
      });
      const cancellation = new AbortController();
      const waiting = handler(new Request(url, { signal: cancellation.signal }));
      await vi.advanceTimersByTimeAsync(0);
      if (reason === 'disconnect') cancellation.abort();
      else await vi.advanceTimersByTimeAsync(26);
      expect((await waiting).status).toBe(503);
      expect(signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

it('lists events under the canonical authorized project with a bounded requested limit', async () => {
  const list = vi.fn(async () => ({ events: [], hasMore: false }));
  const count = vi.fn(async () => ({ count: '0' }));
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'canonical' }),
    countReceivedEvents: count,
    listReceivedEvents: list,
  });
  const response = await handler(new Request(url.replace('/count?', '/events?') + '&limit=10'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ events: [], hasMore: false });
  expect(list).toHaveBeenCalledWith(
    { projectId: 'canonical', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', limit: 10 },
    expect.any(AbortSignal),
  );
  expect(count).not.toHaveBeenCalled();
});

it.each(['unauthenticated', 'forbidden'] as const)(
  'denies %s event listing before storage',
  async (status) => {
    const list = vi.fn(async () => ({ events: [], hasMore: false }));
    const handler = createAnalyticsQueryHandler({
      resolveProjectAccess: async () => ({ status }),
      countReceivedEvents: async () => ({ count: '0' }),
      listReceivedEvents: list,
    });
    expect((await handler(new Request(url.replace('/count?', '/events?')))).status).toBe(
      status === 'unauthenticated' ? 401 : 403,
    );
    expect(list).not.toHaveBeenCalled();
  },
);

it.each(['0', '101', '1.5', '', '1&limit=2'])(
  'rejects invalid or duplicate listing limits: %s',
  async (limit) => {
    const list = vi.fn(async () => ({ events: [], hasMore: false }));
    const handler = createAnalyticsQueryHandler({
      resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'a' }),
      countReceivedEvents: async () => ({ count: '0' }),
      listReceivedEvents: list,
    });
    expect(
      (await handler(new Request(url.replace('/count?', '/events?') + '&limit=' + limit))).status,
    ).toBe(400);
    expect(list).not.toHaveBeenCalled();
  },
);

it('forwards a listing cursor only after membership authorization', async () => {
  const list = vi.fn(async () => ({ events: [], hasMore: false }));
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'canonical' }),
    countReceivedEvents: async () => ({ count: '0' }),
    listReceivedEvents: list,
  });
  expect(
    (await handler(new Request(url.replace('/count?', '/events?') + '&cursor=position'))).status,
  ).toBe(200);
  expect(list).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'canonical', cursor: 'position' }),
    expect.any(AbortSignal),
  );
});

it.each(['count', 'events'])(
  'forwards event-name filters after authorization for %s',
  async (route) => {
    const count = vi.fn(async () => ({ count: '0' }));
    const list = vi.fn(async () => ({ events: [], hasMore: false }));
    const handler = createAnalyticsQueryHandler({
      resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'canonical' }),
      countReceivedEvents: count,
      listReceivedEvents: list,
    });
    const target = url.replace('/count?', '/' + route + '?') + '&eventName=checkout%20started';
    expect((await handler(new Request(target))).status).toBe(200);
    expect(route === 'count' ? count : list).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'canonical', eventName: 'checkout started' }),
      expect.any(AbortSignal),
    );
    expect((await handler(new Request(target + '&eventName=other'))).status).toBe(400);
  },
);
