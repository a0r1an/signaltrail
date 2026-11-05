# Server-side analytics reads

`@signaltrail/analytics` provides a bounded ClickHouse read foundation. It is a
private server package, not a browser SDK API or a deployed query service.

A caller must authenticate the dashboard user and authorize project membership
before supplying `projectId`. Public ingestion keys must never authorize reads.
Production ClickHouse read credentials still need a restricted database identity;
the integration probe uses only the owned local fixture identity.

```ts
const reader = createAnalyticsReader(serverReadConfiguration);
const { count } = await reader.countReceivedEvents({
  projectId: authorizedProjectId,
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-02T00:00:00.000Z',
});
```

The window is UTC and half-open (`from <= received_at < to`), with a maximum span
of 31 days. Counts use `FINAL` and the latest replacement row's receive timestamp.
A later retry can move an event between receive-time windows. This is not a
client-event-time analytics definition; settle product semantics before exposing
dashboard totals. Counts remain decimal strings to preserve UInt64 precision.

The reader uses a fixed parameterized query over configured identifiers. Project
IDs bind as exact UTF-8 bytes, avoiding ClickHouse HTTP escaped-string ambiguity.
Inputs cannot supply SQL. Configuration rejects URL credentials, query fragments,
unsafe identifiers, and invalid credentials/timeouts. GET is already read-only;
explicitly changing ClickHouse's `readonly` setting in a GET is rejected.

Defaults: five-second client deadline, server execution budget below that deadline
(with a one-second minimum), 64 MiB query-memory setting, two query threads, and
4 KiB maximum response buffering. Errors, malformed/partial results, and response
exception headers produce a generic failure without raw SQL, values, or credentials.
The client deadline also covers a stalled response body. Query bounds and settings
are provisional and must be tested with production read-user constraints and
representative data volumes before deployment.

Verification:

```sh
./scripts/signaltrail-ops.mjs check analytics
./scripts/signaltrail-ops.mjs load analytics-read
```

The isolated probe verifies separate projects, exact backslash/newline project
IDs, time boundaries, and latest-version dedupe before time filtering. It does
not implement production membership authentication or dashboard views.

## Query integration boundary

`createAnalyticsQueryHandler` accepts a standard `Request` and returns a
`Response` for `GET /v1/analytics/count?projectId=...&from=...&to=...`.
It opens no listener and registers no application route by itself. Supply a
server-owned `resolveProjectAccess(request, requestedProjectId, signal)` that
authenticates a dashboard session and checks project membership. It must return
`authorized` with the canonical project ID, `unauthenticated`, or `forbidden`.
No default resolver exists. Never use the public ingestion-key resolver here.
Supply the configured reader's `countReceivedEvents` as the storage operation.

Responses disable caching and add no cross-origin access headers. Authentication
and membership failures return 401/403 before reads. Invalid request shapes or
authorized windows return 400; dependency failures, deadlines, and full admission
return generic 503 responses. Unknown paths and unsupported methods return
404/405. Duplicate/unknown parameters are rejected, and URLs are capped at 4 KiB.

The provisional defaults admit 32 requests per handler and bound each response
wait to ten seconds. A timed-out or disconnected request aborts the resolver's
signal; late authorization cannot begin a storage read. Admission stays reserved
until the underlying work settles, including dependencies that ignore abort.
The handler passes cancellation to the storage operation as its second argument.
The supplied reader aborts fetch/body work on cancellation and retains its own
independent deadline, including for custom fetch implementations that ignore abort.
Custom storage wrappers must forward the signal. Deploy one shared handler instance per service,
not one per request. These are instance limits, not proxy or distributed quotas.

The isolated probe uses a fixture-only membership resolver to verify denied
requests never reach storage and an authorized request returns a real count.
A PostgreSQL membership resolver and bounded driver are available in
`@signaltrail/project-access`. Production session validation, metadata provisioning, credentials, host routing,
CSRF/origin policy for the chosen session scheme, and query metrics remain pending.

## Event explorer summaries

