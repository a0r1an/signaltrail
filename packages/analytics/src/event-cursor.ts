export interface EventCursor {
  version: 1;
  scope: string;
  receivedAt: string;
  eventId: string;
}

export function encodeEventCursor(cursor: EventCursor): string {
  // Encode identifier bytes independently so JSON control-character escaping
  // cannot expand a valid 4-KiB ID beyond the 8-KiB cursor cap.
  const wire = {
    ...cursor,
    version: 2,
    eventId: Buffer.from(cursor.eventId).toString('base64url'),
  };
  return Buffer.from(JSON.stringify(wire)).toString('base64url');
}

export function decodeEventCursor(value: string): EventCursor {
  if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new TypeError('Invalid event cursor');
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Omit<
      EventCursor,
      'version'
    > & { version: number };
    if (
      !parsed ||
      Object.keys(parsed).length !== 4 ||
      (parsed.version !== 1 && parsed.version !== 2) ||
      typeof parsed.scope !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.scope) ||
      typeof parsed.receivedAt !== 'string' ||
      typeof parsed.eventId !== 'string' ||
      !/\S/.test(parsed.eventId)
    )
      throw new Error();
    let eventId = parsed.eventId;
    if (parsed.version === 2) {
      if (!/^[A-Za-z0-9_-]+$/.test(eventId)) throw new Error();
      const identifierBytes = Buffer.from(eventId, 'base64url');
      if (identifierBytes.toString('base64url') !== eventId) throw new Error();
      eventId = new TextDecoder('utf-8', { fatal: true }).decode(identifierBytes);
    }
    if (
      !/\S/.test(eventId) ||
      Buffer.byteLength(eventId) > 4096 ||
      Buffer.from(eventId).toString() !== eventId
    )
      throw new Error();
    return { ...parsed, version: 1, eventId };
  } catch {
    throw new TypeError('Invalid event cursor');
  }
}
