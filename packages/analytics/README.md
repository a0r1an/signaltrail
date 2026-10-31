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
not implement membership authentication, query HTTP routing, or dashboard views.
