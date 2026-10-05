import { z } from 'zod';

export const AnalyticsEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1).regex(/\S/),
  eventName: z.string(),
  properties: z.record(z.string(), z.unknown()),
  projectKey: z.string(),
  distinctId: z.string(),
  sessionId: z.string(),
  clientTimestamp: z.iso.datetime(),
  sequence: z.number().nonnegative().int(),
  url: z.url(),
  context: z.object({
    sdkVersion: z.string(),
  }),
});
