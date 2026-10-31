import type { BrokerMessage, createEventProcessor } from './process-message.ts';

type ProcessMessage = ReturnType<typeof createEventProcessor>;
type Outcome = Awaited<ReturnType<ProcessMessage>>['status'];
interface RetryOptions {
  processMessage: ProcessMessage;
  signal: AbortSignal;
  onProcessed?(outcome: Outcome): void;
  onRetry?(): void;
}
function observe(callback: () => unknown) {
  try {
    void Promise.resolve(callback()).catch(() => {});
  } catch {
    /* Diagnostics cannot change offset handling. */
  }
}
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve(!signal.aborted);
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
export function createRetryingHandler(options: RetryOptions) {
  options = { ...options };
  return async (message: BrokerMessage, heartbeat: () => Promise<void>) => {
    let retryMs = 1000;
    while (!options.signal.aborted) {
      let result: Awaited<ReturnType<ProcessMessage>>;
      try {
        result = await options.processMessage(message);
      } catch {
        if (options.signal.aborted) return;
        observe(() => options.onRetry?.());
        let remaining = retryMs;
        while (remaining > 0) {
          await heartbeat();
          const interval = Math.min(1000, remaining);
          if (!(await sleep(interval, options.signal))) return;
          remaining -= interval;
        }
        retryMs = Math.min(30000, retryMs * 2);
        continue;
      }
      observe(() => options.onProcessed?.(result.status));
      return;
    }
  };
}
