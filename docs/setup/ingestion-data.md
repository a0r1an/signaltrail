# Ingestion project keys

The ingestion entrypoint uses stored project keys when `NODE_ENV=production`.
It checks access to the key table before connecting the publisher or opening HTTP
listeners. Startup fails closed if configuration or metadata access is missing.

Configure these server-only environment variables:

- `SIGNALTRAIL_INGESTION_DATABASE_URL`: PostgreSQL URL containing database and
  credentials. Query parameters and fragments are rejected.
- `SIGNALTRAIL_INGESTION_DATABASE_TLS`: `true` by default; disabling TLS is allowed
  only for explicit loopback development fixtures.
- `SIGNALTRAIL_INGESTION_DATABASE_CA`: optional PEM CA for verified TLS. Do not
  disable certificate verification to work around certificate errors.

Provision a separate read-only database identity with database connection, schema
usage on `signaltrail_control`, and SELECT on `ingestion_keys`. Ingestion does not
need membership-table writes, key creation, or migration privileges. The isolated
local probe verifies a role with SELECT on only `project_id`, `key_hash`, and
`revoked_at`, plus denial after those privileges are removed. Production roles
are not provisioned.

Apply the full tracked migration set (001 and 002) through a separate operator
identity before startup. See `packages/project-access/README.md` for the migration
foundation. The deployment migration and initial organization/project/key
provisioning workflow remains pending; do not run fixture SQL against live data.
The access package now provides `createInitialProjectStatement` for atomic
creation of explicit new owner/organization/project/key rows through a trusted
operator connection. It rejects conflicts rather than adopting existing rows;
see the package README. Live Clerk identity selection and execution against a
chosen database still require operator configuration.

Generate the complete tracked SQL plan with:

```sh
./scripts/signaltrail-ops.mjs metadata plan
```

This builds the access package and writes a unique ignored directory under
`test-results/migrations/` containing `plan.sql` and `manifest.json`. The manifest
records exact migration source hashes, the statement hash and `applied: false`.
Review the SQL and target database before applying it through a separate migration
identity. The command accepts no database URL, reads no credentials, contacts no
database and never marks a plan as applied. Preserve the reviewed manifest with
deployment evidence; generating a plan does not verify the target schema.
Unregistered `.sql` files in `infra/postgres` fail planning until the explicit
migration list is updated. Keep already applied sources immutable.

Generate browser credentials with `createIngestionKey`; store only
`hashIngestionKey(key)` as the SHA-256 key hash with a project UUID. These are
public write credentials, never private analytics read credentials. Each request
performs a fresh bounded lookup. Revocation affects the next lookup; it cannot
undo publication already authorized or acknowledged. Unknown/revoked keys return
401; metadata lookup failure returns 503 without publication. SDK retries retain
the original event IDs.

The database adapter defaults to four connections, sixteen outstanding queries,
and a five-second query deadline. These limits are provisional, not measured
production capacity. A metadata outage stops new authenticated ingestion even
when Redpanda is healthy.

Development/test mode retains explicit `SIGNALTRAIL_DEV_PROJECTS` fixture mappings.
Production rejects nonempty configuration of that variable, including `[]`.
No migration, key provisioning, or membership creation happens automatically.

Key rotation grace is still an open release decision. Existing browser queues
remain scoped to their original key; never silently move them to a replacement.
