import { createIngestionServer } from './server.ts';
import { createDevelopmentProjectResolver } from './development-projects.ts';

if (process.env.NODE_ENV === 'production')
  throw new Error(
    'A production project resolver and publisher must be configured before production use',
  );
const resolveProjectKey = createDevelopmentProjectResolver(
  JSON.parse(process.env.SIGNALTRAIL_DEV_PROJECTS ?? '[]') as unknown,
);
const port = Number(process.env.PORT ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new RangeError('PORT must be from 1 to 65535');
const server = createIngestionServer({
  resolveProjectKey,
  allowedOrigins: (process.env.SIGNALTRAIL_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  // Fail closed until the Redpanda adapter is implemented; never fabricate acceptance.
  publish: async () => {
    throw new Error('Publisher not configured');
  },
});
server.listen(port, '127.0.0.1', () =>
  console.info(
    `Development ingestion listening on http://127.0.0.1:${port}; publisher is unconfigured`,
  ),
);
process.on('SIGTERM', () => {
  server.close();
  server.closeAllConnections();
});
process.on('SIGINT', () => {
  server.close();
  server.closeAllConnections();
});
