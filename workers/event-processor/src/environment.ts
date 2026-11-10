export class ProcessorConfigurationError extends Error {
  override name = 'ProcessorConfigurationError';
}

export function parseProcessorEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const text = (name: string) => environment[name]?.trim() ?? '';
  const required = (name: string) => {
    const value = text(name);
    if (!value) throw new ProcessorConfigurationError(`Missing ${name}`);
    return value;
  };
  if (environment.SIGNALTRAIL_CLICKHOUSE_PASSWORD === undefined)
    throw new ProcessorConfigurationError('Missing SIGNALTRAIL_CLICKHOUSE_PASSWORD');
  const timeoutMs = Number(environment.SIGNALTRAIL_CLICKHOUSE_TIMEOUT_MS ?? 5000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new ProcessorConfigurationError('Invalid SIGNALTRAIL_CLICKHOUSE_TIMEOUT_MS');
  const rawBatchWait = environment.SIGNALTRAIL_PROCESSOR_BATCH_WAIT_MS;
  const batchWaitMs = rawBatchWait === undefined ? 200 : Number(rawBatchWait);
  if (
    rawBatchWait?.trim() === '' ||
    !Number.isSafeInteger(batchWaitMs) ||
    batchWaitMs < 0 ||
    batchWaitMs > 1000
  )
    throw new ProcessorConfigurationError('Invalid SIGNALTRAIL_PROCESSOR_BATCH_WAIT_MS');
  const rawPort = environment.SIGNALTRAIL_PROCESSOR_METRICS_PORT;
  const port = rawPort === undefined ? undefined : Number(rawPort);
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535))
    throw new ProcessorConfigurationError('Invalid SIGNALTRAIL_PROCESSOR_METRICS_PORT');
  return {
    metrics: port === undefined ? undefined : { host: '127.0.0.1', port },
    consumer: {
      brokers: required('SIGNALTRAIL_REDPANDA_BROKERS')
        .split(',')
        .map((value) => value.trim()),
      topic: required('SIGNALTRAIL_REDPANDA_TOPIC'),
      deadLetterTopic: required('SIGNALTRAIL_REDPANDA_DLQ_TOPIC'),
      groupId: required('SIGNALTRAIL_PROCESSOR_GROUP_ID'),
      batchWaitMs,
    },
    clickhouse: {
      endpoint: required('SIGNALTRAIL_CLICKHOUSE_URL'),
      database: text('SIGNALTRAIL_CLICKHOUSE_DATABASE') || 'signaltrail',
      table: text('SIGNALTRAIL_CLICKHOUSE_TABLE') || 'analytics_events',
      username: required('SIGNALTRAIL_CLICKHOUSE_USERNAME'),
      password: environment.SIGNALTRAIL_CLICKHOUSE_PASSWORD ?? '',
      timeoutMs,
    },
  };
}
