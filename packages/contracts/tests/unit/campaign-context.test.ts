import { expect, it } from 'vitest';
import { AnalyticsEventSchema } from '../../src/analytics-event.ts';
const event = {
  schemaVersion: 1,
  eventId: 'event-1',
  eventName: 'page_viewed',
  distinctId: 'visitor-1',
  sessionId: 'session-1',
  clientTimestamp: '2026-11-05T12:00:00.000Z',
  sequence: 0,
  url: 'https://example.com/',
  properties: {},
  context: { sdkVersion: '0.1.0' },
};
it('preserves separate campaign context without requiring it for existing events', () => {
  const campaign = {
    utm_source: 'email',
    utm_medium: 'newsletter',
    utm_campaign: 'launch',
    utm_term: 'red shoes',
    utm_content: 'hero',
  };
  expect(
    AnalyticsEventSchema.parse({ ...event, context: { ...event.context, campaign } }).context,
  ).toEqual({ ...event.context, campaign });
  expect(AnalyticsEventSchema.safeParse(event).success).toBe(true);
});
it.each([
  { unknown: 'private' },
  { utm_source: 'é'.repeat(513) },
  { utm_campaign: '\ud800' },
  { utm_medium: '' },
  { utm_content: 'private\nvalue' },
  { utm_term: 123 },
])('rejects invalid campaign data %j', (campaign) => {
  expect(
    AnalyticsEventSchema.safeParse({ ...event, context: { ...event.context, campaign } }).success,
  ).toBe(false);
});
