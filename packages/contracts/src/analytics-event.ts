import * as z from 'zod';

export const MAX_ANALYTICS_IDENTIFIER_BYTES = 4096;

// Count Unicode scalar values without Node APIs or replacement of lone surrogates.
function fitsIdentifierUtf8(value: string): boolean {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MAX_ANALYTICS_IDENTIFIER_BYTES) return false;
  }
  return true;
}

const identifier = z
  .string()
  .min(1)
  .max(MAX_ANALYTICS_IDENTIFIER_BYTES)
  .regex(/\S/)
  .refine(fitsIdentifierUtf8, {
    error: 'Expected valid UTF-8 within the analytics identifier byte limit',
  });

export const AnalyticsEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: identifier,
  eventName: identifier,
  properties: z.record(z.string(), z.json()),
  distinctId: z.string().min(1).regex(/\S/),
  sessionId: identifier,
  clientTimestamp: z.iso.datetime(),
  sequence: z.number().nonnegative().int(),
  url: z.url(),
  context: z.object({
    sdkVersion: z.string().min(1).regex(/\S/),
  }),
});
