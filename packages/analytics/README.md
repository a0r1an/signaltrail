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
Production session validation, membership persistence, credentials, host routing,
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
it never uses an offset. Cursors are unsigned positions, not authorization tokens.
Every page still requires project membership. Malformed and out-of-window
positions fail before storage. No cursor is returned on the final page.

This is not a database snapshot: concurrent arrivals and later retries can move
rows relative to a cursor or receive-time window. Do not promise complete,
unchanging multi-page exports. A snapshot/export policy remains separate work.

Summaries contain only event ID, name, session ID, exact decimal sequence, and
receive timestamp. They exclude URL, identity, properties, and context payloads.
The entire storage response is capped at 64 KiB, including the extra row. Each
identifier/name is capped at 4 KiB; an oversized or malformed response fails as
unconfirmed rather than returning partial data. These provisional read bounds
do not change event-ingestion validation.

Supply `listReceivedEvents: reader.listReceivedEvents` to the query handler to
enable `GET /v1/analytics/events` with the count route's parameters and an optional
`limit` and `cursor`. Count URLs remain capped at 4 KiB; list URLs permit 16 KiB
to accommodate an at-most-8-KiB cursor. Production proxy URL limits must be
aligned before exposing this route. Without that dependency the route returns 404. The same membership,
no-cache, admission, and cancellation policies apply to both operations.
