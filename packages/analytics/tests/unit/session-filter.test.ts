import { expect, it, vi } from 'vitest';
import { createAnalyticsReader } from '../../src/index.ts';
import { createAnalyticsQueryHandler } from '../../src/query-handler.ts';

const window = { projectId: 'trusted', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };

it.each(['', '  ', 'x'.repeat(4097), '\ud800'])(
  'rejects invalid session filters before querying storage',
  async (sessionId) => {
    const send = vi.fn(async () => new Response(''));
    const reader = createAnalyticsReader({
      endpoint: 'http://clickhouse:8123',
      username: 'reader',
      password: 'fixture',
      fetch: send,
    });
    await expect(reader.countReceivedEvents({ ...window, sessionId })).rejects.toThrow();
    await expect(reader.listReceivedEvents({ ...window, sessionId })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(['countReceivedEvents', 'listReceivedEvents'] as const)(
  'binds exact session bytes alongside event-name filtering in %s',
  async (operation) => {
    const send = vi.fn<typeof fetch>(
      async () => new Response(operation === 'countReceivedEvents' ? '{"count":"0"}' : ''),
    );
    const reader = createAnalyticsReader({
      endpoint: 'http://clickhouse:8123',
      username: 'reader',
      password: 'fixture',
      fetch: send,
    });
    const sessionId = "session\\n' OR 1=1 --";
    await reader[operation]({ ...window, sessionId, eventName: 'viewed' });
    const target = new URL(String(send.mock.calls[0]?.[0]));
    expect(target.searchParams.get('query')).toContain('session_id = unhex({session_hex:String})');
    expect(target.searchParams.get('query')).toContain(
      'event_name = unhex({event_name_hex:String})',
    );
    expect(target.searchParams.get('query')).not.toContain(sessionId);
    expect(Buffer.from(target.searchParams.get('param_session_hex')!, 'hex').toString()).toBe(
      sessionId,
    );
  },
);

it.each(['count', 'events'])(
  'forwards a session filter only under the authorized project for %s',
  async (route) => {
    const count = vi.fn(async () => ({ count: '0' }));
    const list = vi.fn(async () => ({ events: [], hasMore: false }));
    const handler = createAnalyticsQueryHandler({
      resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'canonical' }),
      countReceivedEvents: count,
      listReceivedEvents: list,
    });
    const target = new URL('https://dashboard.invalid/v1/analytics/' + route);
    for (const [key, value] of Object.entries({
      ...window,
      sessionId: 'session\\n',
      eventName: 'viewed',
    }))
      target.searchParams.set(key, value);
    expect((await handler(new Request(target))).status).toBe(200);
    expect(route === 'count' ? count : list).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'canonical',
        sessionId: 'session\\n',
        eventName: 'viewed',
      }),
      expect.any(AbortSignal),
    );
    target.searchParams.append('sessionId', 'other');
    expect((await handler(new Request(target))).status).toBe(400);
  },
);
