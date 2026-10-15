import { describe, expect, it } from 'vitest';
import {
  AnalyticsBatchResponseSchema,
  isAnalyticsBatchResponseForEvents,
} from './analytics-batch-response.ts';

describe('AnalyticsBatchResponseSchema', () => {
  it('accepts a response containing one accepted event', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        {
          index: 0,
          eventId: 'event-1',
          status: 'accepted',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts a response containing one rejected event', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        {
          index: 0,
          status: 'rejected',
          code: 'INVALID_EVENT',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts a response containing one retryable event', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        {
          index: 0,
          eventId: 'event-1',
          status: 'retry',
          code: 'PUBLICATION_UNCONFIRMED',
          retryAfterMs: 1000,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts a retryable even without a suggested delay', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        {
          index: 0,
          eventId: 'event-1',
          status: 'retry',
          code: 'PUBLICATION_UNCONFIRMED',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects a negative retry delay', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        {
          index: 0,
          eventId: 'event-1',
          status: 'retry',
          code: 'PUBLICATION_UNCONFIRMED',
          retryAfterMs: -1,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('accepts mixed event outcomes in one response', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        { index: 0, eventId: 'event-1', status: 'accepted' },
        { index: 1, status: 'rejected', code: 'INVALID_EVENT' },
        {
          index: 2,
          eventId: 'event-3',
          status: 'retry',
          code: 'PUBLICATION_UNCONFIRMED',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects a response with no event results', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate event result indexes', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        { index: 0, eventId: 'event-1', status: 'accepted' },
        {
          index: 0,
          eventId: 'event-1',
          status: 'retry',
          code: 'PUBLICATION_UNCONFIRMED',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown event status', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        {
          index: 0,
          eventId: 'event-1',
          status: 'approved',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects an accepted result missing eventId', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        {
          index: 0,
          status: 'accepted',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a retry result missing eventId', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        {
          index: 0,
          status: 'retry',
          code: 'PUBLICATION_UNCONFIRMED',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a negative event result index', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        {
          index: -1,
          eventId: 'event-1',
          status: 'accepted',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a fractional event result index', () => {
    const result = AnalyticsBatchResponseSchema.safeParse({
      results: [
        {
          index: 0.5,
          eventId: 'event-1',
          status: 'accepted',
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe('isAnalyticsBatchResponseForEvents', () => {
  it('rejects an accepted result with a mismatched eventId', () => {
    const events = [{ eventId: 'event-A' }];

    const response = AnalyticsBatchResponseSchema.parse({
      results: [
        {
          index: 0,
          eventId: 'event-1',
          status: 'accepted',
        },
      ],
    });

    expect(isAnalyticsBatchResponseForEvents(response, events)).toBe(false);
  });

  it('accepts an accepted result with a matching eventId', () => {
    const events = [{ eventId: 'event-A' }];

    const response = AnalyticsBatchResponseSchema.parse({
      results: [
        {
          index: 0,
          eventId: 'event-A',
          status: 'accepted',
        },
      ],
    });

    expect(isAnalyticsBatchResponseForEvents(response, events)).toBe(true);
  });

  it('rejects a response missing a submitted event result', () => {
    const events = [{ eventId: 'event-A' }, { eventId: 'event-B' }];

    const response = AnalyticsBatchResponseSchema.parse({
      results: [
        {
          index: 0,
          eventId: 'event-A',
          status: 'accepted',
        },
      ],
    });

    expect(isAnalyticsBatchResponseForEvents(response, events)).toBe(false);
  });

  it('rejects a result referencing an index outside the submitted batch', () => {
    const events = [{ eventId: 'event-A' }];

    const response = AnalyticsBatchResponseSchema.parse({
      results: [
        {
          index: 1,
          status: 'rejected',
          code: 'INVALID_EVENT',
        },
      ],
    });

    expect(isAnalyticsBatchResponseForEvents(response, events)).toBe(false);
  });

  it('rejects a retry result with mismatched eventId', () => {
    const events = [{ eventId: 'event-A' }];

    const response = AnalyticsBatchResponseSchema.parse({
      results: [
        {
          index: 0,
          eventId: 'event-b',
          status: 'retry',
          code: 'PUBLICATION_UNCONFIRMED',
        },
      ],
    });

    expect(isAnalyticsBatchResponseForEvents(response, events)).toBe(false);
  });

  it('accepts a rejection for a submitted event without an eventId', () => {
    const events = [{}];

    const response = AnalyticsBatchResponseSchema.parse({
      results: [
        {
          index: 0,
          status: 'rejected',
          code: 'INVALID_EVENT',
        },
      ],
    });

    expect(isAnalyticsBatchResponseForEvents(response, events)).toBe(true);
  });
});
