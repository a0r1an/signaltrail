import { Kafka, logLevel } from 'kafkajs';
import type { PublishedEvent } from './handler.ts';

export interface RedpandaPublisherOptions {
  brokers: readonly string[];
  topic: string;
  clientId?: string;
}
export interface RedpandaPublisher {
  connect(): Promise<void>;
  publish(record: PublishedEvent, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export function createRedpandaPublisher(options: RedpandaPublisherOptions): RedpandaPublisher {
  const brokers = [...options.brokers];
  const topic = options.topic;
  if (
    !brokers.length ||
    brokers.some((broker) => typeof broker !== 'string' || !/^\S+:\d+$/.test(broker))
  )
    throw new TypeError('brokers must contain host:port addresses');
  if (
    typeof topic !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,249}$/.test(topic) ||
    ['.', '..'].includes(topic)
  )
    throw new TypeError('Invalid Redpanda topic');
  const kafka = new Kafka({
    brokers,
    clientId: options.clientId ?? 'signaltrail-ingestion',
    logLevel: logLevel.ERROR,
    connectionTimeout: 1000,
    requestTimeout: 3000,
    retry: { retries: 2, initialRetryTime: 100, maxRetryTime: 1000 },
  });
  const producer = kafka.producer({
    allowAutoTopicCreation: false,
    idempotent: true,
    maxInFlightRequests: 1,
    // Bound background retries; this does not provide application-level exactly-once delivery.
    retry: { retries: 2, initialRetryTime: 100, maxRetryTime: 1000 },
  });
  let connected = false;
  let closed = false;
  let connection: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  return {
    connect() {
      if (closed) return Promise.reject(new Error('Publisher is closed'));
      if (connected) return Promise.resolve();
      if (connection) return connection;
      connection = producer
        .connect()
        .then(() => {
          if (closed) throw new Error('Publisher is closed');
          connected = true;
        })
        .catch(async (error) => {
          await producer.disconnect().catch(() => {});
          throw error;
        })
        .finally(() => {
          connection = undefined;
        });
      return connection;
    },
    async publish(record, signal) {
      if (closed || !connected) throw new Error('Publisher is not connected');
      signal.throwIfAborted();
      const send = producer.send({
        topic,
        acks: -1,
        timeout: 3000,
        messages: [
          {
            key: JSON.stringify([record.projectId, record.event.sessionId]),
            value: JSON.stringify(record),
            headers: {
              'event-id': record.event.eventId,
              'schema-version': String(record.event.schemaVersion),
            },
          },
        ],
      });
      inFlight.add(send);
      void send.then(
        () => inFlight.delete(send),
        () => inFlight.delete(send),
      );
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      try {
        await Promise.race([send, aborted]);
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await connection?.catch(() => {});
        await Promise.allSettled([...inFlight]);
        await producer.disconnect();
        connected = false;
      })();
      return closing;
    },
  };
}
