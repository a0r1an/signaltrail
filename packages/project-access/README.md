# Server-side project membership

`@signaltrail/project-access` connects a verified session identity to a project
membership lookup. It does not authenticate cookies, verify JWTs, create users,
or expose a listener. Its PostgreSQL adapter uses node-postgres; it supplies no default authentication.

```ts
const resolveProjectAccess = createProjectAccessResolver({
  resolveIdentity: verifiedDashboardSession,
  query: parameterizedDatabaseAdapter,
});
// Pass resolveProjectAccess to createAnalyticsQueryHandler.
```

`resolveIdentity(request, signal)` must return a server-verified `{ issuer,
subject }` or `null`. Never derive it from request-supplied identity fields or a
public ingestion key. Issuer and subject are opaque, case-sensitive UTF-8 values
bounded at 1 KiB each. Equal subjects from different issuers are distinct people.

The fixed PostgreSQL query uses `$1/$2/$3` values and returns only the requested
canonical UUID project. No membership means `forbidden`; missing authentication
means `unauthenticated`. Database/provider failures, unexpected results, and
cancellation fail with a generic error for the query boundary to map to 503.
Membership grants are not cached, so removal affects the next lookup.

The injected database adapter receives `{ text, values, signal }`. It must bind
values through the database driver, enforce a statement deadline, and implement
cancellation. The query handler provides response deadlines/admission, including
retaining slots for dependencies that ignore cancellation. The provided node-postgres adapter implements this contract; production
credentials, CA trust, and database role provisioning remain unconfigured.

The provisional policy permits owner, admin, and member roles to read every
project in their organization. Project-specific roles, invitations, last-owner
protection, administrative mutations, audit records, and account linking need
separate product policy and implementation before deployment.

`infra/postgres/001-project-access.sql` creates an initial schema with principals,
organizations, projects, and memberships. UUIDs are assigned by trusted callers;
issuer/subject pairs and memberships are unique. This migration is transactional
and intended for an empty schema. It is not automatically applied to development
or production data.
It stores no credentials, ingestion keys, or session tokens.

`createInitialMigrationStatement(repositorySql)` adds atomic application tracking
for version 1 in `signaltrail_migrations.applied`. Execute the resulting statement
as one operation through a separate migration identity. It uses a transaction
advisory lock, five-second lock timeout, and ten-second statement timeout.
Concurrent/identical replays are safe; changed source checksums, unsupported newer
versions, and pre-existing untracked schemas are refused. Failed DDL rolls back
both the control-plane schema and its application record. Checksums track source
bytes, not manual database-schema drift. Keep applied SQL immutable; a future
version needs a new migration and explicit runner support.

This helper accepts repository-owned SQL only. It is not a SQL sanitizer or a
customer API. A deployment CLI, migration credential provisioning, and future
version orchestration remain separate work. The isolated probe verifies rollback,
concurrent replay, checksum mismatch, unknown versions, and untracked-schema refusal.

```sh
./scripts/signaltrail-ops.mjs check access
./scripts/signaltrail-ops.mjs load project-access
./scripts/signaltrail-ops.mjs load authorized-analytics
```

The isolated probe uses owned PostgreSQL data on port 35433, a fixture identity
resolver, the real node-postgres adapter, and psql only for migration/seeding. It verifies tenant
and issuer isolation, removal, role constraints, and query-handler integration.
It does not validate a production session provider or production SQL adapter.

`authorized-analytics` includes those checks plus real ClickHouse counts and
cursor-paged summaries for two projects sharing event/session IDs. It verifies
that denied and revoked membership causes no storage read. CI uses this combined
probe; the smaller PostgreSQL-only probe remains available for focused checks.

## Bounded PostgreSQL adapter

`createPostgresMembershipDatabase({ connectionString, tls?, ca?, maxConnections?,
maxInFlight?, timeoutMs?, onPoolError? })` returns `query`, `snapshot`, and `close`.
Pass `query` to the membership resolver and close the adapter during shutdown.
The connection URL must specify user, password, host, and database; URL query
options/fragments and port zero are rejected. This prevents ambient PG settings
from silently changing the configured destination or credentials. TLS verifies
certificates by default; the local fixture explicitly disables TLS. `ca` supplies
optional CA trust without disabling verification. Do not print connection URLs.

Defaults are four connections, 16 admitted operations, a five-second total wait,
30-second idle eviction, and server statement/lock timeouts just below the total
wait. Acquisition and execution count toward admission. Cancellation discards a
checked-out connection; a cancelled pool waiter retains its slot until acquisition
settles and any late connection is discarded. Parameters are copied before waiting.
Errors use generic messages without SQL, credentials, or identity values. Pool
error diagnostics receive no private error object and cannot alter query outcomes.

The driver uses one extended-protocol statement with bound values. Internal query
text is capped at 16 KiB, with up to 16 string parameters of 4 KiB each. This is
for bounded, server-owned membership queries, not customer SQL or an arbitrary
result-size guarantee. A read-only session default blocks ordinary writes; it
does not replace a restricted production database identity. Migration/admin work
uses a separate executor and identity.

`close` stops admission, aborts work, waits for acquisition/execution to settle,
and ends the pool. The shutdown wait is bounded at the query timeout plus one
second; failure is reported rather than silently called successful. Process
supervision must handle an unconfirmed shutdown. The real fixture checks pool
saturation, queued and active cancellation, parameter snapshots, statement timeout,
read-only defaults, backend termination/recovery, diagnostic isolation, and close
with active/queued operations. These checks are not a production pool-sizing test.

## Membership-scoped project pages

`createProjectListReader(query)` returns a server-only reader accepting an already
verified principal, `{ limit?, cursor? }` and a cancellation signal. It returns
project IDs/names only for owner/admin/member organization memberships. Default
page size is 50, maximum 100, ordered by UUID with keyset continuation. The opaque
cursor is bound to the principal's issuer and subject; it is not authority. Every
page rechecks current membership. Inputs use bound SQL parameters and the same
bounded PostgreSQL adapter. Inconsistent, duplicate or unsorted storage rows fail
without returning partial project data. Project names retain valid Unicode up to
the schema's 200-character limit. No invitations or membership grants are created.

## Tracked upgrades and public ingestion keys

`createControlPlaneMigrationStatement([{ version, source }, ...])` applies a
contiguous repository-owned migration set under the existing transaction advisory
lock, five-second lock budget and ten-second statement budget. Known checksums
are verified, missing history and unsupported newer versions are refused, and
all changes in the supplied plan roll back on failure. The initial-only helper
remains available for version-one fixtures; use the complete tracked set after
upgrading. Applied source SQL must remain immutable.

`002-ingestion-keys.sql` adds project-bound key hashes and revocation timestamps.
`createIngestionKey` generates a canonical public SDK credential;
`hashIngestionKey` yields its SHA-256 hash. `createStoredProjectResolver(query)`
looks up only the hash, rejects malformed keys before storage, rechecks revocation
without a cache, and returns only a canonical project UUID. Use the bounded
read-only PostgreSQL adapter and a restricted ingestion identity. Database errors
fail closed; no development project mapping is substituted.

Browser keys are exposed to the client and cannot prove an end user's identity
or grant private analytics reads. Revocation affects the next lookup, not a batch
already authorized/publishing. Rotation needs a deliberate overlap policy for
old SDK queues; no rotate-key administration endpoint exists. Production entrypoint
binding, operator migration/bootstrap tooling and real role provisioning remain
separate work. The disposable PostgreSQL probe verifies upgrades, rollback,
concurrent replay, lookup, revocation, uniqueness and project deletion.
