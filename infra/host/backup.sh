#!/bin/sh
# Hourly backup (systemd timer from bootstrap.sh). ClickHouse: a full backup when the
# newest full is older than a day, otherwise an incremental on it. PostgreSQL: pg_dump.
# Written to the data disk under backups/; kept 48 h locally. When
# SIGNALTRAIL_BACKUP_S3=s3://bucket/prefix is set in host.env, the directory is
# synced there with the instance role (off-host copy; needs the user's S3 approval).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
data=${SIGNALTRAIL_DATA:-/var/lib/signaltrail}
root="$data/backups"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$root/clickhouse" "$root/postgres"
chown 101:101 "$root" "$root/clickhouse"

latest_full=$(ls -1 "$root/clickhouse" 2>/dev/null | grep '^full-' | sort | tail -1 || true)
age=86400
if [ -n "$latest_full" ]; then
  age=$(( $(date +%s) - $(date -d "$(echo "${latest_full#full-}" | sed 's/\(....\)\(..\)\(..\)T\(..\)\(..\)\(..\)Z/\1-\2-\3 \4:\5:\6Z/')" +%s) ))
fi
if [ "$age" -ge 86400 ]; then
  name="full-$stamp"
  settings=''
else
  name="incr-$stamp"
  settings=" SETTINGS base_backup = File('/backups/clickhouse/$latest_full')"
fi
printf "BACKUP DATABASE signaltrail TO File('/backups/clickhouse/%s')%s;\n" "$name" "$settings" |
  clickhouse_admin >/dev/null
compose exec -T postgres pg_dump -U signaltrail -d signaltrail -Fc > "$root/postgres/$stamp.dump.tmp"
mv "$root/postgres/$stamp.dump.tmp" "$root/postgres/$stamp.dump"

# Local retention: 48 h, never deleting the full that newer incrementals depend on.
find "$root/postgres" -name '*.dump' -mmin +2880 -delete
keep_full=$(ls -1 "$root/clickhouse" | grep '^full-' | sort | tail -1)
for old in $(find "$root/clickhouse" -mindepth 1 -maxdepth 1 -mmin +2880 -printf '%f\n'); do
  [ "$old" = "$keep_full" ] || rm -rf "${root:?}/clickhouse/$old"
done

target=$(env_value host.env SIGNALTRAIL_BACKUP_S3)
if [ -n "$target" ]; then
  region=$(env_value host.env SIGNALTRAIL_BACKUP_S3_REGION)
  PATH=$PATH:/snap/bin aws s3 sync --only-show-errors ${region:+--region "$region"} "$root" "$target"
fi
printf '{"at":"%s","clickhouse":"%s","postgres":"%s.dump","bytes":%s,"s3":%s}\n' \
  "$stamp" "$name" "$stamp" "$(du -sb "$root" | cut -f1)" "$([ -n "$target" ] && echo true || echo false)"
