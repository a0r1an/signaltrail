import { matchesQueryReference } from '../query-reference.ts';
import { expect, it, vi } from 'vitest';
import { createAnalyticsQueryHandler } from '../../src/query-handler.ts';
it.each(['count', 'events', 'visitors/count'])(
  'routes occurred/%s through canonical membership scope',
  async (operation) => {
    const count = vi.fn(async () => ({ count: '1' }));
    const list = vi.fn(async () => ({ events: [], hasMore: false }));
    const old = vi.fn(async () => ({ count: '0' }));
    const handler = createAnalyticsQueryHandler({
      countReceivedEvents: old,
      countOccurredEvents: count,
      countOccurredVisitors: count,
      listOccurredEvents: list,
      resolveProjectAccess: async () => ({ status: 'authorized', projectId: 'canonical' }),
    });
    const response = await handler(
      new Request(
        `https://query.invalid/v1/analytics/occurred/${operation}?projectId=requested&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(
      matchesQueryReference(
        `occurred/${operation}` as 'occurred/count' | 'occurred/events' | 'occurred/visitors/count',
        200,
        await response.json(),
      ),
    ).toBe(true);
    expect(operation === 'events' ? list : count).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'canonical' }),
      expect.any(AbortSignal),
    );
    expect(old).not.toHaveBeenCalled();
  },
);
it.each(['unauthenticated', 'forbidden'] as const)(
  'denies occurrence reads before storage for %s sessions',
  async (status) => {
    const read = vi.fn(async () => ({ count: '1' }));
    const handler = createAnalyticsQueryHandler({
      countReceivedEvents: read,
      countOccurredEvents: read,
      resolveProjectAccess: async () => ({ status }),
    });
    const response = await handler(
      new Request(
        'https://query.invalid/v1/analytics/occurred/count?projectId=requested&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z',
      ),
    );
    expect(response.status).toBe(status === 'unauthenticated' ? 401 : 403);
    expect(read).not.toHaveBeenCalled();
  },
);
