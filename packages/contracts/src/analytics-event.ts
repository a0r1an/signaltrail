import * as z from 'zod';

export const MAX_ANALYTICS_IDENTIFIER_BYTES = 4096;
export const MAX_CAMPAIGN_VALUE_BYTES = 1024;
export const CAMPAIGN_PARAMETERS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

// Count Unicode scalar values without Node APIs or replacement of lone surrogates.
function fitsIdentifierUtf8(value: string, maximum = MAX_ANALYTICS_IDENTIFIER_BYTES): boolean {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > maximum) return false;
  }
  return true;
}

const identifier = z
  .string()
  .min(1)
  .max(MAX_ANALYTICS_IDENTIFIER_BYTES)
  .regex(/\S/)
  .refine((value) => fitsIdentifierUtf8(value), {
    error: 'Expected valid UTF-8 within the analytics identifier byte limit',
  });

export const IDENTITY_LINK_EVENT_NAME = '$identify';
export const AnalyticsIdentitySchema = z.strictObject({
  kind: z.enum(['identified', 'link']),
  anonymousId: identifier,
  userId: identifier,
});

const campaignValue = z
  .string()
  .min(1)
  .max(MAX_CAMPAIGN_VALUE_BYTES)
  .refine(
    (value) =>
      fitsIdentifierUtf8(value, MAX_CAMPAIGN_VALUE_BYTES) &&
      Array.from(value).every((character) => {
        const point = character.codePointAt(0)!;
        return point >= 32 && point !== 127;
      }),
    { error: 'Expected bounded campaign text' },
  );

const analyticsEvent = z.object({
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
    campaign: z.partialRecord(z.enum(CAMPAIGN_PARAMETERS), campaignValue).optional(),
    identity: AnalyticsIdentitySchema.optional(),
  }),
});

export const AnalyticsCaptureInputSchema = analyticsEvent.pick({
  eventName: true,
  properties: true,
});
export const AnalyticsEventSchema = analyticsEvent.superRefine((event, context) => {
  const identity = event.context.identity;
  if (identity && identity.userId !== event.distinctId)
    context.addIssue({
      code: 'custom',
      message: 'Identity does not match event',
      path: ['distinctId'],
    });
  if ((event.eventName === IDENTITY_LINK_EVENT_NAME) !== (identity?.kind === 'link'))
    context.addIssue({
      code: 'custom',
      message: 'Invalid identity link event',
      path: ['eventName'],
    });
});
