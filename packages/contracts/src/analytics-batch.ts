import { z } from 'zod';
import { AnalyticsEventSchema } from './analytics-event.ts';

type EventValidationResult = {
  index: number;
  result: ReturnType<typeof AnalyticsEventSchema.safeParse>;
};

export const AnalyticsBatchSchema = z.object({
  events: z.array(z.unknown()).min(1).max(100),
});

export function validateAnalyticsEvents(events: unknown[]): EventValidationResult[] {
  return events.map((event, index) => ({
    index,
    result: AnalyticsEventSchema.safeParse(event),
  }));
}
