/**
 * RFC 9562 version 7 UUID. The leading 48-bit capture millisecond keeps event IDs, and
 * therefore storage rows sorted by them, clustered by time. Randomness fills the rest.
 */
export function createEventId(time: number = Date.now()): string {
  if (!Number.isSafeInteger(time) || time < 0 || time >= 2 ** 48)
    throw new RangeError('Event ID time must be a 48-bit millisecond timestamp');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let index = 5, rest = time; index >= 0; index--, rest = Math.floor(rest / 256))
    bytes[index] = rest % 256;
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function eventIdTime(eventId: string): number {
  return parseInt(eventId.slice(0, 8) + eventId.slice(9, 13), 16);
}
