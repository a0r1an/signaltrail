import { expect, it, vi } from 'vitest';
import { createAnalyticsReader } from '../../src/index.ts';

const window = { projectId: 'trusted', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
const row = {
  eventId: 'event-z',
  eventName: 'viewed',
  sessionId: 'session',
  sequence: '9007199254740993',
  receivedAtMs: '1790812800000',
};

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
