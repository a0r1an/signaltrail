# Dashboard analytics connection

The Next.js resource `/api/analytics/[...path]` binds server-owned Clerk owner
verification to organization membership and bounded ClickHouse reads. It accepts
no identity header, public ingestion key or browser-supplied principal as access.
Every request rechecks the owner session and PostgreSQL membership. Service
connections are reused within a warm process; authorization grants are not cached.

Configure the ignored `apps/dashboard/.env.local` from `.env.example` locally.
Do not paste keys, passwords or connection URLs into chat or commit them.

## Local Compose setup

Once the development Clerk owner configuration is complete:

```sh
./scripts/signaltrail-ops.mjs metadata status
./scripts/signaltrail-ops.mjs metadata migrate-local
./scripts/signaltrail-ops.mjs metadata configure-local
```

`status` uses read-only transactions and reports registered migration checksums
and schema presence without reading identities or keys. `migrate-local` applies
the complete tracked migration set only to the repository's Compose PostgreSQL.
Neither accepts an arbitrary database target.

`configure-local` requires development Clerk keys and `http://localhost:3000`.
It uses the configured owner issuer/ID to create a personal organization and
SignalTrail project with an owner membership. It creates separate restricted
PostgreSQL/ClickHouse readers with generated local passwords, verifies membership
and analytics reads, then replaces only service fields in `.env.local`. It keeps
a private backup and preserves Clerk settings. PostgreSQL key access and write
privileges are checked as denied. No test events or destructive writes are used.

Stable IDs/credentials/public browser key are retained in ignored
`.local-data/dashboard-local-setup.json` (0600). Do not delete that state to retry:
the command reuses it and refuses an owner identity mismatch or conflicting rows.
Never commit or serve the state/environment/backups. Fresh generated role names
avoid adopting a shared existing role. The CLI prints booleans only.
The local admin credentials come from committed Compose fixture configuration;
these commands are not a production provisioning mechanism. Restart the dashboard
if its running process has not picked up the changed environment.

- `SIGNALTRAIL_CLICKHOUSE_READ_URL`, `SIGNALTRAIL_CLICKHOUSE_READ_USER`, and
  `SIGNALTRAIL_CLICKHOUSE_READ_PASSWORD` select a restricted ClickHouse read user.
- `SIGNALTRAIL_MEMBERSHIP_DATABASE_URL` selects a restricted PostgreSQL identity
  with SELECT access to the control-plane principal/project/membership tables.
- TLS and certificate verification are required for remote services. Explicit
  `SIGNALTRAIL_MEMBERSHIP_TLS=false` is accepted only on loopback for local
  development. `SIGNALTRAIL_MEMBERSHIP_CA` can supply a trusted private PEM CA.
- Restart the process after changing service configuration. Missing or rejected
  configuration returns 503/no-store and never enables a fixture fallback.

A separate trusted operator must apply the tracked control-plane migration and
provision an organization, project, principal and owner membership. The principal
must exactly match the Clerk instance issuer and `user_...` owner ID. Never store
session tokens or passwords in metadata. The dashboard read identity cannot
bootstrap or grant its own membership. The initial migration helper and isolated
verification are documented in `packages/project-access/README.md`; a production
migration/bootstrap CLI and restricted role provisioning remain outstanding.

All members can read their organization's projects. Owner restriction additionally
limits this initial app to the configured Clerk account. Knowing a project's UUID
or public ingestion key grants no access. Missing membership returns 403 before
ClickHouse. Database/auth failures return generic 503 responses without connection
details. These endpoints are server routes, not a published standalone service.

The protected `/dashboard` page mounts the occurrence-time explorer after a
project is selected from the server-rendered membership list. Pages are bounded
and use principal-bound cursors. Selecting a project preserves its project-page
position. Selection does not authorize analytics reads; each API request still
checks membership. No projects or memberships are automatically created.
The browser client uses `endpoint: location.origin`, `pathPrefix: 'api/analytics/'`
and an explicit same-origin fetch adapter. It passes no service credentials to
the browser. Both occurrence and received timestamps are displayed; the default
window covers the previous 24 hours. Principal/session changes remount private
client state using a server-derived scope hash.

Verification:

```sh
./scripts/signaltrail-ops.mjs check dashboard
./scripts/signaltrail-ops.mjs dashboard auth-smoke
./scripts/signaltrail-ops.mjs load authorized-analytics
```

The production HTTP smoke blanks auth/service configuration and proves denial,
not real Clerk login. The database fixture exercises this dashboard handler with
an injected verified principal, real PostgreSQL and real ClickHouse, including
cross-organization denial and revocation. It is not a production session proof.

Before live use, finish Clerk invite-only/owner setup, provision restricted roles
and owner metadata, verify real sign-in/sign-out and authorized/denied reads, then
validate the connected explorer with real data. Vercel warm-process pool defaults are provisional (four
connections, sixteen in-flight membership queries); connection budgets across
concurrent function instances require deployment validation.
