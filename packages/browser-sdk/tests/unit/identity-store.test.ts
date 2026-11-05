import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, expect, it, vi } from 'vitest';
import { openIdentityStore } from '../../src/identity-store.ts';
const config = { projectKey: 'identity', ingestionUrl: 'https://ingest.example.com/events' };
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const db of await indexedDB.databases()) if (db.name) await deleteDB(db.name);
});
it('shares anonymous visitor/session and allocates unique ordered sequences across connections', async () => {
  const first = await openIdentityStore(config),
    second = await openIdentityStore(config);
  try {
    const [a, b] = await Promise.all([first.allocate(), second.allocate()]);
    expect(a.anonymousId).toBe(b.anonymousId);
    expect(a.sessionId).toBe(b.sessionId);
    expect([a.sequence, b.sequence].sort()).toEqual([0, 1]);
  } finally {
    first.close();
    second.close();
  }
});
it('persists identity and sequence through closing and reopening', async () => {
  let store = await openIdentityStore(config);
  try {
    const before = await store.allocate();
    store.close();
    store = await openIdentityStore(config);
    expect(await store.allocate()).toMatchObject({
      anonymousId: before.anonymousId,
      sessionId: before.sessionId,
      sequence: 1,
    });
  } finally {
    store.close();
  }
});
it('rotates only the session at the 30-minute inactivity boundary', async () => {
  let time = 1000;
  const store = await openIdentityStore(config, { now: () => time });
  try {
    const first = await store.allocate();
    time += 30 * 60 * 1000 - 1;
    const active = await store.allocate();
    expect(active).toMatchObject({
      anonymousId: first.anonymousId,
      sessionId: first.sessionId,
      sequence: 1,
    });
    time += 30 * 60 * 1000;
    const expired = await store.allocate();
    expect(expired.anonymousId).toBe(first.anonymousId);
    expect(expired.sessionId).not.toBe(first.sessionId);
    expect(expired.sequence).toBe(0);
  } finally {
    store.close();
  }
});
it('shares a reset with other connections without rewriting previously selected identities', async () => {
  const first = await openIdentityStore(config),
    second = await openIdentityStore(config);
  try {
    const old = await first.allocate();
    await second.reset();
    const fresh = await first.allocate();
    expect(fresh.anonymousId).not.toBe(old.anonymousId);
    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect(fresh.sequence).toBe(0);
    expect(old.sequence).toBe(0);
    expect(await second.allocate()).toMatchObject({
      anonymousId: fresh.anonymousId,
      sessionId: fresh.sessionId,
      sequence: 1,
    });
  } finally {
    first.close();
    second.close();
  }
});
it('isolates project keys and endpoints', async () => {
  const stores = await Promise.all([
    openIdentityStore(config),
    openIdentityStore({ ...config, projectKey: 'other' }),
    openIdentityStore({ ...config, ingestionUrl: 'https://another.example/events' }),
  ]);
  try {
    const identities = await Promise.all(stores.map((store) => store.allocate()));
    expect(new Set(identities.map((identity) => identity.anonymousId)).size).toBe(3);
  } finally {
    stores.forEach((store) => store.close());
  }
});
it('does not treat a backward clock as an expired session', async () => {
  let time = 10000;
  const store = await openIdentityStore(config, { now: () => time });
  try {
    const before = await store.allocate();
    time = 1000;
    expect(await store.allocate()).toMatchObject({
      anonymousId: before.anonymousId,
      sessionId: before.sessionId,
      sequence: 1,
    });
  } finally {
    store.close();
  }
});
it('rejects new operations after close', async () => {
  const store = await openIdentityStore(config);
  store.close();
  await expect(store.allocate()).rejects.toThrow('Identity storage unavailable');
  await expect(store.reset()).rejects.toThrow('Identity storage unavailable');
});
it('does not consume sequence numbers when a storage write aborts', async () => {
  const store = await openIdentityStore(config);
  try {
    const first = await store.allocate();
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new Error('private storage detail');
    });
    await expect(store.allocate()).rejects.toThrow('Identity storage unavailable');
    failure.mockRestore();
    expect(await store.allocate()).toMatchObject({
      anonymousId: first.anonymousId,
      sessionId: first.sessionId,
      sequence: 1,
    });
  } finally {
    store.close();
  }
});
it('rejects failed resets instead of claiming another tab has been reset', async () => {
  const store = await openIdentityStore(config);
  try {
    const first = await store.allocate();
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new Error('private storage detail');
    });
    await expect(store.reset()).rejects.toThrow('Identity storage unavailable');
    failure.mockRestore();
    expect(await store.allocate()).toMatchObject({ anonymousId: first.anonymousId, sequence: 1 });
  } finally {
    store.close();
  }
});
it('rejects unavailable IndexedDB without overwriting persisted identity', async () => {
  let store = await openIdentityStore(config);
  const first = await store.allocate();
  store.close();
  vi.stubGlobal('indexedDB', undefined);
  await expect(openIdentityStore(config)).rejects.toThrow('Identity storage unavailable');
  vi.unstubAllGlobals();
  store = await openIdentityStore(config);
  try {
    expect(await store.allocate()).toMatchObject({
      anonymousId: first.anonymousId,
      sessionId: first.sessionId,
      sequence: 1,
    });
  } finally {
    store.close();
  }
});
it('closes its connection for a future database upgrade and rejects new operations', async () => {
  const store = await openIdentityStore(config);
  await store.allocate();
  const name = (await indexedDB.databases()).find((db) =>
    db.name?.startsWith('signaltrail:identity:'),
  )!.name!;
  const upgraded = await openDB(name, 2);
  try {
    await expect(store.allocate()).rejects.toThrow('Identity storage unavailable');
  } finally {
    store.close();
    upgraded.close();
  }
});
it('rotates session before sequence precision is exhausted', async () => {
  const store = await openIdentityStore(config);
  try {
    const first = await store.allocate();
    const name = (await indexedDB.databases())[0]!.name!;
    const db = await openDB(name, 1);
    try {
      const current = (await db.get('identity', 'current')) as Record<string, unknown>;
      await db.put('identity', { ...current, nextSequence: Number.MAX_SAFE_INTEGER }, 'current');
    } finally {
      db.close();
    }
    const next = await store.allocate();
    expect(next.anonymousId).toBe(first.anonymousId);
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.sequence).toBe(0);
  } finally {
    store.close();
  }
});
