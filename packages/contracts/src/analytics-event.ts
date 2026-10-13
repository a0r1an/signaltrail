import { z } from 'zod';

export const AnalyticsEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1).regex(/\S/),
  eventName: z.string().min(1).regex(/\S/),
  properties: z.record(z.string(), z.json()),
  distinctId: z.string().min(1).regex(/\S/),
  sessionId: z.string().min(1).regex(/\S/),
  clientTimestamp: z.iso.datetime(),
  sequence: z.number().nonnegative().int(),
  url: z.url(),
  context: z.object({
    sdkVersion: z.string().min(1).regex(/\S/),
  }),
});
