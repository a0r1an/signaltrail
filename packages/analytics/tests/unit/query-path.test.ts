import { expect, it, vi } from 'vitest';
import { createQueryClient } from '../../src/query-client.ts';
it('binds the browser client to a same-origin application API path', async () => {
  const send = vi.fn<typeof fetch>(async () =>
    Response.json({ count: '1' }, { headers: { 'Cache-Control': 'no-store' } }),
  );
  const client = createQueryClient({
    endpoint: 'https://dashboard.invalid',
    pathPrefix: 'api/analytics/',
    fetch: send,
  });
  try {
    await client.countOccurredEvents({
      projectId: 'trusted',
      from: '2026-11-01T00:00:00Z',
      to: '2026-11-02T00:00:00Z',
    });
    expect(new URL(String(send.mock.calls[0]![0])).pathname).toBe('/api/analytics/occurred/count');
  } finally {
    client.close();
  }
});
it.each([
  '',
  '/api/',
  '../api/',
  '//other.invalid/',
  'https://other.invalid/',
  'api/%2e%2e/',
  'a/'.repeat(9),
])('rejects unsafe application prefixes: %s', (pathPrefix) => {
  expect(() =>
    createQueryClient({ endpoint: 'https://dashboard.invalid', pathPrefix, fetch: vi.fn() }),
  ).toThrow('Invalid query client configuration');
});
