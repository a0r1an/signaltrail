import { expect, it, vi } from 'vitest';
import { createAnalyticsReader } from '../../src/index.ts';
it('counts activity by client event time while retaining received-time diagnostics separately', async () => {
  const send = vi.fn<typeof fetch>(async () => new Response('{"count":"2"}'));
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: send,
  });
  const window = { projectId: 'trusted', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
  expect(await reader.countOccurredEvents(window)).toEqual({ count: '2' });
  const query = new URL(String(send.mock.calls[0]![0])).searchParams.get('query')!;
  expect(query).toContain('client_timestamp');
  expect(query).toContain('parseDateTime64BestEffortOrNull');
  expect(query).not.toContain('received_at >=');
  await reader.countReceivedEvents(window);
  expect(new URL(String(send.mock.calls[1]![0])).searchParams.get('query')).toContain(
    'received_at >=',
  );
});
it.each(['0001-01-01T00:00:00Z', '9999-01-01T00:00:00Z'])(
  'rejects unrepresentable query windows before contacting storage: %s',
  async (from) => {
    const send = vi.fn<typeof fetch>();
    const reader = createAnalyticsReader({
      endpoint: 'http://clickhouse:8123',
      username: 'reader',
      password: 'fixture',
      fetch: send,
    });
    expect(() =>
      reader.countOccurredEvents({ projectId: 'trusted', from, to: '2026-10-02T00:00:00Z' }),
    ).toThrow('between 1900 and 2299');
    expect(() =>
      reader.countOccurredVisitors({ projectId: 'trusted', from, to: '2026-10-02T00:00:00Z' }),
    ).toThrow();
    expect(send).not.toHaveBeenCalled();
  },
);
it('applies event-time filters only to activity while resolving retained project identity links', async () => {
  const send = vi.fn<typeof fetch>(async () => new Response('{"count":"1"}'));
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: send,
  });
  await reader.countOccurredVisitors({
    projectId: 'trusted',
    from: '2026-10-01T00:00:00Z',
    to: '2026-10-02T00:00:00Z',
    eventName: 'viewed',
    sessionId: 'session',
  });
  const sql = new URL(String(send.mock.calls[0]![0])).searchParams.get('query')!;
  expect(sql).toContain('client_timestamp');
  expect(sql.indexOf('event_name = unhex')).toBeGreaterThan(sql.indexOf('LEFT JOIN'));
  expect(sql.indexOf('session_id = unhex')).toBeGreaterThan(sql.indexOf('LEFT JOIN'));
});
