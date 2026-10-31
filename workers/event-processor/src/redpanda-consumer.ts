import { Kafka, logLevel, type EachBatchPayload } from 'kafkajs';
import { createEventProcessor, type ProcessorOptions } from './process-message.ts';
import { createBatchProcessor, type BatchProcessorOptions } from './process-batch.ts';
import { createRetryingHandler } from './retrying-handler.ts';

export interface RedpandaEventConsumerOptions {
  brokers: readonly string[];
  topic: string;
  deadLetterTopic: string;
  groupId: string;
  writeEvent: ProcessorOptions['writeEvent'];
  writeEvents?: BatchProcessorOptions['writeEvents'];
  onProcessed?(kind: 'stored' | 'dead_lettered'): void;
  onRetry?(): void;
  onAttempt?(outcome: 'stored' | 'dead_lettered' | 'failed', seconds: number): void;
}
export function createRedpandaEventConsumer(options: RedpandaEventConsumerOptions) {
  options = { ...options, brokers: [...options.brokers] };
  if (
    !options.brokers.length ||
    options.brokers.some((broker) => typeof broker !== 'string' || !/^\S+:\d+$/.test(broker))
  )
    throw new TypeError('Invalid processor brokers');
  for (const topic of [options.topic, options.deadLetterTopic])
    if (
      typeof topic !== 'string' ||
      !/^[a-zA-Z0-9._-]{1,249}$/.test(topic) ||
      ['.', '..'].includes(topic)
    )
      throw new TypeError('Invalid processor topic');
  if (options.topic === options.deadLetterTopic)
    throw new TypeError('Source and dead-letter topics must differ');
  if (
    typeof options.groupId !== 'string' ||
    !options.groupId.trim() ||
    options.groupId.length > 255
  )
    throw new TypeError('Invalid processor group ID');
  const kafka = new Kafka({
    brokers: [...options.brokers],
    clientId: 'signaltrail-event-processor',
    logLevel: logLevel.ERROR,
    connectionTimeout: 1000,
    requestTimeout: 3000,
    retry: { retries: 2, initialRetryTime: 100, maxRetryTime: 1000 },
  });
  const producer = kafka.producer({
    allowAutoTopicCreation: false,
    idempotent: true,
    maxInFlightRequests: 1,
    retry: { retries: 2, initialRetryTime: 100, maxRetryTime: 1000 },
  });
  const consumer = kafka.consumer({
    groupId: options.groupId,
    allowAutoTopicCreation: false,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
    maxBytesPerPartition: 1024 * 1024,
    maxBytes: 2 * 1024 * 1024,
    retry: {
      retries: 2,
      initialRetryTime: 100,
      maxRetryTime: 1000,
      restartOnFailure: async () => false,
    },
  });
  const controller = new AbortController();
  let closed = false;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const ensureOpen = () => {
    if (closed) throw new Error('Consumer is closed');
  };
  const state = { running: false, stored: 0, deadLettered: 0, retries: 0 };
  let resolveFinished!: () => void;
  let rejectFinished!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // Callers may finish startup before attaching their supervisor.
  void finished.catch(() => {});
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    if (closed) return;
    closed = true;
    state.running = false;
    controller.abort();
    rejectFinished(payload.error);
  });
  const writeDeadLetter: ProcessorOptions['writeDeadLetter'] = async (letter) => {
    await producer.send({
      topic: options.deadLetterTopic,
      acks: -1,
      messages: [
        {
          key: JSON.stringify([letter.source.topic, letter.source.partition, letter.source.offset]),
          value: JSON.stringify(letter),
        },
      ],
    });
  };
  const processMessage = createEventProcessor({
    writeEvent: options.writeEvent,
    writeDeadLetter,
    commit: (cursor) => consumer.commitOffsets([cursor]),
  });
  const handle = createRetryingHandler({
    processMessage,
    signal: controller.signal,
    onAttempt: (outcome, seconds) => options.onAttempt?.(outcome, seconds),
    onProcessed: (kind) => {
      if (kind === 'stored') state.stored++;
      else state.deadLettered++;
      return options.onProcessed?.(kind);
    },
    onRetry: () => {
      state.retries++;
      return options.onRetry?.();
    },
  });
  const eachBatch = async (payload: EachBatchPayload) => {
    const { batch, isRunning, isStale, resolveOffset } = payload;
    const ownsBatch = () => !controller.signal.aborted && isRunning() && !isStale();
    const heartbeat = async () => {
      if (!ownsBatch()) throw new Error('Partition batch is no longer owned');
      await payload.heartbeat();
      if (!ownsBatch()) throw new Error('Partition batch is no longer owned');
    };
    for (let start = 0; start < batch.messages.length;) {
      if (!ownsBatch()) return;
      let end = start;
      let bytes = 0;
      while (end < batch.messages.length && end - start < 100) {
        const size = batch.messages[end]!.value?.byteLength ?? 0;
        if (end > start && bytes + size > 1024 * 1024) break;
        bytes += size;
        end++;
      }
      const messages = batch.messages.slice(start, end).map((message) => ({
        topic: batch.topic,
        partition: batch.partition,
        offset: message.offset,
        value: message.value,
      }));
      let outcomes: ('stored' | 'dead_lettered')[] = [];
      const process = createBatchProcessor({
        writeEvents: options.writeEvents!,
        writeDeadLetter,
        commit: async (cursor) => {
          await heartbeat();
          await consumer.commitOffsets([cursor]);
        },
      });
      const handleBatch = createRetryingHandler({
        signal: controller.signal,
        processMessage: async (input: typeof messages) => {
          outcomes = await process(input);
          return {
            status: outcomes.every((kind) => kind === 'dead_lettered')
              ? ('dead_lettered' as const)
              : ('stored' as const),
          };
        },
        onRetry: () => {
          state.retries++;
          return options.onRetry?.();
        },
        onAttempt: (outcome, seconds) => options.onAttempt?.(outcome, seconds),
      });
      try {
        await handleBatch(messages, heartbeat);
      } catch (error) {
        if (!ownsBatch()) return;
        throw error;
      }
      if (!ownsBatch()) return;
      resolveOffset(messages[messages.length - 1]!.offset);
      for (const kind of outcomes) {
        if (kind === 'stored') state.stored++;
        else state.deadLettered++;
        try {
          void Promise.resolve(options.onProcessed?.(kind)).catch(() => {});
        } catch {
          /* Diagnostics cannot change commits. */
        }
      }
      start = end;
    }
  };
  return {
    snapshot: () => ({ ...state }),
    finished,
    start() {
      if (closed) return Promise.reject(new Error('Consumer is closed'));
      if (state.running) return Promise.resolve();
      if (starting) return starting;
      starting = (async () => {
        const admin = kafka.admin();
        try {
          await admin.connect();
          const topics = await admin.listTopics();
          if (![options.topic, options.deadLetterTopic].every((topic) => topics.includes(topic)))
            throw new Error('Required processor topics are missing');
        } finally {
          await admin.disconnect();
        }
        ensureOpen();
        await producer.connect();
        ensureOpen();
        await consumer.connect();
        ensureOpen();
        await consumer.subscribe({ topic: options.topic, fromBeginning: true });
        ensureOpen();
        await consumer.run({
          autoCommit: false,
          partitionsConsumedConcurrently: 3,
          ...(options.writeEvents
            ? { eachBatchAutoResolve: false, eachBatch }
            : {
                eachMessage: ({
                  topic,
                  partition,
                  message,
                  heartbeat,
                }: import('kafkajs').EachMessagePayload) =>
                  handle(
                    { topic, partition, offset: message.offset, value: message.value },
                    heartbeat,
                  ),
              }),
        });
        ensureOpen();
        state.running = true;
      })()
        .catch(async (error: unknown) => {
          if (!closed) {
            closed = true;
            controller.abort();
            rejectFinished(error);
          }
          await Promise.allSettled([consumer.disconnect(), producer.disconnect()]);
          throw error;
        })
        .finally(() => {
          starting = undefined;
        });
      return starting;
    },
    close() {
      if (closing) return closing;
      closed = true;
      controller.abort();
      state.running = false;
      closing = (async () => {
        await starting?.catch(() => {});
        const errors: unknown[] = [];
        for (const stop of [
          () => consumer.stop(),
          () => consumer.disconnect(),
          () => producer.disconnect(),
        ]) {
          try {
            await stop();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) {
          const failure = new AggregateError(errors, 'Consumer cleanup failed');
          rejectFinished(failure);
          throw failure;
        }
        resolveFinished();
      })();
      return closing;
    },
  };
}
