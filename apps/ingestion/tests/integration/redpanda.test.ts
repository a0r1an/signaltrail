import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Kafka, logLevel, type KafkaMessage } from 'kafkajs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createIngestionServer,
  createRedpandaPublisher,
  type PublishedEvent,
} from '../../src/index.ts';

const brokers = (process.env.SIGNALTRAIL_REDPANDA_BROKERS ?? '127.0.0.1:19092').split(',');
const topic = `signaltrail-integration-${randomUUID()}`;
const kafka = new Kafka({
  clientId: 'signaltrail-integration',
  brokers,
  logLevel: logLevel.NOTHING,
  retry: { retries: 2 },
});
const admin = kafka.admin();
const event = {
  schemaVersion: 1,
  eventId: 'event-one',
  eventName: 'view',
  distinctId: 'visitor',
  sessionId: 'session',
  sequence: 0,
  clientTimestamp: '2026-10-22T12:00:00.000Z',
  url: 'https://example.com',
  properties: {},
  context: { sdkVersion: '0.1.0' },
};
beforeAll(async () => {
  await admin.connect();
  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      {
        topic,
        numPartitions: 3,
        replicationFactor: 1,
        configEntries: [
          { name: 'write.caching', value: 'false' },
          { name: 'cleanup.policy', value: 'delete' },
          { name: 'retention.ms', value: '604800000' },
        ],
      },
    ],
  });
});
afterAll(async () => {
  try {
    await admin.deleteTopics({ topics: [topic] });
  } finally {
    await admin.disconnect();
  }
});
async function consume(
  count: number,
  select: (message: KafkaMessage) => boolean = () => true,
): Promise<KafkaMessage[]> {
  const consumer = kafka.consumer({
    groupId: `signaltrail-test-${randomUUID()}`,
    sessionTimeout: 6000,
    heartbeatInterval: 1000,
  });
  const records: KafkaMessage[] = [];
  let done!: (records: KafkaMessage[]) => void;
  const received = new Promise<KafkaMessage[]>((resolve) => {
    done = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (select(message)) records.push(message);
        if (records.length >= count) done([...records]);
      },
    });
    return await Promise.race([
      received,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out consuming acknowledged events')),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await consumer.disconnect();
  }
}
it('accepts only acknowledged valid events and stores trusted metadata in separate broker records', async () => {
  const publisher = createRedpandaPublisher({ brokers, topic });
  await publisher.connect();
  const server = createIngestionServer({
    resolveProjectKey: (key) => (key === 'test-key' ? 'trusted-project' : undefined),
    publish: publisher.publish,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/events`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          events: [
            { ...event, projectId: 'forged' },
            { ...event, eventId: '' },
            { ...event, eventId: 'event-two', sequence: 1 },
          ],
        }),
      },
    );
    expect(await response.json()).toEqual({
      results: [
        { index: 0, eventId: 'event-one', status: 'accepted' },
        { index: 1, status: 'rejected', code: 'INVALID_EVENT' },
        { index: 2, eventId: 'event-two', status: 'accepted' },
      ],
    });
    const messages = await consume(2);
    const records = messages.map(
      (message) => JSON.parse(message.value!.toString()) as PublishedEvent,
    );
    expect(records.map((record) => record.event.eventId).sort()).toEqual([
      'event-one',
      'event-two',
    ]);
    for (const record of records) {
      expect(record.projectId).toBe('trusted-project');
      expect(Number.isNaN(Date.parse(record.receivedAt))).toBe(false);
      expect(record.event).not.toHaveProperty('projectId');
    }
    expect(
      messages.every(
        (message) => message.key?.toString() === JSON.stringify(['trusted-project', 'session']),
      ),
    ).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await publisher.close();
  }
});
it('returns retry when the broker cannot publish to a missing topic without auto-creating it', async () => {
  const missing = `signaltrail-missing-${randomUUID()}`;
  const publisher = createRedpandaPublisher({ brokers, topic: missing });
  await publisher.connect();
  try {
    const { createIngestionHandler } = await import('../../src/index.ts');
    const handle = createIngestionHandler({
      resolveProjectKey: () => 'trusted-project',
      publish: publisher.publish,
    });
    const response = await handle(
      new Request('http://localhost/v1/events', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [event] }),
      }),
    );
    expect(await response.json()).toEqual({
      results: [
        {
          index: 0,
          eventId: event.eventId,
          status: 'retry',
          code: 'PUBLICATION_UNCONFIRMED',
          retryAfterMs: 1000,
        },
      ],
    });
    expect(await admin.listTopics()).not.toContain(missing);
  } finally {
    await publisher.close();
  }
});
it('does not send an already-aborted event to the broker', async () => {
  const publisher = createRedpandaPublisher({ brokers, topic });
  await publisher.connect();
  try {
    const before = await admin.fetchTopicOffsets(topic);
    const controller = new AbortController();
    controller.abort(new Error('Attempt already cancelled'));
    await expect(
      publisher.publish(
        {
          projectId: 'trusted-project',
          receivedAt: new Date().toISOString(),
          event: { ...event, schemaVersion: 1 },
        },
        controller.signal,
      ),
    ).rejects.toThrow('Attempt already cancelled');
    expect(await admin.fetchTopicOffsets(topic)).toEqual(before);
  } finally {
    await publisher.close();
  }
});

it('drains an in-flight send before disconnecting and rejects new work after close', async () => {
  const publisher = createRedpandaPublisher({ brokers, topic });
  await publisher.connect();
  const record: PublishedEvent = {
    projectId: 'trusted-project',
    receivedAt: new Date().toISOString(),
    event: { ...event, schemaVersion: 1, eventId: 'shutdown-drain' },
  };
  const sending = publisher.publish(record, new AbortController().signal);
  const closing = publisher.close();
  await expect(sending).resolves.toBeUndefined();
  await closing;
  await expect(publisher.publish(record, new AbortController().signal)).rejects.toThrow(
    'not connected',
  );
  const messages = await consume(
    1,
    (message) =>
      (JSON.parse(message.value!.toString()) as PublishedEvent).event.eventId ===
      record.event.eventId,
  );
  expect(JSON.parse(messages[0]!.value!.toString())).toEqual(record);
});
