import { createClickHouseWriter, createClickHouseBatchWriter } from './clickhouse-writer.ts';
import { parseProcessorEnvironment, ProcessorConfigurationError } from './environment.ts';
import { createRedpandaEventConsumer } from './redpanda-consumer.ts';
import { createProcessorMetrics } from './metrics.ts';
import { ProcessorStartupTimeoutError, startWithDeadline } from './startup.ts';

let worker: ReturnType<typeof createRedpandaEventConsumer> | undefined;
let metrics: ReturnType<typeof createProcessorMetrics> | undefined;
let stopping: Promise<void> | undefined;
function shutdown() {
  if (stopping) return stopping;
  const deadline = setTimeout(() => {
    console.error('SignalTrail event processor shutdown deadline exceeded');
    process.exit(1);
  }, 15000);
  deadline.unref();
  stopping = Promise.resolve()
    .then(async () => {
      try {
        await worker?.close();
      } finally {
        await metrics?.close();
      }
    })
    .finally(() => clearTimeout(deadline));
  return stopping;
}
function onSignal() {
  void shutdown().catch(() => {
    console.error('SignalTrail event processor shutdown failed');
    process.exitCode = 1;
  });
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
try {
  const options = parseProcessorEnvironment(process.env);
  const storageOptions = {
    ...options.clickhouse,
    onAttempt: (outcome: 'confirmed' | 'failed', seconds: number) =>
      metrics?.observeStorageWrite(outcome, seconds),
  };
  worker = createRedpandaEventConsumer({
    ...options.consumer,
    writeEvent: createClickHouseWriter(storageOptions),
    writeEvents: createClickHouseBatchWriter(storageOptions),
    onChunk: (records, bytes) => metrics?.observeChunk(records, bytes),
    onRetry: () => console.error('SignalTrail event processor retry scheduled'),
    onAttempt: (outcome, seconds) => metrics?.observeAttempt(outcome, seconds),
  });
  if (options.metrics) {
    const runningWorker = worker;
    const endpoint = options.metrics;
    const exporter = createProcessorMetrics(() => runningWorker.snapshot());
    metrics = exporter;
    await new Promise<void>((resolve, reject) => {
      exporter.server.once('error', reject);
      exporter.server.listen(endpoint.port, endpoint.host, resolve);
    });
  }
  const startingWorker = worker;
  await startWithDeadline(() => startingWorker.start());
  if (!stopping) console.log('SignalTrail event processor started');
  await worker.finished;
} catch (error) {
  if (!stopping) {
    console.error(
      error instanceof ProcessorConfigurationError
        ? error.message
        : error instanceof ProcessorStartupTimeoutError
          ? 'SignalTrail event processor startup deadline exceeded'
          : 'SignalTrail event processor failed',
    );
    process.exitCode = 1;
  }
} finally {
  try {
    await shutdown();
  } catch {
    console.error('SignalTrail event processor cleanup failed');
    process.exitCode = 1;
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}
