import { expect, it } from 'vitest';
import { AnalyticsEventSchema } from '../../src/analytics-event.ts';
const event = {
  schemaVersion: 1,
  eventId: 'event-1',
  eventName: 'view',
  distinctId: 'account-1',
  sessionId: 'session-1',
  clientTimestamp: '2026-11-05T12:00:00Z',
  sequence: 0,
  url: 'https://example.com/',
  properties: {},
  context: { sdkVersion: '0.1.0' },
};
it.each(['identified', 'link'])('preserves explicit %s identity metadata', (kind) => {
  const identity = { kind, anonymousId: 'anonymous-1', userId: 'account-1' };
  expect(
    AnalyticsEventSchema.parse({
      ...event,
      eventName: kind === 'link' ? '$identify' : 'view',
      context: { ...event.context, identity },
    }).context,
  ).toEqual({ ...event.context, identity });
});
it.each([
  { kind: 'unknown', anonymousId: 'a', userId: 'b' },
  { kind: 'link', anonymousId: '', userId: 'b' },
  { kind: 'link', anonymousId: 'a', userId: 'é'.repeat(2049) },
  { kind: 'identified', anonymousId: 'a', userId: '\ud800' },
  { kind: 'link', anonymousId: 'a', userId: 'b', extra: true },
])('rejects invalid identity context %#', (identity) => {
  expect(
    AnalyticsEventSchema.safeParse({ ...event, context: { ...event.context, identity } }).success,
  ).toBe(false);
});
