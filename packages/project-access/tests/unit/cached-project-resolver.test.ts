import { expect, it, vi } from 'vitest';
import {
  createCachedProjectResolver,
  createIngestionKey,
  hashIngestionKey,
} from '../../src/index.ts';

const project = '00000000-0000-0000-0000-000000000001';
function setup(options: { ttlMs?: number; maxEntries?: number } = {}) {
  let time = 0;
  const lookup = vi.fn<(key: string) => Promise<string | undefined>>(async () => project);
  const cache = createCachedProjectResolver(lookup, { ...options, now: () => time });
  cache.setTrusted(true);
  return { cache, lookup, advance: (ms: number) => (time += ms) };
}

it('serves repeat lookups from memory, including unknown keys, while invalidation is live', async () => {
  const { cache, lookup } = setup();
  const known = createIngestionKey(),
    unknown = createIngestionKey();
  lookup.mockImplementation(async (key) => (key === known ? project : undefined));
  expect(await cache.resolve(known)).toBe(project);
  expect(await cache.resolve(known)).toBe(project);
  expect(await cache.resolve(unknown)).toBeUndefined();
  expect(await cache.resolve(unknown)).toBeUndefined();
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(cache.snapshot()).toMatchObject({ trusted: true, entries: 2, hits: 2, misses: 2 });
});

it('bypasses and clears the cache whenever the invalidation channel is not live', async () => {
  const { cache, lookup } = setup();
  const key = createIngestionKey();
  await cache.resolve(key);
  cache.setTrusted(false);
  expect(cache.snapshot().entries).toBe(0);
  await cache.resolve(key);
  await cache.resolve(key);
  expect(lookup).toHaveBeenCalledTimes(3);
  expect(cache.snapshot().entries).toBe(0);
});

it('drops a key on invalidation by hash, or everything on clear', async () => {
  const { cache, lookup } = setup();
  const a = createIngestionKey(),
    b = createIngestionKey();
  await cache.resolve(a);
  await cache.resolve(b);
  cache.invalidate(hashIngestionKey(a));
  await cache.resolve(a);
  await cache.resolve(b);
  expect(lookup).toHaveBeenCalledTimes(3);
  cache.clear();
  await cache.resolve(b);
  expect(lookup).toHaveBeenCalledTimes(4);
});

it('expires entries after the TTL backstop', async () => {
  const { cache, lookup, advance } = setup({ ttlMs: 1000 });
  const key = createIngestionKey();
  await cache.resolve(key);
  advance(999);
  await cache.resolve(key);
  advance(1);
  await cache.resolve(key);
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('does not cache a lookup that was invalidated while in flight', async () => {
  const { cache, lookup } = setup();
  const key = createIngestionKey();
  let release!: () => void;
  lookup.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(project))));
  const pending = cache.resolve(key);
  cache.invalidate(hashIngestionKey(key));
  release();
  expect(await pending).toBe(project);
  await cache.resolve(key);
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('coalesces concurrent misses for one key and never caches failures', async () => {
  const { cache, lookup } = setup();
  const key = createIngestionKey();
  lookup.mockRejectedValueOnce(new Error('Ingestion project was not confirmed'));
  const results = await Promise.allSettled([cache.resolve(key), cache.resolve(key)]);
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(await cache.resolve(key)).toBe(project);
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('bounds memory by evicting the oldest entry', async () => {
  const { cache, lookup } = setup({ maxEntries: 2 });
  const [a, b, c] = [createIngestionKey(), createIngestionKey(), createIngestionKey()];
  for (const key of [a, b, c]) await cache.resolve(key);
  await cache.resolve(c);
  await cache.resolve(a);
  expect(lookup).toHaveBeenCalledTimes(4);
  expect(cache.snapshot().entries).toBe(2);
});

it('passes malformed keys through without caching them', async () => {
  const { cache, lookup } = setup();
  lookup.mockResolvedValue(undefined);
  await cache.resolve('not-a-key');
  await cache.resolve('not-a-key');
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(cache.snapshot().entries).toBe(0);
});

it.each([{ ttlMs: 0 }, { ttlMs: 3600001 }, { maxEntries: 0 }, { maxEntries: 1000001 }])(
  'rejects invalid cache bounds: %o',
  (options) => {
    expect(() => createCachedProjectResolver(async () => undefined, options)).toThrow(
      'Invalid project cache configuration',
    );
  },
);
