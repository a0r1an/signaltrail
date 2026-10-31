import { createClickHouseWriter } from './clickhouse-writer.ts';
import { parseProcessorEnvironment, ProcessorConfigurationError } from './environment.ts';
import { createRedpandaEventConsumer } from './redpanda-consumer.ts';

let worker: ReturnType<typeof createRedpandaEventConsumer> | undefined;
let stopping: Promise<void> | undefined;
function shutdown() {
  if (stopping) return stopping;
  const deadline = setTimeout(() => {
    console.error('SignalTrail event processor shutdown deadline exceeded');
    process.exit(1);
  }, 15000);
  deadline.unref();
  stopping = Promise.resolve()
    .then(() => worker?.close())
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
  worker = createRedpandaEventConsumer({
    ...options.consumer,
    writeEvent: createClickHouseWriter(options.clickhouse),
    onRetry: () => console.error('SignalTrail event processor retry scheduled'),
  });
  await worker.start();
  if (!stopping) console.log('SignalTrail event processor started');
  await worker.finished;
} catch (error) {
  if (!stopping) {
    console.error(
      error instanceof ProcessorConfigurationError
        ? error.message
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
