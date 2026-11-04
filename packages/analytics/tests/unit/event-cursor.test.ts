import { expect, it } from 'vitest';
import { encodeEventCursor, decodeEventCursor } from '../../src/event-cursor.ts';

const cursor = {
  version: 1 as const,
  scope: 'a'.repeat(64),
  receivedAt: '2026-11-01T00:00:00.000Z',
  eventId: 'event-1',
};

it.each(['x'.repeat(4096), '😀'.repeat(1024), 'x' + '\u0000'.repeat(4095)])(
  'round-trips a maximum-byte identifier within the cursor wire cap',
  (eventId) => {
    const input = { ...cursor, eventId };
    const value = encodeEventCursor(input);
    expect(value.length).toBeLessThanOrEqual(8192);
    expect(decodeEventCursor(value)).toEqual(input);
  },
);

it('continues accepting bounded version-one cursors', () => {
  const value = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  expect(decodeEventCursor(value)).toEqual(cursor);
});

it.each(['YQ==', 'YQ!', '_w', '', Buffer.alloc(4097, 120).toString('base64url')])(
  'rejects malformed or oversized version-two identifier bytes',
  (eventId) => {
    const value = Buffer.from(JSON.stringify({ ...cursor, version: 2, eventId })).toString(
      'base64url',
    );
    expect(() => decodeEventCursor(value)).toThrow('Invalid event cursor');
  },
);
