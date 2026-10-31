export interface EventCursor {
  receivedAt: string;
  eventId: string;
}

export function encodeEventCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeEventCursor(value: string): EventCursor {
  if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new TypeError('Invalid event cursor');
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as EventCursor;
    if (
      !parsed ||
      Object.keys(parsed).length !== 2 ||
      typeof parsed.receivedAt !== 'string' ||
      typeof parsed.eventId !== 'string' ||
      !/\S/.test(parsed.eventId) ||
      Buffer.byteLength(parsed.eventId) > 4096 ||
      Buffer.from(parsed.eventId).toString() !== parsed.eventId
    )
      throw new Error();
    return parsed;
  } catch {
    throw new TypeError('Invalid event cursor');
  }
}
