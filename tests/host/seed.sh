#!/bin/sh
# Load-run fixture on a host: a probe owner/project/key and ROWS historical events
# spread over 90 days (time-ordered IDs, 100 events per visitor, 5% identity links).
# Prints PROJECT=<uuid> and KEY=<public key>; the key is the only copy.
#   sudo ROWS=9000000 tests/host/seed.sh
set -eu
here=$(cd "$(dirname "$0")/../../infra/host" && pwd)
. "$here/lib.sh"
rows=${ROWS:-0}
case "$rows" in '' | *[!0-9]*) printf 'ROWS must be a whole number\n' >&2; exit 1 ;; esac

key="st_pub_$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
hash=$(printf '%s' "$key" | sha256sum | cut -d' ' -f1)
uuid() { cat /proc/sys/kernel/random/uuid; }
principal=$(uuid) organization=$(uuid) project=$(uuid) key_id=$(uuid)
psql_q "INSERT INTO signaltrail_control.principals(id,issuer,subject) VALUES ('$principal','https://load.invalid','$principal');
  INSERT INTO signaltrail_control.organizations(id,name) VALUES ('$organization','Load run');
  INSERT INTO signaltrail_control.projects(id,organization_id,name) VALUES ('$project','$organization','Load run');
  INSERT INTO signaltrail_control.organization_memberships(organization_id,principal_id,role) VALUES ('$organization','$principal','owner');
  INSERT INTO signaltrail_control.ingestion_keys(id,project_id,name,key_hash) VALUES ('$key_id','$project','Load run',decode('$hash','hex'))" >/dev/null

# Interval spreads ROWS evenly across 90 days, newest first.
offset=0
while [ "$offset" -lt "$rows" ]; do
  chunk=$(( rows - offset < 1000000 ? rows - offset : 1000000 ))
  clickhouse_admin <<SQL
INSERT INTO signaltrail.analytics_events
SELECT '$project',
  concat(substring(h, 1, 8), '-', substring(h, 9, 4), '-7', substring(r, 1, 3), '-8', substring(r, 4, 3), '-', substring(r, 7, 12)),
  received, concat(replaceOne(toString(received), ' ', 'T'), 'Z'), 'history_seed',
  if(number % 20 = 0, concat('user-', toString(intDiv(number, 100))), concat('visitor-', toString(intDiv(number, 100)))),
  concat('session-', toString(intDiv(number, 20))), number, 'https://load.invalid', '{}',
  if(number % 20 = 0, concat('{"identity":{"kind":"link","anonymousId":"visitor-', toString(intDiv(number, 100)), '","userId":"user-', toString(intDiv(number, 100)), '"}}'), '{}')
FROM (
  SELECT number, received,
    leftPad(lower(hex(toUnixTimestamp64Milli(received))), 12, '0') AS h,
    leftPad(lower(hex(sipHash64(number))), 18, '0') AS r
  FROM (SELECT number, now64(3) - toIntervalMillisecond(intDiv(number * 7776000000, $rows)) AS received
        FROM numbers($offset, $chunk))
);
SQL
  offset=$(( offset + chunk ))
done
printf 'PROJECT=%s\nKEY=%s\n' "$project" "$key"
