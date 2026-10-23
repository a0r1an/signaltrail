import { expect, it } from 'vitest';
import { SdkHealthReportSchema } from '../../src/sdk-health.ts';
it('accepts bounded aggregate diagnostics and rejects event content', () => {
  const report = {
    schemaVersion: 1,
    sdkVersion: '0.1.0',
    intervalMs: 60000,
    counters: { queued: 2 },
    timings: { enqueueMs: 3, uploadMs: 4 },
    queue: { status: 'read', storageMode: 'indexeddb', count: 2, bytes: 700, oldestAgeMs: 1000 },
  };
  expect(SdkHealthReportSchema.safeParse(report).success).toBe(true);
  expect(
    SdkHealthReportSchema.safeParse({ ...report, events: [{ secret: 'content' }] }).success,
  ).toBe(false);
});

it('rejects unbounded counts, negative timings, and unknown counter labels', () => {
  const report = {
    schemaVersion: 1,
    sdkVersion: '0.1.0',
    intervalMs: 60000,
    counters: {},
    timings: { enqueueMs: 0, uploadMs: 0 },
    queue: { status: 'storage_error', storageMode: 'memory' },
  };
  expect(
    SdkHealthReportSchema.safeParse({ ...report, counters: { queued: Infinity } }).success,
  ).toBe(false);
  expect(SdkHealthReportSchema.safeParse({ ...report, counters: { userId: 123 } }).success).toBe(
    false,
  );
  expect(
    SdkHealthReportSchema.safeParse({ ...report, timings: { enqueueMs: -1, uploadMs: 0 } }).success,
  ).toBe(false);
});
