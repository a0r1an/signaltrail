import { expectTypeOf, it } from 'vitest';
import type {
  AnalyticsCountRequest,
  AnalyticsCountResponse,
  AnalyticsEventListRequest,
  AnalyticsEventPage,
  AnalyticsEventSummary,
  AnalyticsQueryError,
} from '../../src/api-types.ts';

it('preserves exact decimal strings and required query scope in generated API types', () => {
  expectTypeOf<AnalyticsCountResponse['count']>().toEqualTypeOf<string>();
  expectTypeOf<AnalyticsEventSummary['sequence']>().toEqualTypeOf<string>();
  expectTypeOf<AnalyticsCountRequest>().toMatchTypeOf<{
    projectId: string;
    from: string;
    to: string;
  }>();
  expectTypeOf<AnalyticsEventListRequest['cursor']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<AnalyticsQueryError['error']>().toEqualTypeOf<
    | 'INVALID_REQUEST'
    | 'INVALID_WINDOW'
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'METHOD_NOT_ALLOWED'
    | 'URI_TOO_LONG'
    | 'SERVICE_UNAVAILABLE'
  >();
});

it('narrows cursor presence by hasMore and excludes private summary fields', () => {
  expectTypeOf<
    Extract<AnalyticsEventPage, { hasMore: true }>['nextCursor']
  >().toEqualTypeOf<string>();
  expectTypeOf<Extract<AnalyticsEventPage, { hasMore: false }>>().toEqualTypeOf<{
    events: AnalyticsEventSummary[];
    hasMore: false;
  }>();
  expectTypeOf<keyof AnalyticsEventSummary>().toEqualTypeOf<
    'eventId' | 'eventName' | 'sessionId' | 'sequence' | 'receivedAt'
  >();
});
