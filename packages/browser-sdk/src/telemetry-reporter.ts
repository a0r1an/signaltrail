import type { EventQueueConfig } from './event-queue.ts';
import type { createSdkHealth, SdkTelemetryOptions } from './sdk-health.ts';
export function validateTelemetryOptions(options: SdkTelemetryOptions) {
  const interval = options.intervalMs ?? 60000;
  const rate = options.sampleRate ?? 0.1;
  if (!Number.isSafeInteger(interval) || interval < 60000 || interval > 86400000)
    throw new RangeError('Telemetry intervalMs must be between one minute and one day');
  if (!Number.isFinite(rate) || rate < 0 || rate > 1)
    throw new RangeError('Telemetry sampleRate must be from 0 to 1');
}
export function startSdkTelemetry(
  config: EventQueueConfig,
  options: SdkTelemetryOptions,
  health: ReturnType<typeof createSdkHealth>,
  send: typeof fetch,
) {
  options = { ...options };
  validateTelemetryOptions(options);
  if (!options.enabled && !options.onReport) return () => {};
  const endpoint = new URL(config.ingestionUrl);
  endpoint.pathname = '/v1/sdk-health';
  endpoint.search = '';
  endpoint.hash = '';
  // Select once per instance. No browser identifiers or persistent sampling ID.
  const sampled = options.enabled === true && Math.random() < (options.sampleRate ?? 0.1);
  if (!sampled && !options.onReport) return () => {};
  let closed = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(() => {
      void report();
    }, options.intervalMs ?? 60000);
  };
  async function report() {
    if (closed) return;
    try {
      const report = await health.take();
      if (closed) return;
      try {
        void Promise.resolve(options.onReport?.(structuredClone(report))).catch(() => {});
      } catch {
        /* Consumer diagnostics cannot interrupt reporting. */
      }
      if (!sampled) return;
      const body = JSON.stringify(report);
      if (new TextEncoder().encode(body).byteLength > 16 * 1024) return;
      const active = new AbortController();
      controller = active;
      let rejectDeadline!: (error: unknown) => void;
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
      });
      const timeout = setTimeout(() => {
        active.abort();
        rejectDeadline(new Error('Telemetry deadline exceeded'));
      }, 3000);
      try {
        await Promise.race([
          (async () => {
            const response = await send(endpoint.href, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${config.projectKey}`,
                'Content-Type': 'application/json',
              },
              body,
              signal: active.signal,
              credentials: 'omit',
              redirect: 'error',
              cache: 'no-store',
            });
            await response.body?.cancel();
          })(),
          deadline,
        ]);
      } finally {
        clearTimeout(timeout);
        if (controller === active) controller = undefined;
      }
    } catch {
      /* Best effort: no persistence, retry queue, or recursive reporting. */
    } finally {
      if (!closed) arm();
    }
  }
  arm();
  return () => {
    closed = true;
    clearTimeout(timer);
    controller?.abort();
  };
}
