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
  return {
    consumer: {
      brokers: required('SIGNALTRAIL_REDPANDA_BROKERS')
        .split(',')
        .map((value) => value.trim()),
      topic: required('SIGNALTRAIL_REDPANDA_TOPIC'),
      deadLetterTopic: required('SIGNALTRAIL_REDPANDA_DLQ_TOPIC'),
      groupId: required('SIGNALTRAIL_PROCESSOR_GROUP_ID'),
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
