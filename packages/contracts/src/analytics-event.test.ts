import { describe, it, expect } from 'vitest';
import { AnalyticsEventSchema } from './analytics-event.ts';
import { AnalyticsBatchSchema, validateAnalyticsEvents } from './analytics-batch.ts';

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

  it('accepts an event without a projectKey', () => {
    const { projectKey, ...event } = validEvent;

    const result = AnalyticsEventSchema.safeParse(event);

    expect(result.success).toBe(true);
  });

  it('strips a supplied projectKey from the parsed event', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      projectKey: 'another-project',
    });

    expect(result.success).toBe(true);

    if (!result.success) {
      throw new Error('Expected a valid event');
    }

    expect(result.data).not.toHaveProperty('projectKey');
  });

  it('rejects an undefined property', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      properties: { productId: undefined },
    });

    expect(result.success).toBe(false);
  });

  it('accepts a null property value', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      properties: { productId: null },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an undefined value inside a nested property', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      properties: {
        product: { id: undefined },
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts nested JSON property values', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      properties: {
        product: {
          id: '123',
          price: 19.99,
          available: true,
          discount: null,
          tags: ['sale', 'featured'],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an infinite property value', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      properties: {
        price: Infinity,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects an undefined value inside a property array', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      properties: {
        tags: ['sale', undefined],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a bigint property value', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      properties: {
        count: 1n,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty eventName', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      eventName: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an eventName containing only white spaces', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      eventName: ' \t\n',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty distinctId', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      distinctId: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a distinctId containing only white spaces', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      distinctId: ' \t\n',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty sessionId', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      sessionId: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a sessionId containing only white spaces', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      sessionId: ' \t\n',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty sdkVersion', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      context: {
        ...validEvent.context,
        sdkVersion: '',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a sdkVersion containing only white spaces', () => {
    const result = AnalyticsEventSchema.safeParse({
      ...validEvent,
      context: {
        ...validEvent.context,
        sdkVersion: ' \t\n',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('AnalyticsBatchSchema', () => {
  it('accepts a batch containing one valid event', () => {
    const result = AnalyticsBatchSchema.safeParse({
      events: [validEvent],
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty batch', () => {
    const result = AnalyticsBatchSchema.safeParse({
      events: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a batch containing more than 100 events', () => {
    const events = Array.from({ length: 101 }, (_, index) => ({
      ...validEvent,
      eventId: `event-${index}`,
      sequence: index,
    }));
    const result = AnalyticsBatchSchema.safeParse({ events });
    expect(result.success).toBe(false);
  });

  it('accepts a batch containing exactly 100 events', () => {
    const events = Array.from({ length: 100 }, (_, index) => ({
      ...validEvent,
      eventId: `event-${index}`,
      sequence: index,
    }));

    const result = AnalyticsBatchSchema.safeParse({ events });

    expect(result.success).toBe(true);
  });

  it('allows a malformed event through batch structure validation', () => {
    const result = AnalyticsBatchSchema.safeParse({
      events: [validEvent, { ...validEvent, eventId: '' }],
    });

    expect(result.success).toBe(true);
  });

  it('rejects a batch missing the events field', () => {
    const result = AnalyticsBatchSchema.safeParse({});

    expect(result.success).toBe(false);
  });

  it('rejects a batch whose events field is not an array', () => {
    const result = AnalyticsBatchSchema.safeParse({
      events: validEvent,
    });

    expect(result.success).toBe(false);
  });
});

describe('validateAnalyticsEvents', () => {
  it('validates each event independently and preserves its index', () => {
    const results = validateAnalyticsEvents([validEvent, { ...validEvent, eventId: '' }]);

    expect(
      results.map(({ index, result }) => ({
        index,
        valid: result.success,
      })),
    ).toEqual([
      { index: 0, valid: true },
      { index: 1, valid: false },
    ]);
  });

  it('continues validating events after an invalid event', () => {
    const results = validateAnalyticsEvents([{ ...validEvent, eventId: '' }, validEvent]);

    expect(
      results.map(({ index, result }) => ({
        index,
        valid: result.success,
      })),
    ).toEqual([
      { index: 0, valid: false },
      { index: 1, valid: true },
    ]);
  });

  it('preserves a valid sibling when another event has invalid properties', () => {
    const results = validateAnalyticsEvents([
      {
        ...validEvent,
        properties: {
          count: 1n,
        },
      },
      validEvent,
    ]);

    expect(
      results.map(({ index, result }) => ({
        index,
        valid: result.success,
      })),
    ).toEqual([
      { index: 0, valid: false },
      { index: 1, valid: true },
    ]);
  });
});