`reader.listReceivedEvents({ projectId, from, to, limit? }, signal?)` uses the
same authorized project, UTC window, `FINAL` uniqueness, deadlines, and query
resource settings as counts. It returns newest-first summaries ordered by
receive timestamp and event ID, with a default of 50 and a maximum of 100 rows.
One extra row determines `hasMore`; there is no unbounded offset or arbitrary SQL.
When more rows exist, `nextCursor` contains an opaque, bounded position for the
next request. Pass it as `cursor` with the same project and time window.
Paging uses `(received_at, event_id)` comparisons, including timestamp ties;
it never uses an offset. Cursors include a version and fingerprint of the
canonical project, UTC window, event-name filter, and session filter. Changing or
removing those values rejects the cursor before storage; equivalent timestamp
formatting and different page sizes remain valid. Inputs are snapshotted before
awaiting storage. Cursors are unsigned positions, not authorization tokens or
secrets: the fingerprint prevents accidental reuse, not deliberate tampering.
Every page still requires membership. Malformed/out-of-window positions fail
before storage. Final pages omit the cursor. New cursors use version-two wire encoding with independently base64url-encoded
identifier bytes, keeping even control-character 4-KiB IDs inside the 8-KiB cap.
Bounded version-one cursors remain accepted; unversioned cursors are rejected.
The query-scope fingerprint is unchanged across wire versions.

This is not a database snapshot: concurrent arrivals and later retries can move
rows relative to a cursor or receive-time window. Do not promise complete,
unchanging multi-page exports. A snapshot/export policy remains separate work.

Summaries contain only event ID, name, session ID, exact decimal sequence, and
receive timestamp. They exclude URL, identity, properties, and context payloads.
The storage response is capped at 160 KiB per attempt, including the lookahead
row. This fits two complete worst-case JSON-escaped rows at the 4-KiB per-field
bound. New events use the same valid-UTF-8/per-field bounds in contracts.

If a complete query response exceeds the byte budget, the reader halves the page
limit and runs a new complete query. It returns up to the requested event count;
use `hasMore` and `nextCursor`, not page length, to determine completion. At most
seven attempts are possible from a 100-event request. Every attempt shares one
overall reader deadline and caller cancellation signal. Partial/truncated response
bytes are discarded, never promoted to a successful page. Detected malformed
responses, storage errors, and cancellation do not trigger page reduction.

A one-event page that still exceeds the byte budget fails privately. Historical
invalid identifiers also fail validation; existing storage is not rewritten.
The additional queries are a bounded fallback for large identifiers, not a
throughput optimization or production capacity guarantee.

Supply `listReceivedEvents: reader.listReceivedEvents` to the query handler to
enable `GET /v1/analytics/events` with the count route's parameters and an optional
`limit` and `cursor`. Count URLs remain capped at 4 KiB; list URLs permit 16 KiB
to accommodate an at-most-8-KiB cursor. Production proxy URL limits must be
aligned before exposing this route. Without that dependency the route returns 404. The same membership,
no-cache, admission, and cancellation policies apply to both operations.

Both reader operations and query routes accept an optional `eventName` filter.
It is an exact match, including case, whitespace, and literal backslashes. Names
must contain a non-whitespace character, have valid UTF-8 representation, and
fit 4 KiB. The filter binds bytes as a parameter and applies to the latest
replacement row. An older version with a different name is not resurrected.

They also accept an optional `sessionId` with the same exact UTF-8 and 4 KiB
validation. It can be combined with `eventName` and cursor paging; filters are
ANDed and must be kept unchanged between pages. Session IDs are scoped to the
authorized project, not globally unique identities. Replacement selection occurs
before session filtering as well. Session-filtered results retain receive-time
ordering; this is not a client sequence-ordered session timeline.

## Node HTTP bridge

`createAnalyticsHttpServer({ origin, query, maxConnections?, shutdownTimeoutMs? })`
returns an unbound Node `server` and idempotent async `close()`. Supply the same
required authorization/storage callbacks as the query handler in `query`, then
listen on an explicitly chosen interface. The configured HTTP(S) origin must have
no credentials, path, query, or fragment. Requests use that fixed origin and Host
for session verification; client Host and forwarding headers do not select the
Request URL. Identity resolvers must not independently trust forwarding headers.
No listener, session provider, TLS termination, CORS policy, or deployment is
configured automatically.

