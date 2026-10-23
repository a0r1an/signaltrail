import { z } from 'zod';
const count = z.number().int().min(0).max(1_000_000_000);
const duration = z.number().finite().min(0).max(86_400_000);
export const SDK_HEALTH_COUNTERS = [
  'queued',
  'alreadyQueued',
  'droppedCapacity',
  'droppedExpired',
  'droppedOversize',
  'storageErrors',
  'uploadAttempts',
  'uploadBytes',
  'accepted',
  'rejected',
  'retryEvents',
  'networkErrors',
  'timeouts',
  'invalidResponses',
  'rateLimits',
  'serverErrors',
  'beaconAttempts',
  'beaconSubmitted',
] as const;
export const SdkHealthReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sdkVersion: z.literal('0.1.0'),
  intervalMs: duration,
  counters: z.partialRecord(z.enum(SDK_HEALTH_COUNTERS), count),
  timings: z.strictObject({ enqueueMs: duration, uploadMs: duration }),
  queue: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('read'),
      storageMode: z.enum(['indexeddb', 'memory']),
      count,
      bytes: count,
      oldestAgeMs: duration,
    }),
    z.strictObject({
      status: z.literal('storage_error'),
      storageMode: z.enum(['indexeddb', 'memory']),
    }),
  ]),
});
export type SdkHealthReport = z.infer<typeof SdkHealthReportSchema>;
export type SdkHealthCounter = (typeof SDK_HEALTH_COUNTERS)[number];
