#!/bin/sh
# Start data services, apply the release's migrations (embedded in the ingestion
# image), provision restricted identities, then start everything. Idempotent.
# Run from any directory: infra/host/migrate.sh (release from host.env or the environment)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
from_image() { compose run --rm --no-deps -T --entrypoint sh ingestion -c "$1"; }

compose up -d --wait postgres clickhouse redpanda
compose run --rm redpanda-init

# ClickHouse 001.. in order; every statement is idempotent.
from_image 'cat /app/migrations/clickhouse/*.sql' |
  clickhouse_admin
# PostgreSQL tracked control-plane plan (checksums, advisory lock).
from_image 'cat /app/migrations/postgres-plan.sql' |
  compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U signaltrail -d signaltrail

# Identities. Passwords are hex (secrets.sh) and travel only on stdin.
ingestion_password=$(sed -n 's#^SIGNALTRAIL_INGESTION_DATABASE_URL=postgres://signaltrail_ingestion:\([0-9a-f]*\)@.*#\1#p' "$etc/ingestion.env")
processor_password=$(sed -n 's/^SIGNALTRAIL_CLICKHOUSE_PASSWORD=//p' "$etc/processor.env")
reader_password=$(sed -n 's/^SIGNALTRAIL_CLICKHOUSE_READER_PASSWORD=//p' "$etc/dashboard.env")
dashboard_password=$(sed -n 's/^SIGNALTRAIL_POSTGRES_READER_PASSWORD=//p' "$etc/dashboard.env")
for value in "$ingestion_password" "$processor_password" "$reader_password" "$dashboard_password"; do
  case "$value" in '' | *[!0-9a-f]*) printf 'Invalid generated secret\n' >&2; exit 1 ;; esac
done

clickhouse_admin <<EOF
CREATE USER IF NOT EXISTS signaltrail_processor IDENTIFIED WITH sha256_password BY '$processor_password';
ALTER USER signaltrail_processor IDENTIFIED WITH sha256_password BY '$processor_password';
GRANT INSERT ON signaltrail.analytics_events TO signaltrail_processor;
CREATE USER IF NOT EXISTS signaltrail_reader IDENTIFIED WITH sha256_password BY '$reader_password';
ALTER USER signaltrail_reader IDENTIFIED WITH sha256_password BY '$reader_password';
GRANT SELECT ON signaltrail.analytics_events, SELECT ON signaltrail.analytics_identity_links TO signaltrail_reader;
EOF

compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U signaltrail -d signaltrail <<EOF
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'signaltrail_ingestion') THEN
    CREATE ROLE signaltrail_ingestion LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'signaltrail_dashboard') THEN
    CREATE ROLE signaltrail_dashboard LOGIN NOINHERIT;
  END IF;
END \$\$;
ALTER ROLE signaltrail_ingestion PASSWORD '$ingestion_password';
ALTER ROLE signaltrail_ingestion SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE signaltrail TO signaltrail_ingestion;
GRANT USAGE ON SCHEMA signaltrail_control TO signaltrail_ingestion;
GRANT SELECT(project_id, key_hash, revoked_at) ON signaltrail_control.ingestion_keys TO signaltrail_ingestion;
ALTER ROLE signaltrail_dashboard PASSWORD '$dashboard_password';
ALTER ROLE signaltrail_dashboard SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE signaltrail TO signaltrail_dashboard;
GRANT USAGE ON SCHEMA signaltrail_control TO signaltrail_dashboard;
GRANT SELECT ON signaltrail_control.principals, signaltrail_control.organization_memberships,
  signaltrail_control.organizations, signaltrail_control.projects TO signaltrail_dashboard;
EOF

compose up -d --wait
printf 'SignalTrail is running\n'
