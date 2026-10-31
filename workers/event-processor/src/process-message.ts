import { createHash } from 'node:crypto';
import {
  PublishedAnalyticsEventSchema,
  type PublishedAnalyticsEvent,
} from '@signaltrail/contracts';

export interface SourceCursor {
  topic: string;
  partition: number;
  offset: string;
}
export interface BrokerMessage extends SourceCursor {
  value: Uint8Array | null;
}
export interface DeadLetterRecord {
  schemaVersion: 1;
  source: SourceCursor;
  reason: 'INVALID_JSON' | 'INVALID_RECORD' | 'MESSAGE_TOO_LARGE';
  payloadBytes: number;
  payloadBase64: string | null;
  payloadSha256: string;
}
export interface ProcessorOptions {
  /** Defaults to 512 KiB; may be lowered. Keeps base64 DLQ records below 1 MiB. */
  maxMessageBytes?: number;
  /** Resolve only after the storage system acknowledges the write. */
  writeEvent(record: PublishedAnalyticsEvent): Promise<void>;
  /** Resolve only after the dead-letter record is durably acknowledged. */
  writeDeadLetter(record: DeadLetterRecord): Promise<void>;
  /** Kafka stores the next offset, represented as a string to avoid precision loss. */
  commit(next: SourceCursor): Promise<void>;
}
function captureSource(message: BrokerMessage): SourceCursor {
  const { topic, partition, offset } = message;
  if (
    typeof topic !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,249}$/.test(topic) ||
    ['.', '..'].includes(topic)
  )
    throw new TypeError('Invalid source topic');
  if (!Number.isSafeInteger(partition) || partition < 0 || partition > 2_147_483_647)
    throw new TypeError('Invalid source partition');
  if (
    typeof offset !== 'string' ||
    !/^(0|[1-9]\d{0,18})$/.test(offset) ||
    BigInt(offset) >= 9_223_372_036_854_775_807n
  )
    throw new TypeError('Invalid source offset');
  return { topic, partition, offset };
}

export function createEventProcessor(options: ProcessorOptions) {
  options = { ...options };
  const maxBytes = options.maxMessageBytes ?? 512 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024)
    throw new RangeError('maxMessageBytes must be from 1 to 524288');
  return async (message: BrokerMessage) => {
    const source = captureSource(message);
    const next = { ...source, offset: (BigInt(source.offset) + 1n).toString() };
    const value = message.value ?? new Uint8Array();
    let decoded: { record: PublishedAnalyticsEvent } | { reason: DeadLetterRecord['reason'] };
    if (value.byteLength > maxBytes) decoded = { reason: 'MESSAGE_TOO_LARGE' };
    else {
      let failureReason: 'INVALID_JSON' | 'INVALID_RECORD' = 'INVALID_JSON';
      try {
        const payload: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(value),
        );
        // JSON decoding succeeded; schema resource failures are record failures.
        failureReason = 'INVALID_RECORD';
        const parsed = PublishedAnalyticsEventSchema.safeParse(payload);
        decoded = parsed.success ? { record: parsed.data } : { reason: 'INVALID_RECORD' };
      } catch {
        decoded = { reason: failureReason };
      }
    }
    if ('reason' in decoded) {
      await options.writeDeadLetter({
        schemaVersion: 1,
        source,
        reason: decoded.reason,
        payloadBytes: value.byteLength,
        payloadBase64: value.byteLength <= maxBytes ? Buffer.from(value).toString('base64') : null,
        payloadSha256: createHash('sha256').update(value).digest('hex'),
      });
      await options.commit(next);
      return { status: 'dead_lettered' as const };
    }
    const record = decoded.record;
    await options.writeEvent(record);
    await options.commit(next);
    return { status: 'stored' as const };
  };
}
