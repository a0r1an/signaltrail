import type { PublishedAnalyticsEvent } from '@signaltrail/contracts';
import {
  captureSource,
  createEventProcessor,
  type BrokerMessage,
  type ProcessorOptions,
  type SourceCursor,
} from './process-message.ts';

export interface BatchProcessorOptions extends Omit<ProcessorOptions, 'writeEvent'> {
  signal?: AbortSignal;
  writeEvents(records: readonly PublishedAnalyticsEvent[]): Promise<void>;
}

export function createBatchProcessor(options: BatchProcessorOptions) {
  options = { ...options };
  return async (messages: readonly BrokerMessage[]) => {
    if (messages.length > 100) throw new RangeError('Processor chunks are limited to 100 messages');
    const captured = messages.map((message) => ({
      ...captureSource(message),
      value: message.value,
    }));
    let bytes = 0;
    for (let index = 0; index < captured.length; index++) {
      const message = captured[index]!;
      const previous = captured[index - 1];
      bytes += message.value?.byteLength ?? 0;
      if (
        previous &&
        (message.topic !== previous.topic ||
          message.partition !== previous.partition ||
          BigInt(message.offset) <= BigInt(previous.offset))
      )
        throw new TypeError('Chunk must contain ordered messages from one partition');
    }
    if (captured.length > 1 && bytes > 1024 * 1024)
      throw new RangeError('Processor chunk exceeds 1 MiB');
    // Validate the aggregate bound before copying any payload buffers.
    const inputs = captured.map((message) => ({
      ...message,
      value: message.value && captured.length > 1 ? new Uint8Array(message.value) : message.value,
    }));
    const outcomes: ('stored' | 'dead_lettered')[] = [];
    const records: PublishedAnalyticsEvent[] = [];
    let next: SourceCursor | undefined;
    const process = createEventProcessor({
      ...options,
      writeEvent: async (record) => {
        records.push(record);
      },
      commit: async (cursor) => {
        next = cursor;
      },
    });
    for (const message of inputs) {
      options.signal?.throwIfAborted();
      outcomes.push((await process(message)).status);
    }
    options.signal?.throwIfAborted();
    if (records.length) await options.writeEvents(records);
    options.signal?.throwIfAborted();
    if (next) await options.commit(next);
    return outcomes;
  };
}
