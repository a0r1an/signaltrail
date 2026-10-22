import { normalizeQueueConfig, type EventQueueConfig } from './project-config.ts';
export type { EventQueueConfig } from './project-config.ts';
import {
  AnalyticsBatchResponseSchema,
  isAnalyticsBatchResponseForEvents,
  type AnalyticsEventSchema,
} from '@signaltrail/contracts';
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';

type AnalyticsEvent = ReturnType<typeof AnalyticsEventSchema.parse>;
type BatchResponse = ReturnType<typeof AnalyticsBatchResponseSchema.parse>;

const encoder = new TextEncoder();
const CLAIM_LEASE_MS = 60_000;
const MAX_CLAIM_EVENTS = 100;

interface RetryState {
  retryCount: number;
  nextEligibleAt: number;
}

function nextRetryState(
  previous: RetryState | undefined,
  time: number,
  serverDelayMs: number | undefined,
  random: () => number,
): RetryState {
  const retryCount = (previous?.retryCount ?? 0) + 1;
  const windowMs = Math.min(300_000, 1000 * 2 ** Math.min(retryCount - 1, 9));
  const delayMs = Math.max(Math.floor(random() * windowMs), serverDelayMs ?? 0);
  return { retryCount, nextEligibleAt: time + delayMs };
}

function payloadBytes(event: AnalyticsEvent): number {
  return encoder.encode(JSON.stringify(event)).byteLength;
}

function isExpired(event: AnalyticsEvent, time: number, maxAgeMs: number): boolean {
  return time - Date.parse(event.clientTimestamp) >= maxAgeMs;
}

interface QueueDatabase extends DBSchema {
  events: {
    key: number;
    value: AnalyticsEvent;
    indexes: {
      byEventId: string;
    };
  };
  claims: {
    key: number;
    value: { eventKey: number; claimId: string; ownerId: string; expiresAt: number };
    indexes: { byClaimId: string };
  };
  retries: {
    key: number;
    value: RetryState & { eventKey: number };
  };
}

type QueueTransaction = IDBPTransaction<
  QueueDatabase,
  ['events', 'claims', 'retries'],
  'readwrite'
>;

function uniqueId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function readUnexpired(
  transaction: QueueTransaction,
  time: number,
  maxAgeMs: number,
): Promise<AnalyticsEvent[]> {
  const events: AnalyticsEvent[] = [];
  let cursor = await transaction.objectStore('events').openCursor();
  while (cursor) {
    if (isExpired(cursor.value, time, maxAgeMs)) {
      await cursor.delete();
      await transaction.objectStore('claims').delete(cursor.primaryKey);
      await transaction.objectStore('retries').delete(cursor.primaryKey);
    } else {
      events.push(cursor.value);
    }
    cursor = await cursor.continue();
  }
  return events;
}

async function inTransaction<T>(
  database: IDBPDatabase<QueueDatabase>,
  operation: (transaction: QueueTransaction) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction(['events', 'claims', 'retries'], 'readwrite');
  // Observe completion immediately: a request failure can also reject transaction.done.
  const completion = transaction.done.then(
    () => ({ committed: true as const }),
    (error: unknown) => ({ committed: false as const, error }),
  );
  try {
    const result = await operation(transaction);
    const outcome = await completion;
    if (!outcome.committed) throw outcome.error;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have committed or aborted.
    }
    await completion;
    throw error;
  }
}

type EnqueueOutcome =
  | { status: 'queued' }
  | { status: 'already_queued' }
  | { status: 'dropped'; reason: 'capacity' | 'expired' | 'event_too_large' };

export type EnqueueResult = EnqueueOutcome | { status: 'storage_error'; fallback: EnqueueOutcome };

export type QueueReadResult =
  { status: 'read'; events: AnalyticsEvent[] } | { status: 'storage_error' };

type ClaimOutcome =
  | { status: 'claimed'; claimId: string; expiresAt: number; events: AnalyticsEvent[] }
  | { status: 'empty' };

export type ClaimBatchResult = ClaimOutcome | { status: 'storage_error' };

