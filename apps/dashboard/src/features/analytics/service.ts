import 'server-only';
import { createAnalyticsReader } from '@signaltrail/analytics';
import { createPostgresMembershipDatabase } from '@signaltrail/project-access';
import { readOwnerAccess } from '../auth/owner-session';
import { getAnalyticsServiceConfig } from './config';
import { createDashboardAnalyticsHandler } from './handler';
import { createOwnerProjectReader, type ProjectSelectionResult } from './project-selection';

let handler: ReturnType<typeof createDashboardAnalyticsHandler> | undefined;
let projectReader: ReturnType<typeof createOwnerProjectReader> | undefined;
function initialize(): boolean {
  if (handler && projectReader) return true;
  const config = getAnalyticsServiceConfig(process.env);
  if (!config) return false;
  try {
    const reader = createAnalyticsReader(config.clickhouse);
    const database = createPostgresMembershipDatabase(config.membership);
    const nextHandler = createDashboardAnalyticsHandler({
      readOwnerAccess,
      query: database.query,
      reader,
    });
    const nextProjectReader = createOwnerProjectReader({ readOwnerAccess, query: database.query });
    handler = nextHandler;
    projectReader = nextProjectReader;
    return true;
  } catch {
    return false;
  }
}
/** Cache service connections only. Sessions and membership are verified for every request. */
export async function handleAnalyticsRequest(request: Request): Promise<Response> {
  if (!initialize()) return unavailable();
  try {
    return await handler!(request);
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

export async function readDashboardProjects(
  input: { cursor?: string; limit?: number },
  signal = AbortSignal.timeout(5000),
): Promise<ProjectSelectionResult> {
  if (!initialize()) return { status: 'unavailable' };
  return projectReader!(input, signal);
}
