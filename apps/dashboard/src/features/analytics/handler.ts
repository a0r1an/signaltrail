import { createAnalyticsQueryHandler, type AnalyticsQueryOptions } from '@signaltrail/analytics';
import { createProjectAccessResolver, type AccessOptions } from '@signaltrail/project-access';
import type { OwnerAccess } from '../auth/owner-access';
export interface DashboardAnalyticsOptions {
  readOwnerAccess(): Promise<OwnerAccess>;
  query: AccessOptions['query'];
  reader: Pick<
    AnalyticsQueryOptions,
    | 'countReceivedEvents'
    | 'listReceivedEvents'
    | 'countOccurredEvents'
    | 'countOccurredVisitors'
    | 'listOccurredEvents'
  >;
}
export function createDashboardAnalyticsHandler(options: DashboardAnalyticsOptions) {
  options = { ...options, reader: { ...options.reader } };
  const handler = createAnalyticsQueryHandler({
    ...options.reader,
    async resolveProjectAccess(request, requestedProjectId, signal) {
      const access = await options.readOwnerAccess();
      signal.throwIfAborted();
      if (access.status === 'unavailable') throw new Error('Access unavailable');
      if (access.status !== 'authorized') return { status: access.status };
      return createProjectAccessResolver({
        resolveIdentity: async () => access.principal,
        query: options.query,
      })(request, requestedProjectId, signal);
    },
  });
  return (request: Request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/analytics/'))
      return Promise.resolve(
        Response.json(
          { error: 'NOT_FOUND' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } },
        ),
      );
    if (
      request.headers.has('transfer-encoding') ||
      (request.headers.has('content-length') && request.headers.get('content-length') !== '0')
    )
      return Promise.resolve(
        Response.json(
          { error: 'INVALID_REQUEST' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } },
        ),
      );
    url.pathname = '/v1/analytics/' + url.pathname.slice('/api/analytics/'.length);
    return handler(new Request(url, request));
  };
}
