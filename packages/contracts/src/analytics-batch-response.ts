import { z } from 'zod';

const sameSize = (results: readonly { index: number }[]): boolean => {
  const a = results.map((result) => result.index);
  return new Set(a).size === results.length;
};

export function isAnalyticsBatchResponseForEvents(
  response: z.infer<typeof AnalyticsBatchResponseSchema>,
  events: readonly unknown[],
): boolean {
  if (response.results.length !== events.length) {
    return false;
  }

  return response.results.every((result) => {
    if (result.index >= events.length) {
      return false;
    }

    if (result.status === 'rejected') {
      return true;
    }

    const event = events[result.index];

    return (
      typeof event === 'object' &&
      event !== null &&
      'eventId' in event &&
      event.eventId === result.eventId
    );
  });
}

const AnalyticsEventResultSchema = z.object({
  index: z.number().int().nonnegative(),
  eventId: z.string().min(1).regex(/\S/),
  status: z.literal('accepted'),
});

const RejectedEventResultSchema = z.object({
  index: z.number().int().nonnegative(),
  status: z.literal('rejected'),
  code: z.literal('INVALID_EVENT'),
});

const RetryEventResultSchema = z.object({
  index: z.number().int().nonnegative(),
  status: z.literal('retry'),
  eventId: z.string().min(1).regex(/\S/),
  code: z.literal('PUBLICATION_UNCONFIRMED'),
  retryAfterMs: z.number().int().nonnegative().optional(),
});

export const AnalyticsBatchResponseSchema = z.object({
  results: z
    .array(
      z.discriminatedUnion('status', [
        AnalyticsEventResultSchema,
        RejectedEventResultSchema,
        RetryEventResultSchema,
      ]),
    )
    .min(1)
    .refine((results) => sameSize(results), {
      error: 'Event result indexes must be unique',
    }),
});
