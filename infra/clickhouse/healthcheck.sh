#!/bin/sh
set -eu
# The image's temporary bootstrap server binds only to loopback. Checking the
# container hostname waits for the final server listening on its network address.
exec clickhouse-client --host "$(hostname)" --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query 'SELECT 1'
