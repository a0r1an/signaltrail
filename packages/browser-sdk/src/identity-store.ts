import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { normalizeQueueConfig, type EventQueueConfig } from './project-config.ts';

const INACTIVITY_MS = 30 * 60 * 1000;
export interface AnonymousIdentity {
  anonymousId: string;
  sessionId: string;
  sequence: number;
  capturedAt: number;
}
interface StoredIdentity {
  version: 1;
  anonymousId: string;
  sessionId: string;
  nextSequence: number;
  lastActivity: number;
}
interface IdentityDatabase extends DBSchema {
  identity: { key: string; value: StoredIdentity };
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
    !validTime(value.lastActivity)
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
    opening = openDB<IdentityDatabase>(name, 1, {
      upgrade(db) {
        db.createObjectStore('identity');
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
    close() {
      closed = true;
      db.close();
    },
  };
}
