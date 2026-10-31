import { beforeEach, expect, it, vi } from 'vitest';
import { createRedpandaPublisher } from '../../src/redpanda-publisher.ts';
import type { PublishedEvent } from '../../src/handler.ts';

const producer = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() }));
vi.mock('kafkajs', () => ({
  logLevel: { ERROR: 1 },
  Kafka: class {
    producer() {
      return producer;
    }
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  producer.connect.mockResolvedValue(undefined);
  producer.disconnect.mockResolvedValue(undefined);
});
const record: PublishedEvent = {
  projectId: 'project',
  receivedAt: '2026-10-31T12:00:00.000Z',
  event: {
    schemaVersion: 1,
    eventId: 'stable-id',
    eventName: 'view',
    distinctId: 'visitor',
    sessionId: 'session',
    sequence: 0,
    clientTimestamp: '2026-10-31T12:00:00.000Z',
    url: 'https://example.com',
    properties: {},
    context: { sdkVersion: 'test' },
  },
};

it('keeps each reservation after a caller aborts until the shared broker send settles', async () => {
  let acknowledge!: () => void;
  producer.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const publisher = createRedpandaPublisher({
    brokers: ['broker:9092'],
    topic: 'analytics',
    maxOutstandingEvents: 2,
  });
  await publisher.connect();
  const controller = new AbortController();
  const first = expect(publisher.publish(record, controller.signal)).rejects.toThrow();
  const second = publisher.publish(
    { ...record, event: { ...record.event, eventId: 'second-id' } },
    new AbortController().signal,
  );
  controller.abort();
  await first;
  expect(publisher.snapshot().outstandingEvents).toBe(2);
  await expect(publisher.publish(record, new AbortController().signal)).rejects.toThrow('capacity');
  await vi.waitFor(() => expect(producer.send).toHaveBeenCalledTimes(1));
  expect(producer.send.mock.calls[0]![0]).toMatchObject({
    acks: -1,
    messages: [{ headers: { 'event-id': 'stable-id' } }, { headers: { 'event-id': 'second-id' } }],
  });
  acknowledge();
  await second;
  expect(publisher.snapshot()).toMatchObject({
    outstandingEvents: 0,
    completed: 2,
    lateCompletions: 1,
    refused: 1,
  });
  await publisher.close();
});

it('drains already admitted same-turn records before disconnecting during close', async () => {
  let acknowledge!: () => void;
  producer.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const publisher = createRedpandaPublisher({ brokers: ['broker:9092'], topic: 'analytics' });
  await publisher.connect();
  const pending = publisher.publish(record, new AbortController().signal);
  const closing = publisher.close();
  await vi.waitFor(() => expect(producer.send).toHaveBeenCalledTimes(1));
  expect(producer.disconnect).not.toHaveBeenCalled();
  await expect(publisher.publish(record, new AbortController().signal)).rejects.toThrow(
    'not connected',
  );
  acknowledge();
  await pending;
  await closing;
  expect(producer.disconnect).toHaveBeenCalledTimes(1);
  expect(publisher.snapshot().completed).toBe(1);
});

it('leaves every record unconfirmed and releases all reservations on a grouped send failure', async () => {
  producer.send.mockRejectedValueOnce(new Error('broker unavailable'));
  const publisher = createRedpandaPublisher({ brokers: ['broker:9092'], topic: 'analytics' });
  await publisher.connect();
  const results = await Promise.allSettled([
    publisher.publish(record, new AbortController().signal),
    publisher.publish(record, new AbortController().signal),
  ]);
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  expect(producer.send).toHaveBeenCalledTimes(1);
  expect(publisher.snapshot()).toMatchObject({ outstandingEvents: 0, completed: 0, failed: 2 });
  await publisher.close();
});

it('preserves trusted tenant and session keys for records sharing a producer request', async () => {
  producer.send.mockResolvedValueOnce([]);
  const publisher = createRedpandaPublisher({ brokers: ['broker:9092'], topic: 'analytics' });
  await publisher.connect();
  await Promise.all([
    publisher.publish(record, new AbortController().signal),
    publisher.publish({ ...record, projectId: 'other-project' }, new AbortController().signal),
  ]);
  const sent = producer.send.mock.calls[0]![0] as { messages: { key: string; value: string }[] };
  expect(sent.messages.map((entry) => JSON.parse(entry.key) as unknown)).toEqual([
    ['project', 'session'],
    ['other-project', 'session'],
  ]);
  expect(
    sent.messages.map((entry) => (JSON.parse(entry.value) as PublishedEvent).projectId),
  ).toEqual(['project', 'other-project']);
  await publisher.close();
});
