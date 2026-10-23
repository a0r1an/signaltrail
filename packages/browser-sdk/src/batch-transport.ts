import { startSdkTelemetry, validateTelemetryOptions } from './telemetry-reporter.ts';
import type { SdkTelemetryOptions } from './sdk-health.ts';
import { createSdkHealth } from './sdk-health.ts';
import { AnalyticsBatchResponseSchema, type SdkHealthReport } from '@signaltrail/contracts';
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
  | { status: 'batch_resized'; maxEvents: number }
  | {
      status: 'dropped';
      reason: 'event_too_large';
      eventId: string;
      source: 'client_limit' | 'server_413';
    }
  | { status: 'paused'; reason: TransportPauseReason; httpStatus?: number }
  | {
      status: 'retry_scheduled';
      reason: 'network' | 'timeout' | 'server' | 'rate_limit' | 'invalid_response';
      httpStatus?: number;
    };

export interface EventDrop {
  eventId: string;
  reason: 'event_too_large';
  source: 'client_limit' | 'server_413';
}
export interface BatchTransportOptions {
  telemetry?: SdkTelemetryOptions;
  onEventDropped?: (drop: EventDrop) => void;
  maxRequestBytes?: number;
  queue?: EventQueueOptions;
  fetch?: typeof globalThis.fetch;
}

export interface BatchTransport {
  getHealth(): Promise<SdkHealthReport>;
  recordBeacon(submitted: boolean): void;
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
  if (options.telemetry) validateTelemetryOptions(options.telemetry);
  const maxRequestBytes = options.maxRequestBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1)
    throw new RangeError('maxRequestBytes must be a positive safe integer');
  const onEventDropped = options.onEventDropped;
  function notifyDrop(eventId: string, source: EventDrop['source']): EventDrop {
    const drop: EventDrop = { eventId, reason: 'event_too_large', source };
    try {
      void Promise.resolve(onEventDropped?.({ ...drop })).catch(() => {});
    } catch {
      /* Diagnostics cannot interrupt delivery. */
    }
    return drop;
  }
  const send = options.fetch ?? globalThis.fetch;
  const now = options.queue?.now ?? Date.now;
  const storedQueue = await openEventQueue(normalized, options.queue);
  const health = createSdkHealth(storedQueue, now);
  const queue: EventQueue = {
    ...storedQueue,
    get storageMode() {
      return storedQueue.storageMode;
    },
    async enqueue(event) {
      if (closed) throw new DOMException('The queue connection is closed', 'InvalidStateError');
      const started = performance.now();
      try {
        if (
          new TextEncoder().encode(JSON.stringify({ events: [event] })).byteLength > maxRequestBytes
        ) {
          health.increment('droppedOversize');
          notifyDrop(event.eventId, 'client_limit');
          return { status: 'dropped', reason: 'event_too_large' };
        }
        const result = await storedQueue.enqueue(event);
        if (result.status === 'storage_error') health.increment('storageErrors');
        const outcome = result.status === 'storage_error' ? result.fallback : result;
        if (outcome.status === 'queued') health.increment('queued');
        else if (outcome.status === 'already_queued') health.increment('alreadyQueued');
        else
          health.increment(
            outcome.reason === 'capacity'
              ? 'droppedCapacity'
              : outcome.reason === 'expired'
                ? 'droppedExpired'
                : 'droppedOversize',
          );
        return result;
      } finally {
        health.duration('enqueueMs', performance.now() - started);
      }
    },
  };
  let paused: Extract<FlushResult, { status: 'paused' }> | undefined;
  let closed = false;
  let activeController: AbortController | undefined;
  let notBefore = 0;
  let flushing = false;
  let batchLimit = 100;
  const closeTelemetry = startSdkTelemetry(normalized, options.telemetry ?? {}, health, send);

  async function request(
    events: Parameters<EventQueue['enqueue']>[0][],
  ): Promise<
    | { status: 'received'; response: Response; payload: unknown }
    | { status: 'failed'; reason: 'network' | 'timeout' | 'invalid_response' }
  > {
    const body = JSON.stringify({ events });
    health.increment('uploadAttempts');
    health.increment('uploadBytes', new TextEncoder().encode(body).byteLength);
    const started = performance.now();
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
          body,
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
      health.duration('uploadMs', performance.now() - started);
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
    health.increment(
      reason === 'network'
        ? 'networkErrors'
        : reason === 'timeout'
          ? 'timeouts'
          : reason === 'server'
            ? 'serverErrors'
            : reason === 'rate_limit'
              ? 'rateLimits'
              : 'invalidResponses',
    );
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
    getHealth: health.snapshot,
    recordBeacon(submitted) {
      health.increment('beaconAttempts');
      if (submitted) health.increment('beaconSubmitted');
    },
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
        const batch = await queue.claimBatch(
          eventId === undefined ? batchLimit : 1,
          eventId,
          maxRequestBytes,
        );
        if (batch.status !== 'claimed') return batch;
        if (closed) return { status: 'closed' };
        if (
          new TextEncoder().encode(JSON.stringify({ events: batch.events })).byteLength >
          maxRequestBytes
        ) {
          const discarded = await queue.discardClaim(batch.claimId);
          if (discarded.status !== 'applied')
            return { status: discarded.status === 'not_owned' ? 'not_owned' : 'storage_error' };
          health.increment('droppedOversize');
          return { status: 'dropped', ...notifyDrop(batch.events[0]!.eventId, 'client_limit') };
        }
        const result = await request(batch.events);
        if (closed) return { status: 'closed' };
        if (result.status === 'failed') return await scheduleRetry(batch.claimId, result.reason);
        const response = result.response;
        if (response.status === 413 && batch.events.length > 1) {
          const released = await queue.releaseClaim(batch.claimId);
          if (released.status !== 'released') return { status: released.status };
          batchLimit = Math.max(1, Math.floor(batch.events.length / 2));
          return { status: 'batch_resized', maxEvents: batchLimit };
        }
        if (response.status === 413) {
          const discarded = await queue.discardClaim(batch.claimId);
          if (discarded.status !== 'applied')
            return { status: discarded.status === 'not_owned' ? 'not_owned' : 'storage_error' };
          health.increment('droppedOversize');
          return { status: 'dropped', ...notifyDrop(batch.events[0]!.eventId, 'server_413') };
        }
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
        if (applied.status === 'applied') {
          for (const outcome of AnalyticsBatchResponseSchema.parse(result.payload).results)
            health.increment(outcome.status === 'retry' ? 'retryEvents' : outcome.status);
        } else if (applied.status === 'storage_error') health.increment('storageErrors');
        return applied;
      } catch {
        return { status: closed ? 'closed' : 'storage_error' };
      } finally {
        flushing = false;
      }
    },
    close() {
      closed = true;
      closeTelemetry();
      activeController?.abort();
      queue.close();
    },
  };
}
