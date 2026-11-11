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
  // The insert-time occurred_at column is skip-indexed; parsing strings per read is not.
  expect(query).toContain('occurred_at >=');
  expect(query).not.toContain('client_timestamp');
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
  expect(sql).toContain('occurred_at >=');
  expect(sql).not.toContain('client_timestamp');
  expect(sql.indexOf('event_name = unhex')).toBeGreaterThan(sql.indexOf('LEFT JOIN'));
  expect(sql.indexOf('session_id = unhex')).toBeGreaterThan(sql.indexOf('LEFT JOIN'));
});
it('prunes event-time reads by skip index without exact FINAL expansion; received-time reads stay exact', async () => {
  const send = vi.fn<typeof fetch>(
    async (url) =>
      new Response(
        String(new URL(String(url)).searchParams.get('query')).startsWith('SELECT event_id')
          ? ''
          : '{"count":"0"}',
      ),
  );
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: send,
  });
  const window = { projectId: 'trusted', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
  await reader.countOccurredEvents(window);
  await reader.countOccurredVisitors(window);
  await reader.listOccurredEvents({ ...window, limit: 5 });
  await reader.countReceivedEvents(window);
  await reader.countReceivedVisitors(window);
  const exactMode = send.mock.calls.map(([url]) =>
    new URL(String(url)).searchParams.get('use_skip_indexes_if_final_exact_mode'),
  );
  // Copies of one event share occurred_at, so granules pruned by it hold no copy of an
  // in-window event; received_at differs per copy, so those reads keep exact mode.
  expect(exactMode).toEqual(['0', '0', '0', null, null]);
});
