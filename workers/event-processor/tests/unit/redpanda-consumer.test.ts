import { beforeEach, expect, it, vi } from 'vitest';
import type { ConsumerRunConfig, EachMessagePayload, EachBatchPayload } from 'kafkajs';
import { createRedpandaEventConsumer } from '../../src/redpanda-consumer.ts';
import { record } from '../fixtures.ts';

const clients = vi.hoisted(() => ({
  producer: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() },
  consumer: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    run: vi.fn(),
    stop: vi.fn(),
    commitOffsets: vi.fn(),
    on: vi.fn(),
    events: { CRASH: 'consumer.crash' },
  },
  admin: { connect: vi.fn(), disconnect: vi.fn(), listTopics: vi.fn() },
}));
vi.mock('kafkajs', () => ({
  logLevel: { ERROR: 1 },
  Kafka: class {
    producer() {
      return clients.producer;
    }
    consumer() {
      return clients.consumer;
    }
    admin() {
      return clients.admin;
    }
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  clients.admin.listTopics.mockResolvedValue(['analytics', 'analytics.dlq']);
});
const payload = (): EachMessagePayload => ({
  topic: 'analytics',
  partition: 0,
  message: {
    key: null,
    value: Buffer.from(JSON.stringify(record)),
    offset: '3',
    timestamp: '0',
    attributes: 0,
    headers: {},
  },
  heartbeat: async () => {},
  pause: () => () => {},
});

it('disables automatic commits and confirms storage before committing through the Kafka client', async () => {
  let acknowledge!: () => void;
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-test',
    writeEvent: () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  });
  try {
    await worker.start();
    expect(clients.consumer.run).toHaveBeenCalledTimes(1);
    const config = clients.consumer.run.mock.calls[0]![0] as ConsumerRunConfig;
    expect(config.autoCommit).toBe(false);
    const processing = config.eachMessage!(payload());
    expect(clients.consumer.commitOffsets).not.toHaveBeenCalled();
    acknowledge();
    await processing;
    expect(clients.consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: 'analytics', partition: 0, offset: '4' },
    ]);
    expect(worker.snapshot()).toMatchObject({ stored: 1 });
  } finally {
    await worker.close();
  }
});

it('waits for the DLQ producer acknowledgement before committing a poison message', async () => {
  let acknowledge!: () => void;
  clients.producer.send.mockReturnValueOnce(
    new Promise((resolve) => {
      acknowledge = () => resolve([]);
    }),
  );
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-test',
    writeEvent: async () => {
      throw new Error('Invalid event stored');
    },
  });
  try {
    await worker.start();
    const config = clients.consumer.run.mock.calls[0]![0] as ConsumerRunConfig;
    const input = payload();
    input.message.value = Buffer.from('broken');
    const processing = config.eachMessage!(input);
    expect(clients.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(clients.producer.send).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'analytics.dlq', acks: -1 }),
    );
    acknowledge();
    await processing;
    expect(clients.consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: 'analytics', partition: 0, offset: '4' },
    ]);
    expect(worker.snapshot()).toMatchObject({ deadLettered: 1 });
  } finally {
    await worker.close();
  }
});

it('refuses startup when the dead-letter topic is missing rather than creating it implicitly', async () => {
  clients.admin.listTopics.mockResolvedValueOnce(['analytics']);
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-test',
    writeEvent: async () => {},
  });
  try {
    await expect(worker.start()).rejects.toThrow('Required processor topics are missing');
    expect(clients.consumer.run).not.toHaveBeenCalled();
  } finally {
    await worker.close();
  }
});

it.each([
  { deadLetterTopic: 'analytics' },
  { deadLetterTopic: 'invalid topic' },
  { brokers: [] },
  { brokers: ['not-a-broker'] },
  { groupId: '   ' },
])('rejects unsafe processor configuration before connecting: %j', (invalid) => {
  expect(() =>
    createRedpandaEventConsumer({
      brokers: ['127.0.0.1:29092'],
      topic: 'analytics',
      deadLetterTopic: 'analytics.dlq',
      groupId: 'processor-test',
      writeEvent: async () => {},
      ...invalid,
    }),
  ).toThrow();
  expect(clients.consumer.connect).not.toHaveBeenCalled();
});

