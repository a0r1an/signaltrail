export interface EventCursor {
  version: 1;
  scope: string;
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
      Object.keys(parsed).length !== 4 ||
      parsed.version !== 1 ||
      typeof parsed.scope !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.scope) ||
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