type ReleaseOutcome = { status: 'released' } | { status: 'not_owned' };
export type ReleaseClaimResult = ReleaseOutcome | { status: 'storage_error' };

export type ApplyResponseResult =
  | { status: 'applied' }
  | { status: 'invalid_response' }
  | { status: 'not_owned' }
  | { status: 'storage_error' };

type ApplyOutcome = { status: 'applied' } | { status: 'not_owned' };

interface QueueLimits {
  maxEvents: number;
  maxBytes: number;
  maxAgeMs: number;
}

function validateLimits(limits: QueueLimits, prefix = ''): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${prefix}${name} must be a positive safe integer`);
    }
  }
}

function decideEnqueue(
  events: AnalyticsEvent[],
  event: AnalyticsEvent,
  time: number,
  limits: QueueLimits,
): EnqueueOutcome {
  if (events.some((stored) => stored.eventId === event.eventId)) {
    return { status: 'already_queued' };
  }
  if (isExpired(event, time, limits.maxAgeMs)) {
    return { status: 'dropped', reason: 'expired' };
  }
  const usedBytes = events.reduce((total, stored) => total + payloadBytes(stored), 0);
  if (events.length >= limits.maxEvents || payloadBytes(event) > limits.maxBytes - usedBytes) {
    return { status: 'dropped', reason: 'capacity' };
  }
  return { status: 'queued' };
}

export interface EventQueueOptions {
  maxEvents?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
  random?: () => number;
  memory?: {
    maxEvents?: number;
    maxBytes?: number;
  };
}

function queueDatabaseName(config: EventQueueConfig): string {
  const normalized = normalizeQueueConfig(config);
  return `signaltrail:analytics:v1:${JSON.stringify([normalized.ingestionUrl, normalized.projectKey])}`;
}

export type DeliverySnapshot =
  | { status: 'read'; events: AnalyticsEvent[]; nextEligibleAt?: number }
  | { status: 'storage_error' };
type PendingEvents = { events: AnalyticsEvent[]; nextEligibleAt?: number };

export interface EventQueue {
  readonly storageMode: 'indexeddb' | 'memory';
  inspectDelivery(): Promise<DeliverySnapshot>;
  enqueue(event: AnalyticsEvent): Promise<EnqueueResult>;
  getAll(): Promise<QueueReadResult>;
  claimBatch(limit?: number, eventId?: string, maxRequestBytes?: number): Promise<ClaimBatchResult>;
  releaseClaim(claimId: string): Promise<ReleaseClaimResult>;
  applyResponse(claimId: string, response: unknown): Promise<ApplyResponseResult>;
  discardClaim(claimId: string): Promise<ApplyResponseResult>;
  retryClaim(claimId: string, minimumDelayMs?: number): Promise<ApplyResponseResult>;
  close(): void;
}

interface QueueStorage {
  inspectDelivery(): Promise<PendingEvents>;
  readonly storageMode: 'indexeddb' | 'memory';
  enqueue(event: AnalyticsEvent): Promise<EnqueueOutcome>;
  getAll(): Promise<AnalyticsEvent[]>;
  claimBatch(limit: number, eventId?: string, maxRequestBytes?: number): Promise<ClaimOutcome>;
  releaseClaim(claimId: string): Promise<ReleaseOutcome>;
  applyResponse(
    claimId: string,
    events: readonly AnalyticsEvent[],
    response: BatchResponse,
  ): Promise<ApplyOutcome>;
  close(): void;
}

function withRecovery(
  initial: QueueStorage,
  memoryLimits: QueueLimits,
  now: () => number,
  random: () => number,
): EventQueue {
  let storage = initial;
  let closed = false;
  const issuedClaims = new Map<string, { expiresAt: number; events: AnalyticsEvent[] }>();

  function degrade(source: QueueStorage): void {
    if (storage === source) {
      source.close();
      issuedClaims.clear();
      storage = createMemoryQueue(memoryLimits, now, random);
    }
  }

  async function applyResponse(claimId: string, response: unknown): Promise<ApplyResponseResult> {
    if (closed) throw new DOMException('The queue connection is closed', 'InvalidStateError');
    const original = issuedClaims.get(claimId);
    if (!original || original.expiresAt <= now()) return { status: 'not_owned' };
    const parsed = AnalyticsBatchResponseSchema.safeParse(response);
    if (!parsed.success || !isAnalyticsBatchResponseForEvents(parsed.data, original.events)) {
      return { status: 'invalid_response' };
    }
    const source = storage;
    try {
      const result = await source.applyResponse(claimId, original.events, parsed.data);
      issuedClaims.delete(claimId);
      return source === storage ? result : { status: 'storage_error' };
    } catch (error) {
      if (closed || source.storageMode === 'memory') throw error;
      degrade(source);
      return { status: 'storage_error' };
    }
  }

  return {
    get storageMode() {
      return storage.storageMode;
    },
    async inspectDelivery() {
      if (closed) throw new DOMException('The queue connection is closed', 'InvalidStateError');
      const source = storage;
      try {
        const result = await source.inspectDelivery();
        return source === storage ? { status: 'read', ...result } : { status: 'storage_error' };
      } catch (error) {
        if (closed || source.storageMode === 'memory') throw error;
        degrade(source);
        return { status: 'storage_error' };
      }
    },
    applyResponse,
    async discardClaim(claimId) {
      if (closed) throw new DOMException('The queue connection is closed', 'InvalidStateError');
      const original = issuedClaims.get(claimId);
      if (!original) return { status: 'not_owned' };
      // A local terminal disposition reuses atomic lease checks and removal.
      // This internal cleanup value is never sent as an ingestion response.
      return applyResponse(claimId, {
        results: original.events.map((_event, index) => ({
          index,
          status: 'rejected',
          code: 'INVALID_EVENT',
        })),
      });
    },
    async retryClaim(claimId, minimumDelayMs = 0) {
      if (closed) throw new DOMException('The queue connection is closed', 'InvalidStateError');
      if (!Number.isSafeInteger(minimumDelayMs) || minimumDelayMs < 0) {
        throw new RangeError('minimumDelayMs must be a nonnegative safe integer');
      }
      const original = issuedClaims.get(claimId);
      if (!original) return { status: 'not_owned' };
      // Local delivery failure uses the same atomic retention/backoff update.
      return applyResponse(claimId, {
        results: original.events.map((event, index) => ({
          index,
          eventId: event.eventId,
          status: 'retry',
          code: 'PUBLICATION_UNCONFIRMED',
          retryAfterMs: minimumDelayMs,
        })),
      });
    },
    async claimBatch(limit = MAX_CLAIM_EVENTS, eventId, maxRequestBytes) {
      if (closed) throw new DOMException('The queue connection is closed', 'InvalidStateError');
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLAIM_EVENTS) {
        throw new RangeError('limit must be an integer from 1 to 100');
      }
      const source = storage;
      try {
        const result = await source.claimBatch(limit, eventId, maxRequestBytes);
        if (source !== storage) return { status: 'storage_error' };
        for (const [id, existing] of issuedClaims) {
          if (existing.expiresAt <= now()) issuedClaims.delete(id);
        }
        if (result.status === 'claimed') {
          issuedClaims.set(result.claimId, {
            expiresAt: result.expiresAt,
            events: structuredClone(result.events),
          });
        }
        return result;
      } catch (error) {
        if (closed || source.storageMode === 'memory') throw error;
        degrade(source);
        return { status: 'storage_error' };
      }
    },
    async releaseClaim(claimId) {
      if (closed) throw new DOMException('The queue connection is closed', 'InvalidStateError');
      if (typeof claimId !== 'string' || !/\S/.test(claimId)) {
        throw new TypeError('claimId must be a nonblank string');
      }
      const source = storage;
      try {
        const result = await source.releaseClaim(claimId);
        issuedClaims.delete(claimId);
        return source === storage ? result : { status: 'storage_error' };
      } catch (error) {
        if (closed || source.storageMode === 'memory') throw error;
        degrade(source);
        return { status: 'storage_error' };
      }
    },
    async enqueue(event) {
      if (closed) throw new DOMException('The queue connection is closed', 'InvalidStateError');
      const captured = structuredClone(event);
      const source = storage;
      try {
        return await source.enqueue(captured);
      } catch (error) {
        if (closed || source.storageMode === 'memory') throw error;
        degrade(source);
        return { status: 'storage_error', fallback: await storage.enqueue(captured) };
      }
    },
    async getAll() {
      if (closed) throw new DOMException('The queue connection is closed', 'InvalidStateError');
      const source = storage;
      try {
        const events = await source.getAll();
        if (source !== storage) return { status: 'storage_error' };
        return { status: 'read', events };
      } catch (error) {
        if (closed || source.storageMode === 'memory') throw error;
        degrade(source);
        return { status: 'storage_error' };
      }
    },
    close() {
      closed = true;
      issuedClaims.clear();
      storage.close();
    },
  };
}

function createMemoryQueue(
  limits: QueueLimits,
  now: () => number,
  random: () => number,
): QueueStorage {
  let events: AnalyticsEvent[] = [];
  const claims = new Map<string, { claimId: string; expiresAt: number }>();
  const retries = new Map<string, RetryState>();
  let closed = false;

  function ensureOpen(): void {
    if (closed) throw new DOMException('The queue connection is closed', 'InvalidStateError');
  }

  function prune(time: number): void {
    events = events.filter((stored) => {
      if (!isExpired(stored, time, limits.maxAgeMs)) return true;
      claims.delete(stored.eventId);
      retries.delete(stored.eventId);
      return false;
    });
  }

  return {
    storageMode: 'memory',
    async inspectDelivery() {
      ensureOpen();
      const time = now();
      prune(time);
      const eligible: AnalyticsEvent[] = [];
      let next = Infinity;
      for (const event of events) {
        const due = Math.max(
          claims.get(event.eventId)?.expiresAt ?? 0,
          retries.get(event.eventId)?.nextEligibleAt ?? 0,
        );
        if (due <= time) eligible.push(event);
        else next = Math.min(next, due);
      }
      return {
        events: structuredClone(eligible),
        ...(Number.isFinite(next) ? { nextEligibleAt: next } : {}),
      };
    },
    async applyResponse(claimId, expected, response) {
      ensureOpen();
      const time = now();
      const owned = [...claims.values()].filter((record) => record.claimId === claimId);
      if (
        owned.length !== expected.length ||
        expected.some((item) => {
          const record = claims.get(item.eventId);
          const stored = events.find((entry) => entry.eventId === item.eventId);
          return (
            !record ||
            record.claimId !== claimId ||
            record.expiresAt <= time ||
            !stored ||
            isExpired(stored, time, limits.maxAgeMs)
          );
        })
      )
        return { status: 'not_owned' };
      const removed = new Set(
        response.results
          .filter((result) => result.status !== 'retry')
          .map((result) => expected[result.index]!.eventId),
      );
      const scheduled = response.results
        .filter((result) => result.status === 'retry')
        .map((result) => {
          const eventId = expected[result.index]!.eventId;
          return [
            eventId,
            nextRetryState(retries.get(eventId), time, result.retryAfterMs, random),
          ] as const;
        });
      events = events.filter((item) => !removed.has(item.eventId));
      for (const eventId of removed) retries.delete(eventId);
      for (const [eventId, state] of scheduled) retries.set(eventId, state);
      for (const item of expected) claims.delete(item.eventId);
      return { status: 'applied' };
    },
    async claimBatch(limit, eventId, maxRequestBytes = Infinity) {
      ensureOpen();
      const time = now();
      prune(time);
      const candidates = events
        .filter((item) => {
          const existing = claims.get(item.eventId);
          const retry = retries.get(item.eventId);
          return (
            (eventId === undefined || item.eventId === eventId) &&
            (!existing || existing.expiresAt <= time) &&
            (!retry || retry.nextEligibleAt <= time)
          );
        })
        .slice(0, limit);
      const selected: AnalyticsEvent[] = [];
      for (const candidate of candidates) {
        if (
          selected.length &&
          encoder.encode(JSON.stringify({ events: [...selected, candidate] })).byteLength >
            maxRequestBytes
        )
          break;
        selected.push(candidate);
        if (encoder.encode(JSON.stringify({ events: selected })).byteLength > maxRequestBytes)
          break;
      }
      if (!selected.length) return { status: 'empty' };
      const claimId = uniqueId();
      const expiresAt = time + CLAIM_LEASE_MS;
      for (const item of selected) claims.set(item.eventId, { claimId, expiresAt });
      return { status: 'claimed', claimId, expiresAt, events: structuredClone(selected) };
    },
    async releaseClaim(claimId) {
      ensureOpen();
      const time = now();
      prune(time);
      let released = false;
      for (const [eventId, existing] of claims) {
        if (existing.claimId === claimId && existing.expiresAt > time) {
          claims.delete(eventId);
          released = true;
        }
      }
      return released ? { status: 'released' } : { status: 'not_owned' };
    },
    async enqueue(event) {
      ensureOpen();
      const time = now();
      prune(time);
      const result = decideEnqueue(events, event, time, limits);
      if (result.status !== 'queued') return result;
      events.push(structuredClone(event));
      return result;
    },
    async getAll() {
      ensureOpen();
      const time = now();
      prune(time);
      return structuredClone(events);
    },
    close() {
      closed = true;
      events = [];
      claims.clear();
      retries.clear();
    },
  };
}

export async function openEventQueue(
  config: EventQueueConfig,
  options: EventQueueOptions = {},
): Promise<EventQueue> {
  // Resolve once: later changes to the caller's object cannot redirect this queue.
  const databaseName = queueDatabaseName(config);
  const limits = {
    maxEvents: options.maxEvents ?? 500,
    maxBytes: options.maxBytes ?? 1024 * 1024,
    maxAgeMs: options.maxAgeMs ?? 24 * 60 * 60 * 1000,
  };
  const memoryLimits = {
    maxEvents: options.memory?.maxEvents ?? 100,
    maxBytes: options.memory?.maxBytes ?? 256 * 1024,
    maxAgeMs: limits.maxAgeMs,
  };
  validateLimits(limits);
  validateLimits(memoryLimits, 'memory.');
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const ownerId = uniqueId();
  const versionNumber = 3;
  let database: IDBPDatabase<QueueDatabase>;
  try {
    database = await openDB<QueueDatabase>(databaseName, versionNumber, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          const store = database.createObjectStore('events', { autoIncrement: true });
          store.createIndex('byEventId', 'eventId', { unique: true });
        }
        if (oldVersion < 2) {
          const store = database.createObjectStore('claims', { keyPath: 'eventKey' });
          store.createIndex('byClaimId', 'claimId');
        }
        if (oldVersion < 3) database.createObjectStore('retries', { keyPath: 'eventKey' });
      },
    });
  } catch {
    return withRecovery(createMemoryQueue(memoryLimits, now, random), memoryLimits, now, random);
  }

  return withRecovery(
    {
      storageMode: 'indexeddb',
      async applyResponse(claimId, expected, response): Promise<ApplyOutcome> {
        return inTransaction(database, async (transaction) => {
          const records = await transaction
            .objectStore('claims')
            .index('byClaimId')
            .getAll(claimId);
          if (records.length !== expected.length) return { status: 'not_owned' };
          const stored = await Promise.all(
            records.map((record) => transaction.objectStore('events').get(record.eventKey)),
          );
          const time = now();
          if (
            records.some(
              (record, index) =>
                record.ownerId !== ownerId ||
                record.expiresAt <= time ||
                !stored[index] ||
                stored[index].eventId !== expected[index]?.eventId ||
                isExpired(stored[index], time, limits.maxAgeMs),
            )
          )
            return { status: 'not_owned' };
          for (const result of response.results) {
            const record = records[result.index]!;
            if (result.status === 'retry') {
              const previous = await transaction.objectStore('retries').get(record.eventKey);
              const state = nextRetryState(previous, time, result.retryAfterMs, random);
              await transaction.objectStore('retries').put({ eventKey: record.eventKey, ...state });
            } else {
              await transaction.objectStore('events').delete(record.eventKey);
              await transaction.objectStore('retries').delete(record.eventKey);
            }
            await transaction.objectStore('claims').delete(record.eventKey);
          }
          return { status: 'applied' };
        });
      },
      async releaseClaim(claimId): Promise<ReleaseOutcome> {
        return inTransaction(database, async (transaction) => {
          let cursor = await transaction
            .objectStore('claims')
            .index('byClaimId')
            .openCursor(claimId);
          const time = now();
          let released = false;
          while (cursor) {
            if (cursor.value.ownerId === ownerId && cursor.value.expiresAt > time) {
              await cursor.delete();
              released = true;
            }
            cursor = await cursor.continue();
          }
          return released ? { status: 'released' } : { status: 'not_owned' };
        });
      },
      async inspectDelivery() {
        return inTransaction(database, async (transaction) => {
          const time = now();
          await readUnexpired(transaction, time, limits.maxAgeMs);
          const events: AnalyticsEvent[] = [];
          let next = Infinity;
          let cursor = await transaction.objectStore('events').openCursor();
          while (cursor) {
            const claim = await transaction.objectStore('claims').get(cursor.primaryKey);
            const retry = await transaction.objectStore('retries').get(cursor.primaryKey);
            const due = Math.max(claim?.expiresAt ?? 0, retry?.nextEligibleAt ?? 0);
            if (due <= time) events.push(cursor.value);
            else next = Math.min(next, due);
            cursor = await cursor.continue();
          }
          return { events, ...(Number.isFinite(next) ? { nextEligibleAt: next } : {}) };
        });
      },
      async claimBatch(limit, eventId, maxRequestBytes = Infinity): Promise<ClaimOutcome> {
        return inTransaction(database, async (transaction) => {
          await readUnexpired(transaction, now(), limits.maxAgeMs);
          const time = now();
          const expiresAt = time + CLAIM_LEASE_MS;
          const claimId = uniqueId();
          const events: AnalyticsEvent[] = [];
          let cursor = await transaction.objectStore('events').openCursor();
          while (cursor && events.length < limit) {
            if (isExpired(cursor.value, time, limits.maxAgeMs)) {
              await cursor.delete();
              await transaction.objectStore('claims').delete(cursor.primaryKey);
              await transaction.objectStore('retries').delete(cursor.primaryKey);
              cursor = await cursor.continue();
              continue;
            }
            const existing = await transaction.objectStore('claims').get(cursor.primaryKey);
            const retry = await transaction.objectStore('retries').get(cursor.primaryKey);
            if (
              (eventId === undefined || cursor.value.eventId === eventId) &&
              (!existing || existing.expiresAt <= time) &&
              (!retry || retry.nextEligibleAt <= time)
            ) {
              const size = encoder.encode(
                JSON.stringify({ events: [...events, cursor.value] }),
              ).byteLength;
              if (events.length && size > maxRequestBytes) break;
              events.push(cursor.value);
              await transaction.objectStore('claims').put({
                eventKey: cursor.primaryKey,
                ownerId,
                claimId,
                expiresAt,
              });
              if (size > maxRequestBytes) break;
            }
            cursor = await cursor.continue();
          }
          return events.length
            ? { status: 'claimed', claimId, expiresAt, events }
            : { status: 'empty' };
        });
      },
      async enqueue(event): Promise<EnqueueOutcome> {
        return inTransaction(database, async (transaction) => {
          const time = now();
          const events = await readUnexpired(transaction, time, limits.maxAgeMs);
          const result = decideEnqueue(events, event, time, limits);
          if (result.status === 'queued') await transaction.objectStore('events').add(event);
          return result;
        });
      },
      async getAll() {
        return inTransaction(database, (transaction) =>
          readUnexpired(transaction, now(), limits.maxAgeMs),
        );
      },
      close() {
        database.close();
      },
    },
    memoryLimits,
    now,
    random,
  );
}
