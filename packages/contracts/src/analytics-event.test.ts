import { describe, it, expect } from 'vitest';
import { AnalyticsEventSchema } from './analytics-event.ts';

const validEvent = {
  schemaVersion: 1,
  eventId: 'd23f947a-15e8-4fa1-9cb8-338e50cb2a16',
  projectKey: 'adrianproject-1234',
  distinctId: 'visitor-789',
  sessionId: '2e8b4071-8f65-4a92-a653-909bc390ab24',
  eventName: 'pageview',
  clientTimestamp: '2026-10-01T16:00:00.000Z',
  sequence: 1,
  url: 'https://www.example.com',
  properties: { productId: '123' },
  context: { sdkVersion: '1.0.0' },
};

describe('AnalyticsEventSchema', () => {
  it('accepts a valid browser analytics event', () => {
    const result = AnalyticsEventSchema.safeParse(validEvent);

    expect(result.success).toBe(true);
  });

  it('rejects an event missing eventId', () => {
    const { eventId, ...event } = validEvent;

    const result = AnalyticsEventSchema.safeParse(event);

    expect(result.success).toBe(false);
  });

  it('rejects an empty eventId', () => {
    const event = { ...validEvent, eventId: '' };

    const result = AnalyticsEventSchema.safeParse(event);

    expect(result.success).toBe(false);
  });

  it('rejects an eventId containing only whitespace', () => {
    const event = { ...validEvent, eventId: ' ' };

    const result = AnalyticsEventSchema.safeParse(event);

    expect(result.success).toBe(false);
  });

  it('rejects a numeric eventId', () => {
    const event = { ...validEvent, eventId: 123 };

    const result = AnalyticsEventSchema.safeParse(event);

    expect(result.success).toBe(false);
  });

  it('rejects an unsupported schema version', () => {
    const event = { ...validEvent, schemaVersion: 2 };

    const result = AnalyticsEventSchema.safeParse(event);

    expect(result.success).toBe(false);
  });

  it('rejects a negative sequence', () => {
    const event = { ...validEvent, sequence: -1 };

    const result = AnalyticsEventSchema.safeParse(event);

    expect(result.success).toBe(false);
  });

  it('rejects a fractional sequence', () => {
    const event = { ...validEvent, sequence: 1.5 };

    const result = AnalyticsEventSchema.safeParse(event);

    expect(result.success).toBe(false);
  });

  it('accepts a zero sequence', () => {
    const event = { ...validEvent, sequence: 0 };

    const result = AnalyticsEventSchema.safeParse(event);

    expect(result.success).toBe(true);
  });

  it('rejects an invalid URL', () => {
    const event = { ...validEvent, url: 'not-a-url' };

    const result = AnalyticsEventSchema.safeParse(event);

    expect(result.success).toBe(false);
  });

  it('rejects an invalid client timestamp', () => {
    const event = {
      ...validEvent,
      clientTimestamp: 'not-a-timestamp',
    };

    const result = AnalyticsEventSchema.safeParse(event);

    expect(result.success).toBe(false);
  });
});
