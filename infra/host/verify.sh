#!/bin/sh
# End-to-end check on a running host: a probe project and key, one event through
# ingestion into ClickHouse, restricted identities and TLS. Removes its probe rows.
#   sudo infra/host/verify.sh            # after bootstrap.sh, a reboot or an upgrade
set -eu
here=$(cd "$(dirname "$0")" && pwd)
etc=${SIGNALTRAIL_ETC:-/etc/signaltrail}
export SIGNALTRAIL_ETC=$etc
# shellcheck disable=SC1091
. "$etc/release.env"
export SIGNALTRAIL_RELEASE
compose() {
  docker compose -f "$here/compose.production.yaml" \
    ${SIGNALTRAIL_COMPOSE_OVERLAY:+-f "$SIGNALTRAIL_COMPOSE_OVERLAY"} "$@"
}
psql_q() { compose exec -T postgres psql -qAt -v ON_ERROR_STOP=1 -U signaltrail -d signaltrail -c "$1"; }
value() { sed -n "s/^$2=//p" "$etc/$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
ch() { compose exec -T clickhouse clickhouse-client --user "$1" --password "$2" --query "$3"; }

compose up -d --wait >/dev/null 2>&1 || fail 'stack did not become healthy'
url=http://127.0.0.1:4100
curl -fsS "$url/health" >/dev/null || fail 'ingestion /health'

key="st_pub_$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
hash=$(printf '%s' "$key" | sha256sum | cut -d' ' -f1)
uuid() { cat /proc/sys/kernel/random/uuid; }
principal=$(uuid) organization=$(uuid) project=$(uuid) key_id=$(uuid) event=$(uuid)
cleanup() {
  psql_q "DELETE FROM signaltrail_control.organizations WHERE id = '$organization';
    DELETE FROM signaltrail_control.principals WHERE id = '$principal'" >/dev/null 2>&1 || true
}
trap cleanup EXIT
psql_q "INSERT INTO signaltrail_control.principals(id,issuer,subject) VALUES ('$principal','https://verify.invalid','$principal');
  INSERT INTO signaltrail_control.organizations(id,name) VALUES ('$organization','Host verify');
  INSERT INTO signaltrail_control.projects(id,organization_id,name) VALUES ('$project','$organization','Host verify');
  INSERT INTO signaltrail_control.organization_memberships(organization_id,principal_id,role) VALUES ('$organization','$principal','owner');
  INSERT INTO signaltrail_control.ingestion_keys(id,project_id,name,key_hash) VALUES ('$key_id','$project','Host verify',decode('$hash','hex'))" >/dev/null

body=$(printf '{"events":[{"schemaVersion":1,"eventId":"%s","eventName":"host_verify","distinctId":"verify","sessionId":"verify","sequence":0,"clientTimestamp":"%s","url":"https://verify.invalid/","properties":{},"context":{"sdkVersion":"host-verify"}}]}' \
  "$event" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)")
response=$(curl -fsS -X POST "$url/v1/events" -H "authorization: Bearer $key" \
  -H 'content-type: application/json' --data "$body") || fail 'ingestion request'
printf '%s' "$response" | grep -q '"status":"accepted"' || fail "event not accepted: $response"

reader=$(value dashboard.env SIGNALTRAIL_CLICKHOUSE_READER)
reader_password=$(value dashboard.env SIGNALTRAIL_CLICKHOUSE_READER_PASSWORD)
stored=0
for _ in $(seq 1 60); do
  stored=$(ch "$reader" "$reader_password" \
    "SELECT count() FROM signaltrail.analytics_events FINAL WHERE project_id = '$project' AND event_id = '$event'")
  [ "$stored" = 1 ] && break
  sleep 0.5
done
[ "$stored" = 1 ] || fail 'accepted event not stored within 30 s'

processor_password=$(value processor.env SIGNALTRAIL_CLICKHOUSE_PASSWORD)
if ch signaltrail_processor "$processor_password" 'SELECT 1 FROM signaltrail.analytics_events LIMIT 1' >/dev/null 2>&1; then
  fail 'processor can read events'
fi
tls=$(psql_q "SELECT count(*) FILTER (WHERE ssl) || '/' || count(*) FROM pg_stat_ssl JOIN pg_stat_activity USING (pid) WHERE usename = 'signaltrail_ingestion'")
case "$tls" in 0/* | */0) fail "no TLS ingestion connections: $tls" ;; esac
[ "${tls%/*}" = "${tls#*/}" ] || fail "non-TLS ingestion connections: $tls"

printf 'OK release=%s event stored, restricted users, ingestion TLS %s\n' "$SIGNALTRAIL_RELEASE" "$tls"
