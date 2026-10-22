import {
  openEventQueue,
  type EventQueue,
  type EventQueueConfig,
  type EventQueueOptions,
} from './event-queue.ts';
import { normalizeQueueConfig } from './project-config.ts';

export type TransportPauseReason = 'authentication' | 'payload_too_large' | 'unexpected_status';
export type FlushResult =
  | { status: 'applied' | 'empty' | 'busy' | 'closed' | 'storage_error' | 'not_owned' }
  | { status: 'waiting'; retryAt: number }
  | { status: 'paused'; reason: TransportPauseReason; httpStatus: number }
  | {
      status: 'retry_scheduled';
      reason: 'network' | 'timeout' | 'server' | 'rate_limit' | 'invalid_response';
      httpStatus?: number;
    };

export interface BatchTransportOptions {
  queue?: EventQueueOptions;
  fetch?: typeof globalThis.fetch;
}

export interface BatchTransport {
  readonly queue: EventQueue;
  readonly deliveryState: 'ready' | 'paused' | 'closed';
  readonly nextRequestAt: number;
  flush(eventId?: string): Promise<FlushResult>;
  close(): void;
}

function retryAfterMs(header: string | null, time: number): number {
  const value = header?.trim();
  if (!value) return 1000;
  if (/^\d+$/.test(value)) return Math.min(Number.MAX_SAFE_INTEGER, Number(value) * 1000);
  // Numeric fractions/negative numbers are not HTTP dates or valid delta-seconds.
  const date = /[a-z]/i.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - time) : 1000;
}

export async function openBatchTransport(
  config: EventQueueConfig,
  options: BatchTransportOptions = {},
): Promise<BatchTransport> {
  const normalized = normalizeQueueConfig(config);
  const send = options.fetch ?? globalThis.fetch;
  const now = options.queue?.now ?? Date.now;
  const queue = await openEventQueue(normalized, options.queue);
  let paused: Extract<FlushResult, { status: 'paused' }> | undefined;
  let closed = false;
  let activeController: AbortController | undefined;
  let notBefore = 0;
  let flushing = false;

  async function request(
    events: Parameters<EventQueue['enqueue']>[0][],
  ): Promise<
    | { status: 'received'; response: Response; payload: unknown }
    | { status: 'failed'; reason: 'network' | 'timeout' | 'invalid_response' }
  > {
    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    let received = false;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    try {
      const network = (async () => {
        const response = await send(normalized.ingestionUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${normalized.projectKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ events }),
          signal: controller.signal,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
        });
        received = true;
        const payload: unknown = response.ok ? await response.json() : undefined;
        return { status: 'received' as const, response, payload };
      })();
      return await Promise.race([network, aborted]);
    } catch {
      return {
        status: 'failed',
        reason: timedOut ? 'timeout' : received ? 'invalid_response' : 'network',
      };
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (activeController === controller) activeController = undefined;
    }
  }

  async function scheduleRetry(
    claimId: string,
    reason: Extract<FlushResult, { status: 'retry_scheduled' }>['reason'],
    httpStatus?: number,
    minimumDelayMs = 0,
  ): Promise<FlushResult> {
    const result = await queue.retryClaim(claimId, minimumDelayMs);
    if (result.status !== 'applied')
      return { status: result.status === 'not_owned' ? 'not_owned' : 'storage_error' };
    return {
      status: 'retry_scheduled',
      reason,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    };
  }
  return {
    queue,
    get nextRequestAt() {
      return notBefore;
    },
    get deliveryState() {
      return closed ? 'closed' : paused ? 'paused' : 'ready';
    },
    async flush(eventId) {
      if (closed) return { status: 'closed' };
      if (flushing) return { status: 'busy' };
      if (paused) return paused;
      if (now() < notBefore) return { status: 'waiting', retryAt: notBefore };
      flushing = true;
      try {
        const batch = await queue.claimBatch(eventId === undefined ? 100 : 1, eventId);
        if (batch.status !== 'claimed') return batch;
        if (closed) return { status: 'closed' };
        const result = await request(batch.events);
        if (closed) return { status: 'closed' };
        if (result.status === 'failed') return await scheduleRetry(batch.claimId, result.reason);
        const response = result.response;
        if (response.status === 429) {
          const delay = retryAfterMs(response.headers.get('Retry-After'), now());
          notBefore = now() + delay;
          return await scheduleRetry(batch.claimId, 'rate_limit', 429, delay);
        }
        if (response.status >= 500 && response.status <= 599)
          return await scheduleRetry(batch.claimId, 'server', response.status);
        if (!response.ok) {
          paused = {
            status: 'paused',
            httpStatus: response.status,
            reason:
              response.status === 401 || response.status === 403
                ? 'authentication'
                : response.status === 413
                  ? 'payload_too_large'
                  : 'unexpected_status',
          };
          const released = await queue.releaseClaim(batch.claimId);
          return released.status === 'storage_error' ? { status: 'storage_error' } : paused;
        }
        const applied = await queue.applyResponse(batch.claimId, result.payload);
        if (applied.status === 'invalid_response')
          return await scheduleRetry(batch.claimId, 'invalid_response');
        return applied;
      } catch {
        return { status: closed ? 'closed' : 'storage_error' };
      } finally {
        flushing = false;
      }
    },
    close() {
      closed = true;
      activeController?.abort();
      queue.close();
    },
  };
}
