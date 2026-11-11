import { expect, it, vi } from 'vitest';
import { createAnalyticsReader } from '../../src/index.ts';
const window = { projectId: 'trusted', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
it('pages by event time with received time retained as a diagnostic field', async () => {
  const send = vi.fn<typeof fetch>(async () => new Response(''));
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: send,
  });
  expect(await reader.listOccurredEvents(window)).toEqual({ events: [], hasMore: false });
  const sql = new URL(String(send.mock.calls[0]![0])).searchParams.get('query')!;
  expect(sql).toContain('AS occurredAtMs');
  expect(sql).toContain('AS receivedAtMs');
  expect(sql).toContain('ORDER BY occurred_at DESC, event_id DESC');
});
it('returns both clocks and binds cursor position/scope to occurrence time', async () => {
  const row = (eventId: string) => ({
    eventId,
    eventName: 'viewed',
    sessionId: 'session',
    sequence: '0',
    occurredAtMs: '1790856000000',
    receivedAtMs: '1791028800000',
  });
  const send = vi.fn<typeof fetch>(
    async () => new Response([row('z'), row('a')].map((value) => JSON.stringify(value)).join('\n')),
  );
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: send,
  });
  const result = await reader.listOccurredEvents({ ...window, limit: 1 });
  expect(result.events[0]).toMatchObject({
    occurredAt: '2026-10-01T12:00:00.000Z',
    receivedAt: '2026-10-03T12:00:00.000Z',
  });
  expect(result.nextCursor).toBeTruthy();
  if (!result.nextCursor) throw new Error('Missing fixture cursor');
  await expect(reader.listReceivedEvents({ ...window, cursor: result.nextCursor })).rejects.toThrow(
    'does not match query scope',
  );
  expect(send).toHaveBeenCalledTimes(1);
  send.mockResolvedValueOnce(new Response(''));
  await reader.listOccurredEvents({ ...window, cursor: result.nextCursor });
  const target = new URL(String(send.mock.calls[1]![0]));
  expect(target.searchParams.get('param_before')).toBe('2026-10-01T12:00:00.000Z');
  expect(target.searchParams.get('param_before_id_hex')).toBe('7a');
});
it.each([undefined, 'NaN', '9007199254740993'])(
  'rejects malformed occurrence timestamps from storage: %s',
  async (occurredAtMs) => {
    const send = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            eventId: 'event',
            eventName: 'viewed',
            sessionId: 'session',
            sequence: '0',
            receivedAtMs: '1790856000000',
            occurredAtMs,
          }),
        ),
    );
    const reader = createAnalyticsReader({
      endpoint: 'http://clickhouse:8123',
      username: 'reader',
      password: 'fixture',
      fetch: send,
    });
    await expect(reader.listOccurredEvents(window)).rejects.toThrow(
      'Analytics query was not confirmed',
    );
  },
);
