import { expect, it, vi } from 'vitest';
import {
  createAnalyticsReader,
  createAnalyticsQueryHandler,
  type EventListWindow,
} from '../../src/index.ts';

const window: EventListWindow = {
  projectId: 'trusted',
  from: '2026-10-01T00:00:00Z',
  to: '2026-10-03T00:00:00Z',
  eventName: 'viewed',
  sessionId: 'shared',
  limit: 1,
};
function fixture() {
  const row = {
    eventId: 'event-z',
    eventName: 'viewed',
    sessionId: 'shared',
    sequence: '0',
    receivedAtMs: String(Date.parse('2026-10-01T12:00:00Z')),
  };
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        [row, { ...row, eventId: 'event-a' }].map((value) => JSON.stringify(value)).join('\n'),
      ),
    )
    .mockImplementation(async () => new Response(''));
  return {
    send,
    reader: createAnalyticsReader({
      endpoint: 'http://clickhouse:8123',
      username: 'reader',
      password: 'fixture',
      fetch: send,
    }),
  };
}

it.each([
  { projectId: 'other' },
  { from: '2026-10-01T01:00:00Z' },
  { to: '2026-10-02T00:00:00Z' },
  { eventName: 'other' },
  { sessionId: 'other' },
])('rejects cursor reuse after changing query scope', async (change) => {
  const { send, reader } = fixture();
  const first = await reader.listReceivedEvents(window);
  await expect(
    reader.listReceivedEvents({ ...window, ...change, cursor: first.nextCursor! }),
  ).rejects.toThrow('Event cursor does not match query scope');
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(['eventName', 'sessionId'] as const)(
  'rejects a cursor after removing its %s filter',
  async (key) => {
    const { send, reader } = fixture();
    const first = await reader.listReceivedEvents(window);
    const next = { ...window, cursor: first.nextCursor! };
    delete next[key];
    await expect(reader.listReceivedEvents(next)).rejects.toThrow(
      'Event cursor does not match query scope',
    );
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('accepts equivalent UTC timestamp formatting and a changed page size', async () => {
  const { send, reader } = fixture();
  const first = await reader.listReceivedEvents(window);
  expect(
    await reader.listReceivedEvents({
      ...window,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-03T00:00:00.000Z',
      limit: 20,
      cursor: first.nextCursor!,
    }),
  ).toEqual({ events: [], hasMore: false });
  expect(send).toHaveBeenCalledTimes(2);
});

it.each(['2026-09-30T00:00:00Z', '2026-10-03T00:00:00Z'])(
  'rejects a modified cursor outside its valid window: %s',
  async (receivedAt) => {
    const { send, reader } = fixture();
    const first = await reader.listReceivedEvents(window);
    const value = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const cursor = Buffer.from(JSON.stringify({ ...value, receivedAt })).toString('base64url');
    await expect(reader.listReceivedEvents({ ...window, cursor })).rejects.toThrow(
      'Event cursor is outside the requested window',
    );
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('maps mismatched cursor scope to 400 through the authorized query handler', async () => {
  const { send, reader } = fixture();
  const first = await reader.listReceivedEvents(window);
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'trusted' }),
    countReceivedEvents: reader.countReceivedEvents,
    listReceivedEvents: reader.listReceivedEvents,
  });
  const target = new URL('https://dashboard.invalid/v1/analytics/events');
  for (const [key, value] of Object.entries({
    ...window,
    eventName: 'different',
    cursor: first.nextCursor!,
  }))
    target.searchParams.set(key, String(value));
  const response = await handler(new Request(target));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'INVALID_WINDOW' });
  expect(send).toHaveBeenCalledTimes(1);
});

it('keeps cursor scope tied to the submitted query when the caller mutates its object in flight', async () => {
  let deliver!: (response: Response) => void;
  const send = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    )
    .mockImplementation(async () => new Response(''));
  const reader = createAnalyticsReader({
    endpoint: 'http://clickhouse:8123',
    username: 'reader',
    password: 'fixture',
    fetch: send,
  });
  const submitted = { ...window };
  const waiting = reader.listReceivedEvents(submitted);
  submitted.sessionId = 'changed-after-send';
  const row = {
    eventId: 'event-z',
    eventName: 'viewed',
    sessionId: 'shared',
    sequence: '0',
    receivedAtMs: String(Date.parse('2026-10-01T12:00:00Z')),
  };
  deliver(
    new Response(
      [row, { ...row, eventId: 'event-a' }].map((value) => JSON.stringify(value)).join('\n'),
    ),
  );
  const first = await waiting;
  expect(await reader.listReceivedEvents({ ...window, cursor: first.nextCursor! })).toEqual({
    events: [],
    hasMore: false,
  });
});
