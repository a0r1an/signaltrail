# SignalTrail browser SDK

This private pre-release package currently exposes persistent queue, transport,
automatic delivery, health reporting, and page-context capture primitives.
The higher-level anonymous visitor/session and `track`/`identify`/`reset` API is
not implemented yet. Existing low-level enqueue methods accept complete typed
analytics events and do not automatically sanitize caller-supplied URLs/properties.

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

An internal, not-yet-public IndexedDB store implements anonymous visitor identity,
30-minute inactivity sessions, shared atomic sequence allocation and cross-tab
reset visibility on the next operation. Unit and native Chromium tests cover it.
It does not yet drive event capture or implement identified-user linking.
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
