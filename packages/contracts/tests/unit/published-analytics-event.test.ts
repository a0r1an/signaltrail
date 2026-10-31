import { expect, it } from 'vitest';
import { PublishedAnalyticsEventSchema } from '../../src/published-analytics-event.ts';

const record = {
  projectId: 'trusted-project',
  receivedAt: '2026-10-30T23:00:00.000Z',
  event: {
    schemaVersion: 1,
    eventId: 'stable-event-id',
    eventName: 'product_viewed',
    distinctId: 'visitor',
    sessionId: 'session',
    sequence: 0,
    clientTimestamp: '2026-10-30T22:59:58.000Z',
    url: 'https://example.com/products/123',
    properties: { productId: '123' },
    context: { sdkVersion: '0.1.0' },
  },
};
it('accepts the current broker wire record without changing stable IDs or trusted metadata', () => {
  expect(PublishedAnalyticsEventSchema.parse(record)).toEqual(record);
});

it.each([undefined, null, '', '  ', 12])(
  'rejects an invalid trusted project ID: %j',
  (projectId) => {
    expect(PublishedAnalyticsEventSchema.safeParse({ ...record, projectId }).success).toBe(false);
  },
);
it.each([undefined, null, 'yesterday', '2026-99-30T23:00:00Z'])(
  'rejects an invalid server receive timestamp: %j',
  (receivedAt) => {
    expect(PublishedAnalyticsEventSchema.safeParse({ ...record, receivedAt }).success).toBe(false);
  },
);
it('rejects an invalid embedded event instead of treating broker presence as validation', () => {
  expect(
    PublishedAnalyticsEventSchema.safeParse({
      ...record,
      event: { ...record.event, schemaVersion: 2 },
    }).success,
  ).toBe(false);
});
it('does not accept a raw SDK event without server metadata', () => {
  expect(PublishedAnalyticsEventSchema.safeParse(record.event).success).toBe(false);
});
it('preserves additive wire compatibility while removing unrecognized client identity fields', () => {
  expect(
    PublishedAnalyticsEventSchema.parse({
      ...record,
      futureMetadata: true,
      event: { ...record.event, projectId: 'forged', projectKey: 'public-key' },
    }),
  ).toEqual(record);
});
