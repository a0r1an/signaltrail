import { expect, it, vi } from 'vitest';
import { createEventId, eventIdTime } from '../../src/event-id.ts';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it('creates RFC 9562 version 7 identifiers carrying the capture millisecond', () => {
  const time = Date.parse('2026-11-05T12:00:00.123Z');
  const id = createEventId(time);
  expect(id).toMatch(UUID_V7);
  expect(eventIdTime(id)).toBe(time);
});

it('sorts lexicographically by capture time so storage keeps events time-clustered', () => {
  const times = [0, 1, 1790856000000, 1790856000001, 281474976710655];
  const ids = times.map((time) => createEventId(time));
  expect([...ids].sort()).toEqual(ids);
});

it('fills the remaining bits from the secure random source', () => {
  const random = vi.spyOn(crypto, 'getRandomValues');
  const ids = new Set(Array.from({ length: 1000 }, () => createEventId(1790856000000)));
  expect(ids.size).toBe(1000);
  expect(random).toHaveBeenCalled();
  random.mockRestore();
});

it.each([-1, 1.5, Number.NaN, 2 ** 48])('rejects unrepresentable capture times: %s', (time) => {
  expect(() => createEventId(time)).toThrow(RangeError);
});
