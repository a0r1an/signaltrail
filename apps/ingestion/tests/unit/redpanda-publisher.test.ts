import { expect, it } from 'vitest';
import { createRedpandaPublisher, type PublishedEvent } from '../../src/index.ts';
const record: PublishedEvent = {
  projectId: 'project',
  receivedAt: '2026-10-22T12:00:00.000Z',
  event: {
    schemaVersion: 1,
    eventId: 'event',
    eventName: 'view',
    distinctId: 'visitor',
    sessionId: 'session',
    sequence: 0,
    clientTimestamp: '2026-10-22T12:00:00.000Z',
    url: 'https://example.com',
    properties: {},
    context: { sdkVersion: '0.1.0' },
  },
};
it('rejects publication before connecting without attempting delivery', async () => {
  const publisher = createRedpandaPublisher({ brokers: ['127.0.0.1:19092'], topic: 'test-topic' });
  try {
    await expect(publisher.publish(record, new AbortController().signal)).rejects.toThrow(
      'not connected',
    );
  } finally {
    await publisher.close();
  }
});
it('allows repeated close and prevents a closed publisher from reopening or publishing', async () => {
  const publisher = createRedpandaPublisher({ brokers: ['127.0.0.1:19092'], topic: 'test-topic' });
  await Promise.all([publisher.close(), publisher.close()]);
  await expect(publisher.connect()).rejects.toThrow('closed');
  await expect(publisher.publish(record, new AbortController().signal)).rejects.toThrow(
    'not connected',
  );
});
