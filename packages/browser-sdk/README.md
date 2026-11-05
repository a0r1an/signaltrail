# SignalTrail browser SDK

This private pre-release package currently exposes persistent queue, transport,
automatic delivery, health reporting, and page-context capture primitives.
The public anonymous `openAnalyticsClient` API supports `track`, `reset`, batching
and retries. `identify` and server-side linking remain unimplemented. Existing
low-level enqueue methods still accept complete typed events and do not
automatically sanitize caller-supplied URLs/properties.

## Anonymous event capture

```ts
import { openAnalyticsClient } from '@signaltrail/browser-sdk';

const analytics = await openAnalyticsClient({
  projectKey: 'your-public-ingestion-key',
  ingestionUrl: 'https://ingestion.example.com/v1/events',
});

const result = await analytics.track('product_viewed', { productId: '123' });
await analytics.track('checkout_started', {}, { sendImmediately: true });

// Await and check the result before capturing activity for a new browser user.
const reset = await analytics.reset();
analytics.close();
```

Initialization starts delivery of existing queued work, but does not record page
views automatically or start replay. The application controls when to initialize
and capture. Event properties and URL/campaign context are snapshotted before
asynchronous storage. The client generates stable event IDs, timestamps, anonymous
visitor IDs, shared sessions and sequences. Campaign changes do not rotate IDs.
Campaign context is stored separately in `context.campaign` using the shared
optional contract; application properties are not overwritten.

`queued` means local enqueue succeeded, not that the server accepted the event.
Even immediate sends use the queue and existing acknowledgement/retry rules.
Inspect structured drop/storage/validation outcomes; invalid inputs do not enter
the queue. Retries preserve the original payload and ID. `reset` rotates visitor
and session for future captures across same-origin/project connections, without
rewriting or deleting previously queued events. `close` stops this client only.

This pre-release high-level API currently requires identity IndexedDB: opening
fails if it is unavailable; later identity-write failures report
`identity_unavailable`. It does not silently claim a cross-tab reset succeeded.
The low-level delivery queue's existing memory fallback remains unchanged.
Identified-user linking and a coordinated identity fallback are future work.

## URL and campaign capture

```ts
import { createPageContextCapture } from '@signaltrail/browser-sdk';

const capturePage = createPageContextCapture();
const { url, campaign } = capturePage(window.location.href);
```

The helper removes URL credentials, query strings and fragments. It extracts only
`utm_source`, `utm_medium`, `utm_campaign`, `utm_term` and `utm_content` into the
separate campaign object. Each call describes that URL only: it does not overwrite
visitor attribution, change identity/session, enqueue events, or infer first/last
touch. Those behaviors belong to the upcoming capture and analytics layers.

Applications may explicitly retain additional query parameters in the sanitized
URL, for example `createPageContextCapture(['category'])`. Standard UTM fields
still remain separate. Configuration is snapshotted; mutations to the caller's
array do not widen capture. Allowed parameter values can still contain sensitive
data; choose the allowlist intentionally. Paths and app-supplied event properties
are not redacted by this helper. Hash-based routes are omitted under the default
fragment policy.

Provisional bounds: absolute HTTP(S) URLs only, at most 16 KiB of input, at most
32 additional parameter names of 128 UTF-8 bytes each, and at most 1 KiB per
captured value. Duplicate, empty, malformed-encoded and control-character values
are omitted rather than guessed or truncated. Invalid URLs throw a generic
`TypeError` without including raw input. No production workload limit is implied.

## Identity/session foundation

An internal IndexedDB store drives anonymous visitor identity,
30-minute inactivity sessions, shared atomic sequence allocation and cross-tab
reset visibility on the next operation. Unit and native Chromium tests cover it.
It drives public anonymous capture but does not implement identified-user linking.
Unavailable identity storage reports failure; existing queue memory fallback is
unchanged. See the project question log for capture integration decisions.

## Checks

```sh
./scripts/signaltrail-ops.mjs check sdk
./scripts/signaltrail-ops.mjs browser test
```

Run these from the repository root. Unit tests use fake IndexedDB; the separate
Chromium suite verifies native storage/delivery. See the project status for actual
verification and limitations. This package and shared contracts are MIT licensed;
other platform packages retain their own licenses.
