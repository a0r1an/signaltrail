import { z } from 'zod';
import { AnalyticsEventSchema } from './analytics-event.ts';

// The broker boundary carries server metadata outside the client-controlled event.
export const PublishedAnalyticsEventSchema = z.object({
  projectId: z.string().min(1).regex(/\S/),
  receivedAt: z.iso.datetime(),
  event: AnalyticsEventSchema,
});
export type PublishedAnalyticsEvent = z.infer<typeof PublishedAnalyticsEventSchema>;
