import { createQueryClient } from '@signaltrail/analytics/client';
import type {
  AnalyticsCountRequest,
  AnalyticsCountResponse,
  AnalyticsEventPage,
} from '@signaltrail/analytics/api-types';

export const request: AnalyticsCountRequest = {
  projectId: 'trusted',
  from: '2026-11-01T00:00:00Z',
  to: '2026-11-02T00:00:00Z',
};
export const count: AnalyticsCountResponse = { count: '18446744073709551615' };
export function nextCursor(page: AnalyticsEventPage): string | undefined {
  return page.hasMore ? page.nextCursor : undefined;
}
// @ts-expect-error Decimal values must remain exact strings.
export const numericCount: AnalyticsCountResponse = { count: 7 };
// @ts-expect-error A non-final page must include a cursor.
export const missingCursor: AnalyticsEventPage = { events: [], hasMore: true };

export const clientFactory = createQueryClient;
