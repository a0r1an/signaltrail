export interface PublicationSnapshot {
  outstandingEvents: number;
  outstandingBytes: number;
  peakEvents: number;
  peakBytes: number;
  refused: number;
  completed: number;
  failed: number;
  cancelled: number;
  lateCompletions: number;
  durationSeconds: number;
}
export function createPublicationCapacity(options: {
  maxEvents: number;
  maxBytes: number;
  onSettled?: (seconds: number, failed: boolean) => void;
}) {
  options = { ...options };
  for (const [name, value] of Object.entries({
    maxEvents: options.maxEvents,
    maxBytes: options.maxBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${name} must be a positive safe integer`);
  }
  const state: PublicationSnapshot = {
    outstandingEvents: 0,
    outstandingBytes: 0,
    peakEvents: 0,
    peakBytes: 0,
    refused: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    lateCompletions: 0,
    durationSeconds: 0,
  };
  return {
    snapshot: () => ({ ...state }),
    async run(value: string, signal: AbortSignal, send: () => Promise<unknown>) {
      signal.throwIfAborted();
      const bytes = Buffer.byteLength(value, 'utf8');
      if (
        state.outstandingEvents >= options.maxEvents ||
        bytes > options.maxBytes - state.outstandingBytes
      ) {
        state.refused++;
        throw new Error('Publication capacity exhausted');
      }
      state.outstandingEvents++;
      state.outstandingBytes += bytes;
      state.peakEvents = Math.max(state.peakEvents, state.outstandingEvents);
      state.peakBytes = Math.max(state.peakBytes, state.outstandingBytes);
      const started = performance.now();
      let settled = false;
      const release = (failed: boolean) => {
        settled = true;
        state.outstandingEvents--;
        state.outstandingBytes -= bytes;
        const seconds = (performance.now() - started) / 1000;
        state.durationSeconds += seconds;
        try {
          void Promise.resolve(options.onSettled?.(seconds, failed)).catch(() => {});
        } catch {
          /* Diagnostics must not change delivery. */
        }
        if (failed) state.failed++;
        else state.completed++;
        if (signal.aborted) state.lateCompletions++;
      };
      // Reserve synchronously before starting work, including across concurrent callers.
      let underlying: Promise<unknown>;
      try {
        underlying = Promise.resolve(send());
      } catch (error) {
        underlying = Promise.reject(error);
      }
      const sending = underlying.then(
        (result) => {
          release(false);
          return result;
        },
        (error: unknown) => {
          release(true);
          throw error;
        },
      );
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          if (!settled) state.cancelled++;
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      try {
        await Promise.race([sending, aborted]);
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
