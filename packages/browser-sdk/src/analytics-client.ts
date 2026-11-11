import {
  AnalyticsEventSchema,
  AnalyticsCaptureInputSchema,
  IDENTITY_LINK_EVENT_NAME,
  AnalyticsIdentitySchema,
} from '@signaltrail/contracts';
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
import { createEventId } from './event-id.ts';
import { SDK_VERSION } from './version.ts';

type Properties = ReturnType<typeof AnalyticsEventSchema.parse>['properties'];
const captureInput = AnalyticsCaptureInputSchema;
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
  identify(
    userId: string,
  ): Promise<
    | { status: 'identified'; changed: boolean }
    | { status: 'invalid_user' | 'identity_unavailable' | 'closed' }
  >;
  reset(): Promise<{ status: 'reset' | 'identity_unavailable' | 'closed' }>;
  flush: AutomaticDelivery['flush'];
  getHealth: AutomaticDelivery['getHealth'];
  readonly deliveryState: AutomaticDelivery['deliveryState'];
  close(): void;
}
/** Durable capture and project-scoped identity. Local identification is not a server acknowledgement. */
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
    delivery = await openAutomaticDelivery(normalized, {
      ...deliveryOptions,
      onEventAccepted(event) {
        if (event.identityLink) void identities.acknowledgeLink(event.eventId).catch(() => {});
        return deliveryOptions.onEventAccepted?.(event);
      },
    });
  } catch {
    identities.close();
    throw new Error('Analytics client initialization failed');
  }
  let closed = false;
  let pumping = false;
  let pumpTimer: ReturnType<typeof setTimeout> | undefined;
  async function pumpLinks() {
    if (closed || pumping) return;
    pumping = true;
    try {
      const links = await identities.pendingLinks();
      // One per turn keeps an unavailable upload from blocking all identity work.
      if (!closed && links[0]) await delivery.enqueue(links[0]);
    } catch {
      /* Keep the durable outbox for a later attempt. */
    } finally {
      pumping = false;
      if (!closed)
        pumpTimer = setTimeout(() => {
          void pumpLinks();
        }, 2000);
    }
  }
  void pumpLinks();
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
        if (eventName === IDENTITY_LINK_EVENT_NAME) return { status: 'invalid_event' };
        input = captureInput.parse({ eventName, properties });
        page = capturePage(getUrl());
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
        eventId = createEventId(identity.capturedAt);
        const event = AnalyticsEventSchema.parse({
          schemaVersion: 1,
          eventId,
          ...input,
          distinctId: identity.identifiedId ?? identity.anonymousId,
          sessionId: identity.sessionId,
          sequence: identity.sequence,
          clientTimestamp: new Date(identity.capturedAt).toISOString(),
          url: page.url,
          context: {
            sdkVersion: SDK_VERSION,
            ...(identity.identifiedId === undefined
              ? {}
              : {
                  identity: {
                    kind: 'identified',
                    anonymousId: identity.anonymousId,
                    userId: identity.identifiedId,
                  },
                }),
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
    async identify(userId) {
      if (closed) return { status: 'closed' };
      if (!AnalyticsIdentitySchema.shape.userId.safeParse(userId).success)
        return { status: 'invalid_user' };
      try {
        const result = await identities.identify(userId, capturePage(getUrl()));
        clearTimeout(pumpTimer);
        void pumpLinks();
        return { status: 'identified', changed: result.changed };
      } catch {
        return { status: closed ? 'closed' : 'identity_unavailable' };
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
      clearTimeout(pumpTimer);
      delivery.close();
      identities.close();
    },
  };
}
