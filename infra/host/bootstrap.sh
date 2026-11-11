#!/bin/sh
# Prepare a fresh Ubuntu 24.04 host (x86-64 or ARM64) and start SignalTrail.
# Idempotent: re-running on an existing host keeps data, secrets and the mount.
#
#   sudo SIGNALTRAIL_RELEASE=<tag> [SIGNALTRAIL_DATA_DEVICE=/dev/nvme1n1] infra/host/bootstrap.sh
# Optional: SIGNALTRAIL_INGESTION_PUBLISH / SIGNALTRAIL_CLICKHOUSE_PUBLISH (ip:port).
#
# SIGNALTRAIL_DATA_DEVICE: a dedicated data disk. Formatted ext4 only when it has no
# filesystem; an existing filesystem (rebuild onto a restored volume) is mounted as is.
# Without it, data stays on the root disk (trial/test hosts only).
set -eu
[ "$(id -u)" = 0 ] || { printf 'Run as root\n' >&2; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] || { printf 'Ubuntu is required\n' >&2; exit 1; }
: "${SIGNALTRAIL_RELEASE:?set SIGNALTRAIL_RELEASE}"
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
data=${SIGNALTRAIL_DATA:-/var/lib/signaltrail}
export SIGNALTRAIL_ETC=${SIGNALTRAIL_ETC:-/etc/signaltrail} SIGNALTRAIL_DATA=$data SIGNALTRAIL_RELEASE

# Packages: Docker from Docker's repository, time sync, probes.
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -yq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
apt-get install -yq chrony openssl fio sysstat unattended-upgrades
# Security updates install automatically; reboots stay manual (planned downtime).
printf 'Unattended-Upgrade::Automatic-Reboot "false";\n' > /etc/apt/apt.conf.d/52signaltrail-no-reboot
systemctl enable --now chrony

# Kernel settings: async I/O for Redpanda, minimal swapping.
cat > /etc/sysctl.d/90-signaltrail.conf <<'EOF'
fs.aio-max-nr = 1048576
vm.swappiness = 1
EOF
sysctl -q --system
# Containers keep running while the Docker daemon itself restarts or upgrades.
mkdir -p /etc/docker
[ -s /etc/docker/daemon.json ] || printf '{ "live-restore": true }\n' > /etc/docker/daemon.json
systemctl enable docker
systemctl restart docker

# Data disk.
mkdir -p "$data"
if [ -n "${SIGNALTRAIL_DATA_DEVICE:-}" ]; then
  [ -b "$SIGNALTRAIL_DATA_DEVICE" ] || { printf 'No block device %s\n' "$SIGNALTRAIL_DATA_DEVICE" >&2; exit 1; }
  if ! blkid "$SIGNALTRAIL_DATA_DEVICE" >/dev/null 2>&1; then
    mkfs.ext4 -q -L signaltrail-data "$SIGNALTRAIL_DATA_DEVICE"
  fi
  uuid=$(blkid -s UUID -o value "$SIGNALTRAIL_DATA_DEVICE")
  grep -q "UUID=$uuid" /etc/fstab ||
    printf 'UUID=%s %s ext4 defaults,noatime,nofail 0 2\n' "$uuid" "$data" >> /etc/fstab
  mountpoint -q "$data" || mount "$data"
fi
# Image users: postgres 999, ClickHouse and Redpanda 101.
for dir in postgres redpanda clickhouse backups; do mkdir -p "$data/$dir"; done
chown 999:999 "$data/postgres"
chown 101:101 "$data/redpanda" "$data/clickhouse" "$data/backups"

# Secrets (kept across runs) and release images (built here when not preloaded).
mkdir -p "$SIGNALTRAIL_ETC" && chmod 0700 "$SIGNALTRAIL_ETC"
sh "$here/secrets.sh"
for app in ingestion event-processor; do
  docker image inspect "signaltrail-$app:$SIGNALTRAIL_RELEASE" >/dev/null 2>&1 ||
    docker build -q -f "$here/Dockerfile" --build-arg "APP=$app" \
      -t "signaltrail-$app:$SIGNALTRAIL_RELEASE" "$repo"
done
# Release tag and optional publish addresses persist for every later compose command.
{
  printf 'SIGNALTRAIL_RELEASE=%s\n' "$SIGNALTRAIL_RELEASE"
  for name in SIGNALTRAIL_INGESTION_PUBLISH SIGNALTRAIL_CLICKHOUSE_PUBLISH; do
    eval "value=\${$name:-}"
    [ -z "$value" ] || printf '%s=%s\n' "$name" "$value"
  done
} > "$SIGNALTRAIL_ETC/host.env"

sh "$here/migrate.sh"

# Hourly backups (local; off-host when SIGNALTRAIL_BACKUP_S3 is set in host.env).
cat > /etc/systemd/system/signaltrail-backup.service <<EOF
[Unit]
Description=SignalTrail hourly backup
After=docker.service
[Service]
Type=oneshot
Environment=SIGNALTRAIL_ETC=$SIGNALTRAIL_ETC SIGNALTRAIL_DATA=$data
ExecStart=/bin/sh $here/backup.sh
EOF
cat > /etc/systemd/system/signaltrail-backup.timer <<'EOF'
[Unit]
Description=SignalTrail hourly backup
[Timer]
OnCalendar=hourly
RandomizedDelaySec=120
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now signaltrail-backup.timer
