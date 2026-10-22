import {
  openBatchTransport,
  type BatchTransportOptions,
  type FlushResult,
} from './batch-transport.ts';
import type { EventQueueConfig, EnqueueResult, EventQueue } from './event-queue.ts';
import { normalizeQueueConfig } from './project-config.ts';

type Event = Parameters<Awaited<ReturnType<typeof openBatchTransport>>['queue']['enqueue']>[0];
export interface AutomaticDeliveryOptions extends BatchTransportOptions {
  flushIntervalMs?: number;
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  page?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  sendBeacon?: (url: string, data: Blob) => boolean;
}
export interface EnqueueOptions {
  sendImmediately?: boolean;
}

export interface AutomaticDelivery {
  enqueue(event: Event, options?: EnqueueOptions): Promise<EnqueueResult>;
  getAll: EventQueue['getAll'];
  flush(): Promise<FlushResult>;
  readonly deliveryState: 'ready' | 'paused' | 'closed';
  close(): void;
}

export async function openAutomaticDelivery(
  config: EventQueueConfig,
  options: AutomaticDeliveryOptions = {},
): Promise<AutomaticDelivery> {
  const normalized = normalizeQueueConfig(config);
  const interval = options.flushIntervalMs ?? 2000;
  if (!Number.isSafeInteger(interval) || interval < 1)
    throw new RangeError('flushIntervalMs must be a positive safe integer');
  const now = options.queue?.now ?? Date.now;
  const document = options.document ?? globalThis.document;
  const page = options.page ?? globalThis.window;
  const sendBeacon =
    options.sendBeacon ?? globalThis.navigator?.sendBeacon?.bind(globalThis.navigator);
  const maxAge = options.queue?.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const transport = await openBatchTransport(normalized, options);
  let closed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = Infinity;
  let cooldown = 0;
  const immediate = new Set<string>();
  let beaconEvents: Event[] = [];
  let hiddenSent = false;
  let refreshVersion = 0;
  let beaconBody: Blob | undefined;
  let beaconValidUntil = Infinity;
  function prepareBeacon() {
    const selected: Event[] = [];
    for (const event of beaconEvents) {
      if (selected.length === 100) break;
      if (now() - Date.parse(event.clientTimestamp) >= maxAge) continue;
      const candidate = [...selected, event];
      if (
        new Blob([JSON.stringify({ projectKey: normalized.projectKey, events: candidate })]).size <=
          60 * 1024 &&
        candidate.length <= 100
      )
        selected.push(event);
    }
    beaconValidUntil = Math.min(
      ...selected.map((event) => Date.parse(event.clientTimestamp) + maxAge),
    );
    beaconBody = selected.length
      ? new Blob([JSON.stringify({ projectKey: normalized.projectKey, events: selected })], {
          type: 'text/plain;charset=utf-8',
        })
      : undefined;
  }
  function departure() {
    if (
      closed ||
      hiddenSent ||
      transport.deliveryState !== 'ready' ||
      now() < cooldown ||
      !sendBeacon
    )
      return;
    if (now() >= beaconValidUntil) prepareBeacon();
    if (!beaconBody) return;
    try {
      hiddenSent = sendBeacon(normalized.ingestionUrl, beaconBody);
    } catch {
      /* Retain events for normal acknowledged delivery. */
    }
  }
  function visibilityChanged() {
    if (document?.visibilityState === 'hidden') departure();
    else {
      hiddenSent = false;
      void refresh().catch(() => {});
    }
  }

  function arm(at: number) {
    if (closed || transport.deliveryState !== 'ready' || at >= timerAt) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(
      () => {
        timerAt = Infinity;
        timer = undefined;
        void flush();
      },
      Math.min(2_147_483_647, Math.max(1, at - now())),
    );
  }
  async function refresh() {
    if (closed) return;
    const version = ++refreshVersion;
    const snapshot = await transport.queue.inspectDelivery();
    if (closed || version !== refreshVersion) return;
    beaconEvents = snapshot.status === 'read' ? snapshot.events : [];
    prepareBeacon();
    let due =
      snapshot.status === 'read' && snapshot.events.length >= 100 ? now() : now() + interval;
    if (snapshot.status === 'read' && snapshot.nextEligibleAt !== undefined)
      due = Math.min(due, snapshot.nextEligibleAt);
    arm(Math.max(cooldown, due));
    return snapshot;
  }
  async function flush(eventId?: string): Promise<FlushResult> {
    if (closed) return { status: 'closed' };
    if (running) {
      if (eventId !== undefined) immediate.add(eventId);
      return { status: 'busy' };
    }
    running = true;
    clearTimeout(timer);
    timer = undefined;
    timerAt = Infinity;
    try {
      refreshVersion++;
      beaconEvents = [];
      beaconBody = undefined;
      const result = await transport.flush(eventId);
      cooldown = transport.nextRequestAt;
      return result;
    } catch {
      return { status: closed ? 'closed' : 'storage_error' };
    } finally {
      running = false;
      if (!closed) {
        try {
          await refresh();
        } catch {
          arm(now() + interval);
        }
        const next = immediate.values().next().value as string | undefined;
        if (next !== undefined) {
          immediate.delete(next);
          void flush(next);
        }
      }
    }
  }
  const initial = await refresh();
  if (initial?.status === 'read' && initial.events.length) arm(now());
  document?.addEventListener('visibilitychange', visibilityChanged);
  page?.addEventListener('pagehide', departure);
  return {
    async enqueue(event: Event, capture: EnqueueOptions = {}): Promise<EnqueueResult> {
      if (closed) throw new DOMException('Delivery is closed', 'InvalidStateError');
      const id = event.eventId;
      const urgent = capture.sendImmediately;
      const result = await transport.queue.enqueue(event);
      if (closed) return result;
      const outcome = result.status === 'storage_error' ? result.fallback : result;
      if (outcome.status !== 'dropped') {
        if (urgent) await flush(id);
        else {
          const snapshot = await refresh();
          if (snapshot?.status === 'read' && snapshot.events.length >= 100) await flush();
        }
      }
      return result;
    },
    getAll: transport.queue.getAll,
    flush: () => flush(),
    get deliveryState() {
      return transport.deliveryState;
    },
    close() {
      closed = true;
      refreshVersion++;
      beaconBody = undefined;
      clearTimeout(timer);
      immediate.clear();
      beaconEvents = [];
      document?.removeEventListener('visibilitychange', visibilityChanged);
      page?.removeEventListener('pagehide', departure);
      transport.close();
    },
  };
}
