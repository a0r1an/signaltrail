import { createIngestionMetrics } from './metrics.ts';
import { createIngestionServer } from './server.ts';
import { createProjectRuntime } from './project-runtime.ts';
import { createRedpandaPublisher } from './redpanda-publisher.ts';

const projects = createProjectRuntime(process.env);
const resolveProjectKey = projects.resolveProjectKey;
const port = Number(process.env.PORT ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new RangeError('PORT must be from 1 to 65535');
const publisher = createRedpandaPublisher({
  onPublicationSettled: (seconds, failed) => metrics.observePublication(seconds, failed),
  brokers: (process.env.SIGNALTRAIL_REDPANDA_BROKERS ?? '127.0.0.1:19092')
    .split(',')
    .map((value) => value.trim()),
  topic: process.env.SIGNALTRAIL_REDPANDA_TOPIC ?? 'signaltrail.analytics.v1',
  maxOutstandingEvents: Number(process.env.SIGNALTRAIL_MAX_OUTSTANDING_EVENTS ?? 1000),
  maxOutstandingBytes: Number(process.env.SIGNALTRAIL_MAX_OUTSTANDING_BYTES ?? 8 * 1024 * 1024),
});
const metricsPort = Number(process.env.SIGNALTRAIL_METRICS_PORT ?? 9464);
if (
  !Number.isInteger(metricsPort) ||
  metricsPort < 1 ||
  metricsPort > 65535 ||
  metricsPort === port
)
  throw new RangeError('Metrics port must be valid and differ from the ingestion port');
const maxConcurrentRequests = Number(process.env.SIGNALTRAIL_MAX_CONCURRENT_REQUESTS ?? 128);
const metrics = createIngestionMetrics(publisher.snapshot, {
  maxConcurrentRequests,
  maxEvents: Number(process.env.SIGNALTRAIL_MAX_OUTSTANDING_EVENTS ?? 1000),
  maxBytes: Number(process.env.SIGNALTRAIL_MAX_OUTSTANDING_BYTES ?? 8 * 1024 * 1024),
});
const server = createIngestionServer({
  maxConcurrentRequests,
  observeAdmission: metrics.observeAdmission,
  observeRequest: metrics.observeRequest,
  observeSdkHealth: metrics.observeSdkHealth,
  resolveProjectKey,
  allowedOrigins: (process.env.SIGNALTRAIL_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  publish: publisher.publish,
});
let stopping: Promise<void> | undefined;
function shutdown() {
  if (stopping) return stopping;
  stopping = (async () => {
    // Stop new HTTP requests, finish active responses, then drain broker sends.
    const deadline = setTimeout(() => {
      console.error('Ingestion shutdown deadline exceeded');
      server.closeAllConnections();
      process.exit(1);
    }, 15_000);
    deadline.unref();
    try {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await publisher.close();
    } finally {
      try {
        await projects.close();
      } finally {
        metrics.close();
        clearTimeout(deadline);
      }
    }
  })();
  return stopping;
}
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void shutdown().catch((error) => {
      console.error('Ingestion shutdown failed', error);
      process.exitCode = 1;
    });
  });
try {
  await projects.verify();
  if (!stopping) await publisher.connect();
  if (!stopping)
    await new Promise<void>((resolve, reject) => {
      metrics.server.once('error', reject);
      metrics.server.listen(
        metricsPort,
        process.env.SIGNALTRAIL_METRICS_HOST ?? '127.0.0.1',
        () => {
          metrics.server.off('error', reject);
          resolve();
        },
      );
    });
  if (!stopping) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    console.info(`Ingestion listening on http://127.0.0.1:${port}`);
  }
} catch (error) {
  if (!stopping) {
    console.error('Ingestion startup failed', error);
    process.exitCode = 1;
  }
  await shutdown();
}
