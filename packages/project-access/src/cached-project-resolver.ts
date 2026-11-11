import { hashIngestionKey } from './ingestion-keys.ts';

export interface ProjectCacheOptions {
  /** Backstop for missed invalidations; revocation normally arrives by notification. */
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}
type Lookup = (key: string, signal?: AbortSignal) => Promise<string | undefined>;

/**
 * Remembers key→project results (including unknown keys) only while an invalidation channel
 * is live; otherwise every request goes to the database, keeping revocation immediate.
 */
export function createCachedProjectResolver(lookup: Lookup, options: ProjectCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? 300000;
  const maxEntries = options.maxEntries ?? 10000;
  const now = options.now ?? Date.now;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 3600000 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 1000000
  )
    throw new TypeError('Invalid project cache configuration');
  const entries = new Map<string, { projectId: string | undefined; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string | undefined>>();
  let trusted = false;
  // Any invalidation bumps the version; lookups that started earlier are not stored.
  let version = 0;
  let hits = 0;
  let misses = 0;
  const clear = () => {
    version++;
    entries.clear();
    inFlight.clear();
  };
  return {
    async resolve(key: string, signal?: AbortSignal): Promise<string | undefined> {
      let hash: string;
      try {
        hash = hashIngestionKey(key);
      } catch {
        return lookup(key, signal);
      }
      if (!trusted) return lookup(key, signal);
      const cached = entries.get(hash);
      if (cached && cached.expiresAt > now()) {
        hits++;
        return cached.projectId;
      }
      entries.delete(hash);
      const pending = inFlight.get(hash);
      if (pending) return pending;
      misses++;
      const started = version;
      const request = lookup(key, signal)
        .then((projectId) => {
          if (trusted && version === started) {
            entries.set(hash, { projectId, expiresAt: now() + ttlMs });
            if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
          }
          return projectId;
        })
        .finally(() => {
          if (inFlight.get(hash) === request) inFlight.delete(hash);
        });
      inFlight.set(hash, request);
      return request;
    },
    invalidate(keyHash: string) {
      version++;
      entries.delete(keyHash);
      inFlight.delete(keyHash);
    },
    clear,
    setTrusted(value: boolean) {
      if (!value) clear();
      trusted = value;
    },
    snapshot() {
      return { trusted, entries: entries.size, hits, misses };
    },
  };
}
