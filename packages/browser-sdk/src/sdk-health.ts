import type { SdkHealthCounter, SdkHealthReport } from '@signaltrail/contracts';
import type { EventQueue } from './event-queue.ts';

const MAX_COUNT = 1_000_000_000;
const MAX_MS = 86_400_000;
export interface SdkTelemetryOptions {
  /** Reporting is disabled unless explicitly enabled. Reports contain aggregate diagnostics only. */
  enabled?: boolean;
  sampleRate?: number;
  intervalMs?: number;
  onReport?: (report: SdkHealthReport) => void;
}
export function createSdkHealth(
  queue: Pick<EventQueue, 'getAll' | 'storageMode'>,
  now: () => number,
) {
  let started = now();
  let counters: Partial<Record<SdkHealthCounter, number>> = {};
  let timings = { enqueueMs: 0, uploadMs: 0 };
  async function snapshot(): Promise<SdkHealthReport> {
    const time = now();
    // Snapshot local counters before reading the shared queue. New work belongs to the next report.
    const capturedCounters = { ...counters };
    const capturedTimings = { ...timings };
    const intervalMs = Math.min(MAX_MS, Math.max(0, time - started));
    const stored = await queue.getAll().catch(() => ({ status: 'storage_error' as const }));
    const summary: SdkHealthReport['queue'] =
      stored.status === 'read'
        ? {
            status: 'read',
            storageMode: queue.storageMode,
            count: stored.events.length,
            bytes: Math.min(
              MAX_COUNT,
              stored.events.reduce(
                (sum, event) => sum + new TextEncoder().encode(JSON.stringify(event)).byteLength,
                0,
              ),
            ),
            oldestAgeMs: Math.min(
              MAX_MS,
              stored.events.reduce(
                (oldest, event) => Math.max(oldest, time - Date.parse(event.clientTimestamp)),
                0,
              ),
            ),
          }
        : { status: 'storage_error', storageMode: queue.storageMode };
    return {
      schemaVersion: 1,
      sdkVersion: '0.1.0',
      intervalMs,
      counters: capturedCounters,
      timings: capturedTimings,
      queue: summary,
    };
  }
  return {
    increment(name: SdkHealthCounter, amount = 1) {
      counters[name] = Math.min(MAX_COUNT, (counters[name] ?? 0) + Math.max(0, amount));
    },
    duration(name: keyof typeof timings, ms: number) {
      timings[name] = Math.min(MAX_MS, timings[name] + Math.max(0, ms));
    },
    snapshot,
    async take(): Promise<SdkHealthReport> {
      const reporting = snapshot();
      started = now();
      counters = {};
      timings = { enqueueMs: 0, uploadMs: 0 };
      return reporting;
    },
  };
}