it('coalesces concurrent lifecycle calls and cannot restart after close', async () => {
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-test',
    writeEvent: async () => {},
  });
  try {
    await Promise.all([worker.start(), worker.start()]);
    expect(clients.producer.connect).toHaveBeenCalledTimes(1);
    expect(clients.consumer.run).toHaveBeenCalledTimes(1);
    await Promise.all([worker.close(), worker.close()]);
    expect(clients.consumer.stop).toHaveBeenCalledTimes(1);
    expect(clients.producer.disconnect).toHaveBeenCalledTimes(1);
    await expect(worker.start()).rejects.toThrow('Consumer is closed');
  } finally {
    await worker.close();
  }
});

it('does not begin consuming if shutdown was requested during subscription', async () => {
  let release!: () => void;
  let subscribing!: () => void;
  const begun = new Promise<void>((resolve) => {
    subscribing = resolve;
  });
  clients.consumer.subscribe.mockImplementationOnce(async () => {
    subscribing();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-test',
    writeEvent: async () => {},
  });
  const starting = expect(worker.start()).rejects.toThrow('Consumer is closed');
  await begun;
  const closing = worker.close();
  release();
  await starting;
  await closing;
  expect(clients.consumer.run).not.toHaveBeenCalled();
});

it('attempts every disconnect even when stopping the consumer fails', async () => {
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-test',
    writeEvent: async () => {},
  });
  await worker.start();
  clients.consumer.stop.mockRejectedValueOnce(new Error('Stop failed'));
  await expect(worker.close()).rejects.toThrow();
  expect(clients.consumer.disconnect).toHaveBeenCalled();
  expect(clients.producer.disconnect).toHaveBeenCalled();
});

it('signals a runtime consumer crash to its supervisor and marks itself not running', async () => {
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-test',
    writeEvent: async () => {},
  });
  try {
    await worker.start();
    expect(clients.consumer.on).toHaveBeenCalledWith('consumer.crash', expect.any(Function));
    const listener = clients.consumer.on.mock.calls.find(
      (call) => call[0] === 'consumer.crash',
    )![1] as (event: { payload: { error: Error } }) => void;
    const failure = new Error('Broker unavailable');
    const finished = expect(worker.finished).rejects.toBe(failure);
    listener({ payload: { error: failure } });
    await finished;
    expect(worker.snapshot().running).toBe(false);
    await expect(worker.start()).rejects.toThrow('Consumer is closed');
  } finally {
    await worker.close();
  }
});

it('isolates asynchronous diagnostic rejections after retry and committed completion', async () => {
  vi.useFakeTimers();
  const writeEvent = vi
    .fn()
    .mockRejectedValueOnce(new Error('storage unavailable'))
    .mockResolvedValue(undefined);
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-test',
    writeEvent,
    onRetry: async () => {
      throw new Error('retry diagnostics rejected');
    },
    onProcessed: async () => {
      throw new Error('completion diagnostics rejected');
    },
  });
  try {
    await worker.start();
    const config = clients.consumer.run.mock.calls[0]![0] as ConsumerRunConfig;
    const processing = config.eachMessage!(payload());
    await vi.advanceTimersByTimeAsync(1000);
    await processing;
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.snapshot()).toMatchObject({ stored: 1, retries: 1 });
    expect(clients.consumer.commitOffsets).toHaveBeenCalledTimes(1);
  } finally {
    await worker.close();
    vi.useRealTimers();
  }
});

it('uses bounded partition batches and keeps all offsets pending until the batch insert acknowledges', async () => {
  let acknowledge!: () => void;
  const writeEvents = vi.fn<(records: readonly unknown[]) => Promise<void>>(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-batch-test',
    writeEvent: async () => {},
    writeEvents,
  });
  try {
    await worker.start();
    const config = clients.consumer.run.mock.calls[0]![0] as ConsumerRunConfig;
    expect(config.eachBatch).toBeTypeOf('function');
    expect(config.eachBatchAutoResolve).toBe(false);
    const input = payload();
    const batch = {
      batch: {
        topic: input.topic,
        partition: input.partition,
        messages: [input.message, { ...input.message, offset: '4' }],
      },
      heartbeat: input.heartbeat,
      isRunning: () => true,
      isStale: () => false,
      resolveOffset: vi.fn(),
    } as unknown as EachBatchPayload;
    const pending = config.eachBatch!(batch);
    await vi.waitFor(() => expect(writeEvents).toHaveBeenCalledTimes(1));
    expect(writeEvents.mock.calls[0]![0]).toHaveLength(2);
    expect(clients.consumer.commitOffsets).not.toHaveBeenCalled();
    acknowledge();
    await pending;
    expect(clients.consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: 'analytics', partition: 0, offset: '5' },
    ]);
    expect(worker.snapshot().stored).toBe(2);
  } finally {
    await worker.close();
  }
});

