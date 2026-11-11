#!/bin/sh
# Restore ClickHouse and PostgreSQL from local backups (sync them from S3 first on a
# replacement host). Replaces existing data, so it requires the backup name twice:
#   sudo SIGNALTRAIL_RESTORE_CONFIRM=incr-20261111T200000Z infra/host/restore.sh incr-20261111T200000Z
# Uses the newest PostgreSQL dump no newer than the ClickHouse backup.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
data=${SIGNALTRAIL_DATA:-/var/lib/signaltrail}
name=${1:?backup name, e.g. incr-20261111T200000Z}
[ "${SIGNALTRAIL_RESTORE_CONFIRM:-}" = "$name" ] ||
  { printf 'Set SIGNALTRAIL_RESTORE_CONFIRM=%s to replace current data\n' "$name" >&2; exit 1; }
[ -d "$data/backups/clickhouse/$name" ] || { printf 'No backup %s\n' "$name" >&2; exit 1; }
stamp=${name#*-}
dump=$(ls -1 "$data/backups/postgres" | sed -n 's/\.dump$//p' | sort |
  awk -v limit="$stamp" '$0 <= limit' | tail -1)
[ -n "$dump" ] || { printf 'No PostgreSQL dump at or before %s\n' "$stamp" >&2; exit 1; }

started=$(date +%s)
# Nothing writes while data is replaced; the browser SDK queues events meanwhile.
compose stop ingestion processor >/dev/null
compose up -d --wait postgres clickhouse redpanda >/dev/null
clickhouse_admin <<EOF
DROP DATABASE IF EXISTS signaltrail SYNC;
RESTORE DATABASE signaltrail FROM File('/backups/clickhouse/$name');
EOF
compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U signaltrail -d signaltrail \
  -c 'DROP SCHEMA IF EXISTS signaltrail_control CASCADE; DROP SCHEMA IF EXISTS signaltrail_migrations CASCADE;'
compose exec -T postgres pg_restore -U signaltrail -d signaltrail --exit-on-error \
  < "$data/backups/postgres/$dump.dump"
# Identities, grants and the rest of the stack.
sh "$here/migrate.sh" >/dev/null
printf '{"restored":"%s","postgres":"%s.dump","seconds":%s}\n' "$name" "$dump" "$(( $(date +%s) - started ))"
