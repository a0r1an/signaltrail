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
need membership-table writes, key creation, or migration privileges. The current
local probe uses an isolated fixture identity; production roles are not provisioned.

Apply the full tracked migration set (001 and 002) through a separate operator
identity before startup. See `packages/project-access/README.md` for the migration
foundation. The deployment migration and initial organization/project/key
provisioning workflow remains pending; do not run fixture SQL against live data.

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
