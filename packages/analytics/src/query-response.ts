import type {
  AnalyticsCountResponse,
  AnalyticsEventPage,
  AnalyticsEventSummary,
  AnalyticsOccurredEventPage,
} from './api-types.ts';

const encoder = new TextEncoder();
export function validIdentifier(value: unknown, maximum = 4096): value is string {
  if (typeof value !== 'string' || !/\S/.test(value) || value.length > maximum) return false;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return encoder.encode(value).byteLength <= maximum;
}
export function utcMilliseconds(value: unknown): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
    ? time
    : NaN;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function uint64(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d{0,19})$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}
export function isCountResponse(value: unknown): value is AnalyticsCountResponse {
  return object(value) && Object.keys(value).length === 1 && uint64(value.count);
}
function summary(value: unknown, occurred = false): value is AnalyticsEventSummary {
  return (
    object(value) &&
    Object.keys(value).length === (occurred ? 6 : 5) &&
    validIdentifier(value.eventId) &&
    validIdentifier(value.eventName) &&
    validIdentifier(value.sessionId) &&
    uint64(value.sequence) &&
    Number.isFinite(utcMilliseconds(value.receivedAt)) &&
    (!occurred || Number.isFinite(utcMilliseconds(value.occurredAt)))
  );
}
export function isEventPage(
  value: unknown,
  maximum: number,
  occurred = false,
): value is AnalyticsEventPage {
  if (
    !object(value) ||
    !Array.isArray(value.events) ||
    value.events.length > maximum ||
    !value.events.every((event) => summary(event, occurred))
  )
    return false;
  if (new Set(value.events.map((event) => event.eventId)).size !== value.events.length)
    return false;
  if (value.hasMore === false) return Object.keys(value).length === 2;
  return (
    value.hasMore === true &&
    Object.keys(value).length === 3 &&
    value.events.length > 0 &&
    typeof value.nextCursor === 'string' &&
    value.nextCursor.length <= 8192 &&
    /^[A-Za-z0-9_-]+$/.test(value.nextCursor)
  );
}
export function isOccurredEventPage(
  value: unknown,
  maximum: number,
): value is AnalyticsOccurredEventPage {
  return isEventPage(value, maximum, true);
}
export async function queryJson(
  response: Response,
  signal: AbortSignal,
  maximum: number,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
    response.headers.get('cache-control') !== 'no-store'
  )
    throw new Error('Invalid response headers');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body');
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new Error('Response byte limit exceeded');
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
