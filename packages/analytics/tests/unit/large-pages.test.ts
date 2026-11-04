import { expect, it, vi } from 'vitest';
import { createAnalyticsReader } from '../../src/index.ts';

const window = { projectId: 'trusted', from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' };
const rows = ['z', 'y', 'x', 'w', 'v', 'u', 't', 's', 'r', 'q'].map((prefix) => ({
  eventId: prefix + '\u0000'.repeat(4095),
  eventName: 'n' + '\u0000'.repeat(4095),
  sessionId: 's' + '\u0000'.repeat(4095),
  sequence: '0',
  receivedAtMs: String(Date.parse('2026-11-01T12:00:00Z')),
}));
const body = (values: typeof rows) => values.map((row) => JSON.stringify(row)).join('\n');
function reader(send: typeof fetch, timeoutMs = 5000) {
  return createAnalyticsReader({
    endpoint: 'http://storage.invalid',
    username: 'reader',
    password: 'fixture',
    fetch: send,
    timeoutMs,
  });
}

it('reads one complete page with maximum valid escaped identifiers', async () => {
  const api = reader(async () => new Response(body(rows.slice(0, 2))));
  const result = await api.listReceivedEvents({ ...window, limit: 1 });
  expect(result.events.map((event) => event.eventId)).toEqual([rows[0]!.eventId]);
  expect(result.hasMore).toBe(true);
  expect(result.nextCursor!.length).toBeLessThanOrEqual(8192);
});

it('shrinks oversized pages and resumes without skipping or fabricating rows', async () => {
  const send = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const before = url.searchParams.get('param_before_id_hex');
    const position = before
      ? rows.findIndex((row) => Buffer.from(row.eventId).toString('hex') === before) + 1
      : 0;
    const limit = Number(url.searchParams.get('param_limit'));
    return new Response(body(rows.slice(position, position + limit)));
  });
  const api = reader(send);
  const first = await api.listReceivedEvents({ ...window, limit: 10 });
  expect(first.events.map((event) => event.eventId)).toEqual([rows[0]!.eventId]);
  expect(first.hasMore).toBe(true);
  expect(
    send.mock.calls.map(([input]) =>
      Number(new URL(String(input)).searchParams.get('param_limit')),
    ),
  ).toEqual([11, 6, 3, 2]);
  const next = await api.listReceivedEvents({ ...window, limit: 1, cursor: first.nextCursor! });
  expect(next.events.map((event) => event.eventId)).toEqual([rows[1]!.eventId]);
  const lastId = rows.at(-1)!.eventId;
  const seen = [...first.events, ...next.events];
  let cursor = next.nextCursor;
  while (cursor) {
    const page = await api.listReceivedEvents({ ...window, limit: 1, cursor });
    seen.push(...page.events);
    cursor = page.nextCursor;
  }
  expect(seen.map((event) => event.eventId)).toEqual(rows.map((row) => row.eventId));
  expect(seen.at(-1)!.eventId).toBe(lastId);
});

it.each([new Response('failure', { status: 500 }), new Response('{invalid')])(
  'does not retry failed or malformed storage results',
  async (response) => {
    const send = vi.fn<typeof fetch>(async () => response);
    await expect(reader(send).listReceivedEvents(window)).rejects.toThrow(
      'Analytics query was not confirmed',
    );
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('shares one deadline across page reduction and stalled later attempts', async () => {
  vi.useFakeTimers();
  try {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(body(rows));
      })
      .mockImplementation(() => new Promise<Response>(() => {}));
    const result = reader(send, 50)
      .listReceivedEvents({ ...window, limit: 10 })
      .then(
        () => 'accepted',
        () => 'failed',
      );
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBe('failed');
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it('stops page reduction immediately when the caller aborts', async () => {
  const controller = new AbortController();
  const send = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new Uint8Array(160 * 1024 + 1));
          },
          cancel() {
            controller.abort();
          },
        }),
      ),
  );
  await expect(reader(send).listReceivedEvents(window, controller.signal)).rejects.toThrow(
    'Analytics query was not confirmed',
  );
  expect(send).toHaveBeenCalledTimes(1);
});

it('fails privately without further reduction when a one-event page exceeds the budget', async () => {
  const send = vi.fn<typeof fetch>(async () => new Response('private'.repeat(30000)));
  const result = await reader(send)
    .listReceivedEvents({ ...window, limit: 1 })
    .catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe('Analytics query was not confirmed');
  expect((result as Error).cause).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
});
