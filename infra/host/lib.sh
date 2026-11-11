# Shared by host scripts: `. "$here/lib.sh"` after setting here=<this directory>.
# host.env (written by bootstrap.sh) pins the release tag and optional publish ports;
# SIGNALTRAIL_COMPOSE_OVERLAY adds one extra compose file (local smoke test only).
etc=${SIGNALTRAIL_ETC:-/etc/signaltrail}
export SIGNALTRAIL_ETC=$etc
compose() {
  if [ -f "$etc/host.env" ]; then set -- --env-file "$etc/host.env" "$@"; fi
  docker compose -f "$here/compose.production.yaml" \
    ${SIGNALTRAIL_COMPOSE_OVERLAY:+-f "$SIGNALTRAIL_COMPOSE_OVERLAY"} "$@"
}
env_value() { sed -n "s/^$2=//p" "$etc/$1" 2>/dev/null; }
psql_q() { compose exec -T postgres psql -qAt -v ON_ERROR_STOP=1 -U signaltrail -d signaltrail -c "$1"; }
clickhouse_admin() {
  compose exec -T clickhouse sh -c \
    'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --multiquery'
}
