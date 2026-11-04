# Server-side project membership

`@signaltrail/project-access` connects a verified session identity to a project
membership lookup. It does not authenticate cookies, verify JWTs, create users,
or expose a listener. It has no runtime dependencies or default authentication.

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
retaining slots for dependencies that ignore cancellation. A driver and production
connection/role configuration are deliberately not chosen by this package.

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
resolver, and a fixture-only psql prepared-statement bridge. It verifies tenant
and issuer isolation, removal, role constraints, and query-handler integration.
It does not validate a production session provider or production SQL adapter.

`authorized-analytics` includes those checks plus real ClickHouse counts and
cursor-paged summaries for two projects sharing event/session IDs. It verifies
that denied and revoked membership causes no storage read. CI uses this combined
probe; the smaller PostgreSQL-only probe remains available for focused checks.
