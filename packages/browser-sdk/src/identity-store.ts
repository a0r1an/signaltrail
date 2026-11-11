import {
  AnalyticsEventSchema,
  AnalyticsIdentitySchema,
  IDENTITY_LINK_EVENT_NAME,
} from '@signaltrail/contracts';
import type { PageContext } from './capture-url.ts';
import { createEventId } from './event-id.ts';
import { SDK_VERSION } from './version.ts';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { normalizeQueueConfig, type EventQueueConfig } from './project-config.ts';

type AnalyticsEvent = ReturnType<typeof AnalyticsEventSchema.parse>;
const MAX_PENDING_LINKS = 64;
const MAX_PENDING_BYTES = 1024 * 1024;
import { IDENTITY_LINK_MAX_AGE_MS } from './identity-policy.ts';
const INACTIVITY_MS = 30 * 60 * 1000;
export interface AnonymousIdentity {
  anonymousId: string;
  sessionId: string;
  sequence: number;
  capturedAt: number;
  identifiedId?: string;
}
interface StoredIdentity {
  version: 1;
  anonymousId: string;
  sessionId: string;
  nextSequence: number;
  lastActivity: number;
  identifiedId?: string;
}
interface IdentityDatabase extends DBSchema {
  identity: { key: string; value: StoredIdentity };
  outbox: { key: string; value: AnalyticsEvent };
}
function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
}
function validateStored(value: StoredIdentity) {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.anonymousId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    ![value.anonymousId, value.sessionId].every((id) => /^[a-f0-9-]{36}$/.test(id)) ||
    !Number.isSafeInteger(value.nextSequence) ||
    value.nextSequence < 0 ||
    !validTime(value.lastActivity) ||
    (value.identifiedId !== undefined &&
      !AnalyticsIdentitySchema.shape.userId.safeParse(value.identifiedId).success)
  )
    throw new Error('Identity storage unavailable');
}
function fresh(time: number): StoredIdentity {
  return {
    version: 1,
    anonymousId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    nextSequence: 0,
    lastActivity: time,
  };
}
/** Internal durable foundation. Unavailable identity storage never pretends a reset succeeded. */
export async function openIdentityStore(
  config: EventQueueConfig,
  options: { now?: () => number } = {},
) {
  const normalized = normalizeQueueConfig(config);
  const name = `signaltrail:identity:v1:${JSON.stringify([normalized.ingestionUrl, normalized.projectKey])}`;
  const now = options.now ?? Date.now;
  let database: IDBPDatabase<IdentityDatabase> | undefined;
  let closed = false;
  let opening: Promise<IDBPDatabase<IdentityDatabase>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectBlocked!: (reason: Error) => void;
  const blocked = new Promise<never>((_resolve, reject) => {
    rejectBlocked = reject;
  });
  try {
    opening = openDB<IdentityDatabase>(name, 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) db.createObjectStore('identity');
        if (oldVersion < 2) db.createObjectStore('outbox');
      },
      blocked() {
        rejectBlocked(new Error('Identity storage unavailable'));
      },
      blocking() {
        closed = true;
        database?.close();
      },
      terminated() {
        closed = true;
      },
    });
    database = await Promise.race([
      opening,
      blocked,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Identity storage unavailable')), 5000);
      }),
    ]);
  } catch {
    void opening?.then(
      (db) => db.close(),
      () => {},
    );
    throw new Error('Identity storage unavailable');
  } finally {
    clearTimeout(timer);
  }
  const db = database;
  async function change(reset: boolean): Promise<AnonymousIdentity | undefined> {
    if (closed) throw new Error('Identity storage unavailable');
    const time = now();
    if (!validTime(time)) throw new TypeError('Invalid capture clock');
    const tx = db.transaction('identity', 'readwrite');
    // Observe completion before requests so aborts cannot create unhandled rejections.
    const completion = tx.done.then(
      () => true,
      () => false,
    );
    try {
      const previous = await tx.store.get('current');
      if (previous !== undefined) validateStored(previous);
      let state = reset || previous === undefined ? fresh(time) : previous;
      if (reset) {
        await tx.store.put(state, 'current');
        if (!(await completion)) throw new Error();
        return;
      }
      if (
        time - state.lastActivity >= INACTIVITY_MS ||
        state.nextSequence === Number.MAX_SAFE_INTEGER
      )
        state = { ...state, sessionId: crypto.randomUUID(), nextSequence: 0 };
      const selected = {
        anonymousId: state.anonymousId,
        sessionId: state.sessionId,
        sequence: state.nextSequence,
        capturedAt: time,
        ...(state.identifiedId === undefined ? {} : { identifiedId: state.identifiedId }),
      };
      state = {
        ...state,
        nextSequence: state.nextSequence + 1,
        lastActivity: Math.max(time, state.lastActivity),
      };
      await tx.store.put(state, 'current');
      if (!(await completion)) throw new Error();
      return selected;
    } catch {
      try {
        tx.abort();
      } catch {
        /* Already completed. */
      }
      await completion;
      throw new Error('Identity storage unavailable');
    }
  }
  return {
    async allocate(): Promise<AnonymousIdentity> {
      return (await change(false))!;
    },
    async reset(): Promise<void> {
      await change(true);
    },
    async identify(userId: string, page: PageContext): Promise<{ changed: boolean }> {
      if (!AnalyticsIdentitySchema.shape.userId.safeParse(userId).success)
        throw new TypeError('Invalid user ID');
      if (closed) throw new Error('Identity storage unavailable');
      const time = now();
      if (!validTime(time)) throw new TypeError('Invalid capture clock');
      const tx = db.transaction(['identity', 'outbox'], 'readwrite');
      const completion = tx.done.then(
        () => true,
        () => false,
      );
      try {
        const previous = await tx.objectStore('identity').get('current');
        if (previous !== undefined) validateStored(previous);
        if (previous?.identifiedId === userId) {
          if (!(await completion)) throw new Error();
          return { changed: false };
        }
        let state =
          previous?.identifiedId !== undefined || previous === undefined ? fresh(time) : previous;
        if (
          time - state.lastActivity >= INACTIVITY_MS ||
          state.nextSequence === Number.MAX_SAFE_INTEGER
        )
          state = { ...state, sessionId: crypto.randomUUID(), nextSequence: 0 };
        const link = AnalyticsEventSchema.parse({
          schemaVersion: 1,
          eventId: createEventId(time),
          eventName: IDENTITY_LINK_EVENT_NAME,
          distinctId: userId,
          sessionId: state.sessionId,
          sequence: state.nextSequence,
          clientTimestamp: new Date(time).toISOString(),
          url: page.url,
          properties: {},
          context: {
            sdkVersion: SDK_VERSION,
            ...(Object.keys(page.campaign).length ? { campaign: page.campaign } : {}),
            identity: { kind: 'link', anonymousId: state.anonymousId, userId },
          },
        });
        const outbox = tx.objectStore('outbox');
        if ((await outbox.count()) >= MAX_PENDING_LINKS) throw new Error();
        const pending = await outbox.getAll();
        const bytes = (value: unknown) =>
          new TextEncoder().encode(JSON.stringify(value)).byteLength;
        if (pending.reduce((total, event) => total + bytes(event), bytes(link)) > MAX_PENDING_BYTES)
          throw new Error();
        await outbox.add(link, link.eventId);
        await tx.objectStore('identity').put(
          {
            ...state,
            identifiedId: userId,
            nextSequence: state.nextSequence + 1,
            lastActivity: Math.max(time, state.lastActivity),
          },
          'current',
        );
        if (!(await completion)) throw new Error();
        return { changed: true };
      } catch {
        try {
          tx.abort();
        } catch {
          /* Already complete. */
        }
        await completion;
        throw new Error('Identity storage unavailable');
      }
    },
    async pendingLinks(): Promise<AnalyticsEvent[]> {
      if (closed) throw new Error('Identity storage unavailable');
      const time = now();
      if (!validTime(time)) throw new TypeError('Invalid capture clock');
      const tx = db.transaction('outbox', 'readwrite');
      const completion = tx.done.then(
        () => true,
        () => false,
      );
      try {
        if ((await tx.store.count()) > MAX_PENDING_LINKS) throw new Error();
        const pending = await tx.store.getAll();
        const retained: AnalyticsEvent[] = [];
        for (const raw of pending) {
          const event = AnalyticsEventSchema.parse(raw);
          if (event.context.identity?.kind !== 'link') throw new Error();
          if (time - Date.parse(event.clientTimestamp) >= IDENTITY_LINK_MAX_AGE_MS)
            await tx.store.delete(event.eventId);
          else retained.push(event);
        }
        if (!(await completion)) throw new Error();
        return retained;
      } catch {
        try {
          tx.abort();
        } catch {
          /* Already complete. */
        }
        await completion;
        throw new Error('Identity storage unavailable');
      }
    },
    async acknowledgeLink(eventId: string): Promise<void> {
      if (closed) throw new Error('Identity storage unavailable');
      try {
        await db.delete('outbox', eventId);
      } catch {
        throw new Error('Identity storage unavailable');
      }
    },
    close() {
      closed = true;
      db.close();
    },
  };
}
