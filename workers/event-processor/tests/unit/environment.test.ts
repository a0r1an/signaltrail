import { expect, it } from 'vitest';
import { parseProcessorEnvironment } from '../../src/environment.ts';

const environment = {
  SIGNALTRAIL_REDPANDA_BROKERS: '127.0.0.1:29092, localhost:29093',
  SIGNALTRAIL_REDPANDA_TOPIC: 'analytics',
  SIGNALTRAIL_REDPANDA_DLQ_TOPIC: 'analytics.dlq',
  SIGNALTRAIL_PROCESSOR_GROUP_ID: 'processor-test',
  SIGNALTRAIL_CLICKHOUSE_URL: 'http://127.0.0.1:38123',
  SIGNALTRAIL_CLICKHOUSE_USERNAME: 'writer',
  SIGNALTRAIL_CLICKHOUSE_PASSWORD: ' local-password ',
};
it('reads explicit dependency coordinates and preserves password bytes', () => {
  expect(parseProcessorEnvironment(environment)).toEqual({
    consumer: {
      brokers: ['127.0.0.1:29092', 'localhost:29093'],
      topic: 'analytics',
      deadLetterTopic: 'analytics.dlq',
      groupId: 'processor-test',
      batchWaitMs: 0,
    },
    clickhouse: {
      endpoint: 'http://127.0.0.1:38123',
      database: 'signaltrail',
      table: 'analytics_events',
      username: 'writer',
      password: ' local-password ',
      timeoutMs: 5000,
    },
  });
});

it.each(Object.keys(environment))(
  'rejects missing %s instead of using implicit connection defaults',
  (name) => {
    const missing: Record<string, string | undefined> = { ...environment };
    delete missing[name];
    expect(() => parseProcessorEnvironment(missing)).toThrow(name);
  },
);

it.each(['', '0', '-1', '1.5', '30001', 'secret-invalid-timeout'])(
  'rejects invalid request deadlines without repeating their value',
  (timeout) => {
    try {
      parseProcessorEnvironment({ ...environment, SIGNALTRAIL_CLICKHOUSE_TIMEOUT_MS: timeout });
      expect.fail('Expected invalid deadline');
    } catch (error) {
      expect(String(error)).toContain('SIGNALTRAIL_CLICKHOUSE_TIMEOUT_MS');
      expect(String(error)).not.toContain('secret-invalid-timeout');
      expect(String(error)).not.toContain(environment.SIGNALTRAIL_CLICKHOUSE_PASSWORD);
    }
  },
);

it('disables metrics by default and binds an explicitly enabled endpoint to loopback', () => {
  expect(parseProcessorEnvironment(environment).metrics).toBeUndefined();
  expect(
    parseProcessorEnvironment({ ...environment, SIGNALTRAIL_PROCESSOR_METRICS_PORT: '9466' })
      .metrics,
  ).toEqual({ host: '127.0.0.1', port: 9466 });
});
it.each(['', '0', '-1', '65536', '1.5', 'invalid-secret-port'])(
  'rejects invalid metrics ports without echoing their value',
  (port) => {
    expect(() =>
      parseProcessorEnvironment({ ...environment, SIGNALTRAIL_PROCESSOR_METRICS_PORT: port }),
    ).toThrow('Invalid SIGNALTRAIL_PROCESSOR_METRICS_PORT');
  },
);

it('supports explicit bounded collection and a zero-wait compatibility control', () => {
  for (const batchWaitMs of [0, 200, 1000])
    expect(
      parseProcessorEnvironment({
        ...environment,
        SIGNALTRAIL_PROCESSOR_BATCH_WAIT_MS: String(batchWaitMs),
      }).consumer.batchWaitMs,
    ).toBe(batchWaitMs);
});
it.each(['', '-1', '1.5', '1001', 'secret-invalid-wait'])(
  'rejects an invalid collection window',
  (value) => {
    expect(() =>
      parseProcessorEnvironment({ ...environment, SIGNALTRAIL_PROCESSOR_BATCH_WAIT_MS: value }),
    ).toThrow('Invalid SIGNALTRAIL_PROCESSOR_BATCH_WAIT_MS');
  },
);
