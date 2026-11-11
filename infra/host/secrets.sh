#!/bin/sh
# Generate host secrets and PostgreSQL TLS material once. Re-running keeps existing
# files, so passwords and certificates stay stable across reboots and rebuilds.
# Output: $SIGNALTRAIL_ETC/{postgres,clickhouse,ingestion,processor,dashboard}.env, tls/.
set -eu
umask 077
etc=${SIGNALTRAIL_ETC:-/etc/signaltrail}
mkdir -p "$etc/tls"
secret() { openssl rand -hex 24; }
write_once() { [ -s "$1" ] || cat > "$1"; }

write_once "$etc/postgres.env" <<EOF
POSTGRES_PASSWORD=$(secret)
EOF
write_once "$etc/clickhouse.env" <<EOF
CLICKHOUSE_PASSWORD=$(secret)
EOF
write_once "$etc/ingestion.env" <<EOF
NODE_ENV=production
SIGNALTRAIL_INGESTION_DATABASE_URL=postgres://signaltrail_ingestion:$(secret)@postgres:5432/signaltrail
SIGNALTRAIL_ALLOWED_ORIGINS=
EOF
write_once "$etc/processor.env" <<EOF
SIGNALTRAIL_CLICKHOUSE_USERNAME=signaltrail_processor
SIGNALTRAIL_CLICKHOUSE_PASSWORD=$(secret)
EOF
# Read-only dashboard identities, provisioned now and exposed only when the dashboard is.
write_once "$etc/dashboard.env" <<EOF
SIGNALTRAIL_CLICKHOUSE_READER=signaltrail_reader
SIGNALTRAIL_CLICKHOUSE_READER_PASSWORD=$(secret)
SIGNALTRAIL_POSTGRES_READER=signaltrail_dashboard
SIGNALTRAIL_POSTGRES_READER_PASSWORD=$(secret)
EOF

tls=$etc/tls
if [ ! -s "$tls/ca.crt" ]; then
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj '/CN=SignalTrail host CA' \
    -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
  openssl req -newkey rsa:3072 -nodes -subj '/CN=postgres' \
    -keyout "$tls/postgres.key" -out "$tls/postgres.csr" 2>/dev/null
  printf 'subjectAltName=DNS:postgres,DNS:localhost\nextendedKeyUsage=serverAuth\n' > "$tls/san.ext"
  openssl x509 -req -in "$tls/postgres.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" \
    -CAcreateserial -days 825 -extfile "$tls/san.ext" -out "$tls/postgres.crt" 2>/dev/null
  rm -f "$tls/postgres.csr" "$tls/san.ext"
fi
# Containers read these as their own users; the private keys stay owner-only.
chmod 0644 "$tls/ca.crt" "$tls/postgres.crt"
chmod 0600 "$tls/ca.key" "$tls/postgres.key"
printf 'Secrets ready in %s\n' "$etc"
