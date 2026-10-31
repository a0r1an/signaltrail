import { expect, it, vi } from 'vitest';
import { createAnalyticsReader } from '../../src/index.ts';

it.each(['', '  ', 'x'.repeat(4097), '\ud800'])(
  'rejects invalid event-name filters before storage',
  async (eventName) => {
    const send = vi.fn(async () => new Response(''));
    const reader = createAnalyticsReader({
      endpoint: 'http://clickhouse:8123',
      username: 'reader',
      password: 'fixture',
      fetch: send,
    });
    await expect(reader.listReceivedEvents({ ...window, eventName })).rejects.toThrow();
    await expect(reader.countReceivedEvents({ ...window, eventName })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  },
);

const window = { projectId: 'trusted', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
const row = {
  eventId: 'event-z',
  eventName: 'viewed',
  sessionId: 'session',
  sequence: '9007199254740993',
  receivedAtMs: '1790812800000',
};

it.each(['countReceivedEvents', 'listReceivedEvents'] as const)(
  'binds exact event-name bytes for %s without SQL interpolation',
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
    const eventName = " viewed\\n' OR 1=1 -- ";
    await reader[operation]({ ...window, eventName });
    const target = new URL(String(send.mock.calls[0]?.[0]));
    expect(target.searchParams.get('query')).toContain(
      'event_name = unhex({event_name_hex:String})',
    );
    expect(target.searchParams.get('query')).not.toContain(eventName);
    expect(Buffer.from(target.searchParams.get('param_event_name_hex')!, 'hex').toString()).toBe(
      eventName,
    );
  },
);

it('returns bounded unique-event summaries with exact sequence values', async () => {
  const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(row) + '\n'));
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: send,
  });
  expect(await reader.listReceivedEvents(window)).toEqual({
    events: [
      {
        eventId: row.eventId,
        eventName: row.eventName,
        sessionId: row.sessionId,
        sequence: row.sequence,
        receivedAt: '2026-10-01T00:00:00.000Z',
      },
    ],
    hasMore: false,
  });
  const query = new URL(String(send.mock.calls[0]?.[0]));
  expect(query.searchParams.get('query')).toContain(' FINAL ');
  expect(query.searchParams.get('query')).toContain('ORDER BY received_at DESC, event_id DESC');
  expect(query.searchParams.get('param_limit')).toBe('51');
});

it.each([0, -1, 101, 1.5, Number.NaN])(
  'rejects invalid list limits before storage: %s',
  async (limit) => {
    const send = vi.fn(async () => new Response(''));
    const reader = createAnalyticsReader({
      endpoint: 'http://clickhouse:8123',
      username: 'reader',
      password: 'fixture',
      fetch: send,
    });
    await expect(reader.listReceivedEvents({ ...window, limit })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  },
);

it.each([
  JSON.stringify({ ...row, sequence: 1 }),
  JSON.stringify({ ...row, sequence: '18446744073709551616' }),
  JSON.stringify({ ...row, eventName: '' }),
  JSON.stringify({ ...row, eventId: '\ud800' }),
  JSON.stringify({ ...row, receivedAtMs: 'NaN' }),
  JSON.stringify(row) + '\n' + JSON.stringify(row),
  JSON.stringify(row) + '\nprivate SQL failure',
  ' '.repeat(65537),
])('rejects malformed or oversized event results', async (body) => {
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: async () => new Response(body),
  });
  await expect(reader.listReceivedEvents(window)).rejects.toThrow(
    'Analytics query was not confirmed',
  );
});

it('uses the last returned row as a keyset cursor without exposing the extra row', async () => {
  const rows = [row, { ...row, eventId: 'event-a' }];
  const send = vi.fn<typeof fetch>(
    async () => new Response(rows.map((value) => JSON.stringify(value)).join('\n')),
  );
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: send,
  });
  const first = await reader.listReceivedEvents({ ...window, limit: 1 });
  expect(first.events.map((event) => event.eventId)).toEqual(['event-z']);
  expect(first.hasMore).toBe(true);
  expect(first.nextCursor).toEqual(expect.any(String));
  await reader.listReceivedEvents({ ...window, limit: 1, cursor: first.nextCursor! });
  const target = new URL(String(send.mock.calls[1]?.[0]));
  expect(target.searchParams.get('query')).toContain('(received_at, event_id) <');
  expect(target.searchParams.get('param_before')).toBe('2026-10-01T00:00:00.000Z');
  expect(Buffer.from(target.searchParams.get('param_before_id_hex')!, 'hex').toString()).toBe(
    'event-z',
  );
});

it.each([
  '',
  'not+base64',
  'x'.repeat(8193),
  ...[
    null,
    { receivedAt: 'invalid', eventId: 'a' },
    { receivedAt: '2026-09-01T00:00:00Z', eventId: 'a' },
    { receivedAt: '2026-10-02T00:00:00Z', eventId: 'a' },
    { receivedAt: window.from, eventId: '' },
    { receivedAt: window.from, eventId: 'x'.repeat(4097) },
    { receivedAt: window.from, eventId: 'a', sql: 'private' },
  ].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')),
])('rejects malformed or out-of-window cursors before storage', async (cursor) => {
  const send = vi.fn(async () => new Response(''));
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: send,
  });
  await expect(reader.listReceivedEvents({ ...window, cursor })).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
