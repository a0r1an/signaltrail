import { AnalyticsEventSchema } from '@signaltrail/contracts';
import {
  openAutomaticDelivery,
  type AutomaticDeliveryOptions,
  type EnqueueOptions,
  type AutomaticDelivery,
} from './automatic-delivery.ts';
import type { EventQueueConfig, EnqueueResult } from './event-queue.ts';
import { normalizeQueueConfig } from './project-config.ts';
import { createPageContextCapture, type PageContext } from './capture-url.ts';
import { openIdentityStore } from './identity-store.ts';
import { SDK_VERSION } from './version.ts';

type Properties = ReturnType<typeof AnalyticsEventSchema.parse>['properties'];
const captureInput = AnalyticsEventSchema.pick({ eventName: true, properties: true });
export interface AnalyticsClientOptions extends AutomaticDeliveryOptions {
  getUrl?: () => string;
  allowedQueryParameters?: readonly string[];
}
export type CaptureResult =
  | (EnqueueResult & { eventId: string })
  | { status: 'invalid_event' | 'identity_unavailable' | 'delivery_error' | 'closed' };
export interface AnalyticsClient {
  track(
    eventName: string,
    properties?: Properties,
    options?: EnqueueOptions,
  ): Promise<CaptureResult>;
  reset(): Promise<{ status: 'reset' | 'identity_unavailable' | 'closed' }>;
  flush: AutomaticDelivery['flush'];
  getHealth: AutomaticDelivery['getHealth'];
  readonly deliveryState: AutomaticDelivery['deliveryState'];
  close(): void;
}
/** Anonymous capture only; identified-user linking is a separate forthcoming API. */
export async function openAnalyticsClient(
  config: EventQueueConfig,
  options: AnalyticsClientOptions = {},
): Promise<AnalyticsClient> {
  const normalized = normalizeQueueConfig(config);
  const {
    getUrl = () => globalThis.location.href,
    allowedQueryParameters,
    ...deliveryOptions
  } = options;
  const capturePage = createPageContextCapture(allowedQueryParameters);
  const captureClock = deliveryOptions.queue?.now;
  const identities = await openIdentityStore(
    normalized,
    captureClock === undefined ? {} : { now: captureClock },
  );
  let delivery: AutomaticDelivery;
  try {
    delivery = await openAutomaticDelivery(normalized, deliveryOptions);
  } catch {
    identities.close();
    throw new Error('Analytics client initialization failed');
  }
  let closed = false;
  return {
    async track(eventName, properties = {}, capture = {}) {
      if (closed) return { status: 'closed' };
      let input: ReturnType<typeof captureInput.parse>,
        page: PageContext,
        eventId: string,
        urgent: boolean | undefined;
      try {
        if (
          !capture ||
          (capture.sendImmediately !== undefined && typeof capture.sendImmediately !== 'boolean')
        )
          return { status: 'invalid_event' };
        urgent = capture.sendImmediately;
        input = captureInput.parse({ eventName, properties });
        page = capturePage(getUrl());
        eventId = crypto.randomUUID();
      } catch {
        return { status: 'invalid_event' };
      }
      let identity;
      try {
        identity = await identities.allocate();
      } catch {
        return { status: closed ? 'closed' : 'identity_unavailable' };
      }
      if (closed) return { status: 'closed' };
      try {
        const event = AnalyticsEventSchema.parse({
          schemaVersion: 1,
          eventId,
          ...input,
          distinctId: identity.anonymousId,
          sessionId: identity.sessionId,
          sequence: identity.sequence,
          clientTimestamp: new Date(identity.capturedAt).toISOString(),
          url: page.url,
          context: {
            sdkVersion: SDK_VERSION,
            ...(Object.keys(page.campaign).length ? { campaign: page.campaign } : {}),
          },
        });
        const result = await delivery.enqueue(
          event,
          urgent === undefined ? {} : { sendImmediately: urgent },
        );
        return { ...result, eventId };
      } catch {
        return { status: closed ? 'closed' : 'delivery_error' };
      }
    },
    async reset() {
      if (closed) return { status: 'closed' };
      try {
        await identities.reset();
        return { status: 'reset' };
      } catch {
        return { status: closed ? 'closed' : 'identity_unavailable' };
      }
    },
    flush: delivery.flush,
    getHealth: delivery.getHealth,
    get deliveryState() {
      return delivery.deliveryState;
    },
    close() {
      if (closed) return;
      closed = true;
      delivery.close();
      identities.close();
    },
  };
}
