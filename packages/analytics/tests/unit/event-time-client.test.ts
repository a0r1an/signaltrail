import { expect, it, vi } from 'vitest';
import { createQueryClient } from '../../src/query-client.ts';
const window = { projectId: 'trusted', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
it('requests explicit occurrence-time count and visitor endpoints', async () => {
  const send = vi.fn<typeof fetch>(async () =>
    Response.json({ count: '1' }, { headers: { 'Cache-Control': 'no-store' } }),
  );
  const client = createQueryClient({ endpoint: 'https://query.invalid', fetch: send });
  try {
    expect(await client.countOccurredEvents(window)).toEqual({ count: '1' });
    expect(await client.countOccurredVisitors(window)).toEqual({ count: '1' });
    expect(new URL(String(send.mock.calls[0]![0])).pathname).toBe('/v1/analytics/occurred/count');
    expect(new URL(String(send.mock.calls[1]![0])).pathname).toBe(
      '/v1/analytics/occurred/visitors/count',
    );
  } finally {
    client.close();
  }
});
it.each([true, false])(
  'validates occurrence pages without confusing received-time summaries: %s',
  async (valid) => {
    const event = {
      eventId: 'event',
      eventName: 'viewed',
      sessionId: 'session',
      sequence: '0',
      receivedAt: '2026-10-03T12:00:00Z',
      ...(valid ? { occurredAt: '2026-10-01T12:00:00Z' } : {}),
    };
    const send = vi.fn<typeof fetch>(async () =>
      Response.json(
        { events: [event], hasMore: false },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
    );
    const client = createQueryClient({ endpoint: 'https://query.invalid', fetch: send });
    try {
      if (valid) expect((await client.listOccurredEvents(window)).events[0]).toEqual(event);
      else
        await expect(client.listOccurredEvents(window)).rejects.toMatchObject({
          code: 'INVALID_RESPONSE',
        });
    } finally {
      client.close();
    }
  },
);
