import 'server-only';
import { createAnalyticsReader } from '@signaltrail/analytics';
import { createPostgresMembershipDatabase } from '@signaltrail/project-access';
import { readOwnerAccess } from '../auth/owner-session';
import { getAnalyticsServiceConfig } from './config';
import { createDashboardAnalyticsHandler } from './handler';

let handler: ReturnType<typeof createDashboardAnalyticsHandler> | undefined;
/** Cache service connections only. Sessions and membership are verified for every request. */
export async function handleAnalyticsRequest(request: Request): Promise<Response> {
  if (!handler) {
    const config = getAnalyticsServiceConfig(process.env);
    if (!config) return unavailable();
    try {
      const reader = createAnalyticsReader(config.clickhouse);
      const database = createPostgresMembershipDatabase(config.membership);
      handler = createDashboardAnalyticsHandler({ readOwnerAccess, query: database.query, reader });
    } catch {
      return unavailable();
    }
  }
  try {
    return await handler(request);
  } catch {
    return unavailable();
  }
}
function unavailable() {
  return Response.json(
    { error: 'SERVICE_UNAVAILABLE' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