it('does not commit a batch whose ownership expires while storage is pending', async () => {
  let stale = false;
  let acknowledge!: () => void;
  const writeEvents = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-stale-test',
    writeEvent: async () => {},
    writeEvents,
  });
  try {
    await worker.start();
    const config = clients.consumer.run.mock.calls[0]![0] as ConsumerRunConfig;
    const input = payload();
    const batch = {
      batch: { topic: input.topic, partition: input.partition, messages: [input.message] },
      heartbeat: input.heartbeat,
      isRunning: () => true,
      isStale: () => stale,
      resolveOffset: vi.fn(),
    } as unknown as EachBatchPayload;
    const pending = config.eachBatch!(batch);
    await vi.waitFor(() => expect(writeEvents).toHaveBeenCalledTimes(1));
    stale = true;
    acknowledge();
    await pending;
    expect(clients.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(batch.resolveOffset).not.toHaveBeenCalled();
    expect(worker.snapshot().stored).toBe(0);
  } finally {
    await worker.close();
  }
});

it('splits fetched partitions into chunks of at most 100 events', async () => {
  const onChunk = vi.fn<(count: number, bytes: number) => Promise<void>>(async () => {
    throw new Error('diagnostics rejected');
  });
  const writeEvents = vi.fn<(records: readonly unknown[]) => Promise<void>>(async () => {});
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-chunk-test',
    onChunk,
    writeEvent: async () => {},
    writeEvents,
  });
  try {
    await worker.start();
    const config = clients.consumer.run.mock.calls[0]![0] as ConsumerRunConfig;
    const input = payload();
    await config.eachBatch!({
      batch: {
        topic: input.topic,
        partition: input.partition,
        messages: Array.from({ length: 205 }, (_, index) => ({
          ...input.message,
          offset: String(index),
        })),
      },
      heartbeat: input.heartbeat,
      isRunning: () => true,
      isStale: () => false,
      resolveOffset: vi.fn(),
    } as unknown as EachBatchPayload);
    expect(writeEvents.mock.calls.map(([records]) => records.length)).toEqual([100, 100, 5]);
    expect(
      clients.consumer.commitOffsets.mock.calls.map(
        ([offsets]) => (offsets as { offset: string }[])[0]!.offset,
      ),
    ).toEqual(['100', '200', '205']);
    expect(worker.snapshot().stored).toBe(205);
    expect(onChunk.mock.calls.map(([count]) => count)).toEqual([100, 100, 5]);
  } finally {
    await worker.close();
  }
});

it('does not start another sink write after a partition batch becomes stale', async () => {
  let stale = false;
  clients.producer.send.mockImplementationOnce(async () => {
    stale = true;
    return [];
  });
  const writeEvents = vi.fn(async () => {});
  const worker = createRedpandaEventConsumer({
    brokers: ['127.0.0.1:29092'],
    topic: 'analytics',
    deadLetterTopic: 'analytics.dlq',
    groupId: 'processor-stale-dlq-test',
    writeEvent: async () => {},
    writeEvents,
  });
  try {
    await worker.start();
    const config = clients.consumer.run.mock.calls[0]![0] as ConsumerRunConfig;
    const input = payload();
    await config.eachBatch!({
      batch: {
        topic: input.topic,
        partition: input.partition,
        messages: [0, 1].map((index) => ({
          ...input.message,
          offset: String(index),
          value: Buffer.from('broken'),
        })),
      },
      heartbeat: input.heartbeat,
      isRunning: () => true,
      isStale: () => stale,
      resolveOffset: vi.fn(),
    } as unknown as EachBatchPayload);
    expect(clients.producer.send).toHaveBeenCalledTimes(1);
    expect(writeEvents).not.toHaveBeenCalled();
    expect(clients.consumer.commitOffsets).not.toHaveBeenCalled();
  } finally {
    await worker.close();
  }
});