The bridge rejects duplicate Authorization headers, non-origin-form request
URLs, and request bodies before authorization. Normal GET request completion does
not cancel an in-progress read; disconnects and shutdown do. The connection cap
is 128 by default (1–1024), distinct from the handler's 32-operation admission.
Headers are limited to 32 KiB with a ten-second header deadline, a fifteen-second
request deadline, and five-second keep-alive timeout. These are provisional
Node HTTP limits, not a proxy configuration or whole-process memory guarantee.

Shutdown stops admission, aborts active handler signals, closes idle connections,
and forcibly closes remaining HTTP connections after one second by default
(configurable 100–10,000 ms). It does not close caller-owned database pools or
wait indefinitely for dependencies ignoring cancellation. Close those separately.
The unit suite opens ephemeral loopback listeners for wire, disconnect, and slow
header shutdown checks. `load authorized-analytics` additionally verifies real
HTTP authorization, counts, and summary reads against owned PostgreSQL and
ClickHouse fixtures. Production session verification remains pending.

The implemented route reference is in
[`docs/api/analytics.openapi.json`](../../docs/api/analytics.openapi.json).
It is validated offline by this package's test suite. Its documented bearer
binding is fixture-only; production session transport and server URLs must be
configured before mounting a service. See the API reference README for limits.

Browser-facing API models are available with
`import type { AnalyticsEventPage } from '@signaltrail/analytics/api-types'`.
That subpath exports types only, generated from the reference. It has no runtime
client or authentication defaults. Builds verify a DOM-only consumer without
Node ambient types; normal lint verifies generated-type drift.

## Bounded browser query client

```ts
import { createQueryClient } from '@signaltrail/analytics/client';

const client = createQueryClient({
  endpoint: 'https://dashboard.invalid/api/',
  fetch: sessionAwareFetch, // Required; your application owns session transport.
});
const { count } = await client.countReceivedEvents({
  projectId: authorizedProjectId,
  from: '2026-11-01T00:00:00Z',
  to: '2026-11-02T00:00:00Z',
});
```

The separate client entry contains no Node APIs or runtime dependencies. A
DOM-only build checks its source and public declarations. No global fetch,
ingestion key, cookie policy, or bearer credential is supplied by default. Your
injected fetch owns the verified session transport and must honor the request's
signal, no-cache, and no-redirect settings. Endpoint credentials, query strings,
and fragments are rejected. An optional endpoint path prefix is preserved.

`listReceivedEvents` returns the generated discriminated page type. Follow
`hasMore`/`nextCursor` even when a page is smaller than the requested limit. Runtime
validation preserves exact UInt64 strings, valid UTF-8 identifiers, UTC timestamps,
unique summary IDs, and cursor shape, and rejects extra private fields. Responses
must be JSON with `Cache-Control: no-store`. Count buffering is capped at 4 KiB;
list buffering at 192 KiB, allowing the reader's 160-KiB storage page plus its
cursor and serialization overhead. Invalid headers/bodies and redirected responses
are discarded with generic errors; raw response or network-error details are not
attached as causes.

Defaults admit four underlying requests per client instance (configurable 1–32)
and wait up to twelve seconds across fetch and body reads (configurable 1–30,000
ms). A timeout or caller abort cancels the signal but keeps capacity reserved until
an abort-ignoring fetch actually settles. `snapshot()` reports only admission
counts, capacity, and closed state. `close()` stops admission and cancels active
requests; it does not await dependencies that ignore cancellation.

There are no automatic retries. `AnalyticsQueryClientError` provides a sanitized
`code`, optional HTTP `status`, and a `retryable` hint. HTTP 401/403 let the owning
application handle sign-in or denied membership; 429/5xx, network, timeout, and
capacity errors can be retried by the caller. Abort/closed/invalid-response errors
are not marked retryable. Production authentication and a dashboard route remain
pending; the fixture's session-aware fetch is not a deployment fallback.
