import { expect, it, vi } from 'vitest';
import { createDashboardAnalyticsHandler } from '../../src/features/analytics/handler';
const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request = () =>
  new Request(
    `http://localhost/api/analytics/occurred/count?projectId=${project}&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z`,
  );
it('requires owner verification and organization membership before an occurrence read', async () => {
  const read = vi.fn(async () => ({ count: '2' }));
  const query = vi.fn(async () => ({ rows: [{ project_id: project }] }));
  const owner = vi.fn(async () => ({
    status: 'authorized' as const,
    principal: { issuer: 'https://owned.clerk.accounts.dev', subject: 'user_owner' },
    sessionId: 'sess_owner',
  }));
  const handler = createDashboardAnalyticsHandler({
    readOwnerAccess: owner,
    query,
    reader: { countReceivedEvents: read, countOccurredEvents: read },
  });
  const response = await handler(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ count: '2' });
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({
      values: [project, 'https://owned.clerk.accounts.dev', 'user_owner'],
    }),
  );
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: project }),
    expect.any(AbortSignal),
  );
});
it.each([
  ['unauthenticated', 401],
  ['forbidden', 403],
  ['unavailable', 503],
] as const)('denies %s without membership or analytics reads', async (status, code) => {
  const read = vi.fn(async () => ({ count: '2' })),
    query = vi.fn(async () => ({ rows: [] }));
  const handler = createDashboardAnalyticsHandler({
    readOwnerAccess: async () => ({ status }),
    query,
    reader: { countReceivedEvents: read, countOccurredEvents: read },
  });
  expect((await handler(request())).status).toBe(code);
  expect(query).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
it('does not let an authenticated owner skip project membership', async () => {
  const read = vi.fn(async () => ({ count: '2' }));
  const owner = async () => ({
    status: 'authorized' as const,
    principal: { issuer: 'https://owned.clerk.accounts.dev', subject: 'user_owner' },
    sessionId: 'sess_owner',
  });
  const handler = createDashboardAnalyticsHandler({
    readOwnerAccess: owner,
    query: async () => ({ rows: [] }),
    reader: { countReceivedEvents: read, countOccurredEvents: read },
  });
  expect((await handler(request())).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
});
it('rechecks membership on every request instead of caching an owner grant', async () => {
  const read = vi.fn(async () => ({ count: '2' }));
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ project_id: project }] })
    .mockResolvedValueOnce({ rows: [] });
  const owner = vi.fn(async () => ({
    status: 'authorized' as const,
    principal: { issuer: 'https://owned.clerk.accounts.dev', subject: 'user_owner' },
    sessionId: 'sess_owner',
  }));
  const handler = createDashboardAnalyticsHandler({
    readOwnerAccess: owner,
    query,
    reader: { countReceivedEvents: read, countOccurredEvents: read },
  });
  expect((await handler(request())).status).toBe(200);
  expect((await handler(request())).status).toBe(403);
  expect(owner).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(1);
});
it('rejects public ingestion keys as project scope before membership reads', async () => {
  const read = vi.fn(async () => ({ count: '2' })),
    query = vi.fn(async () => ({ rows: [] }));
  const owner = async () => ({
    status: 'authorized' as const,
    principal: { issuer: 'https://owned.clerk.accounts.dev', subject: 'user_owner' },
    sessionId: 'sess_owner',
  });
  const handler = createDashboardAnalyticsHandler({
    readOwnerAccess: owner,
    query,
    reader: { countReceivedEvents: read, countOccurredEvents: read },
  });
  const url = new URL(request().url);
  url.searchParams.set('projectId', 'public-ingestion-key');
  expect((await handler(new Request(url))).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
