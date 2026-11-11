#!/bin/sh
# Bootstrap a disposable Lima Ubuntu VM with a separate data disk, verify, re-run,
# reboot, verify again, then delete the VM and disk. Evidence in test-results/host.
#   vm-test.sh          full test, VM deleted afterwards
#   vm-test.sh vm-up    bootstrap and verify, leave the VM running for remote runs
#   vm-test.sh vm-down  delete the VM and its disk
set -eu
mode=${1:-test}
root=$(cd "$(dirname "$0")/../.." && pwd)
name=signaltrail-host-test
disk=signaltrail-host-data
out="$root/test-results/host/$(date -u +%Y-%m-%dT%H-%M-%SZ)-vm-test"
mkdir -p "$out"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$out/steps.log"; }
cleanup() {
  limactl delete -f "$name" >/dev/null 2>&1 || true
  limactl disk delete -f "$disk" >/dev/null 2>&1 || true
}
if [ "$mode" = vm-down ]; then cleanup; printf 'Deleted %s\n' "$name"; exit 0; fi
[ "$mode" = vm-up ] || trap cleanup EXIT
cleanup
in_vm() { limactl shell --workdir / "$name" "$@"; }

log 'create VM and data disk'
limactl disk create "$disk" --size 10GiB --format raw >/dev/null
limactl create --tty=false --name "$name" \
  --set ".mounts=[{\"location\":\"$root\",\"writable\":false}]" \
  --set ".additionalDisks=[{\"name\":\"$disk\",\"format\":false}]" \
  "$root/tests/host/lima-ubuntu.yaml" >/dev/null
limactl start "$name" >/dev/null
device=$(in_vm sh -c "lsblk -dpn -o NAME,SIZE | awk '\$2 == \"10G\" { print \$1 }'")
[ -n "$device" ] || { log 'data disk not found'; exit 1; }
log "data disk $device"

bootstrap() {
  in_vm sudo SIGNALTRAIL_RELEASE=vmtest SIGNALTRAIL_DATA_DEVICE="$device" \
    SIGNALTRAIL_INGESTION_PUBLISH=127.0.0.1:34100 SIGNALTRAIL_CLICKHOUSE_PUBLISH=127.0.0.1:38223 \
    sh "$root/infra/host/bootstrap.sh" >> "$out/bootstrap.log" 2>&1
}
verify() { in_vm sudo sh "$root/infra/host/verify.sh" 2>&1 | tee -a "$out/verify.log" | tail -1; }
events() {
  in_vm sudo sh -c "cd $root/infra/host && \
    docker compose --env-file /etc/signaltrail/host.env -f compose.production.yaml exec -T clickhouse \
    sh -c 'clickhouse-client --user \"\$CLICKHOUSE_USER\" --password \"\$CLICKHOUSE_PASSWORD\" --query \"SELECT count() FROM signaltrail.analytics_events\"'"
}

start=$(date +%s)
log 'bootstrap (fresh host)'
bootstrap
log "bootstrap took $(( $(date +%s) - start )) s"
log "verify: $(verify)"
if [ "$mode" = vm-up ]; then
  log "VM $name is up: SIGNALTRAIL_HOST_TARGET=lima:$name"
  exit 0
fi
log 'bootstrap again (idempotent)'
bootstrap
log "verify: $(verify)"
before=$(events)
in_vm sh -c "mount | grep -q ' /var/lib/signaltrail ' && df -h /var/lib/signaltrail | tail -1" | tee -a "$out/steps.log"
log "events stored before reboot: $before"

log 'reboot'
limactl stop "$name" >/dev/null
limactl start "$name" >/dev/null
in_vm sh -c "mount | grep -q ' /var/lib/signaltrail '" || { log 'data disk not mounted after reboot'; exit 1; }
log "verify after reboot: $(verify)"
after=$(events)
log "events stored after reboot: $after"
[ "$after" -gt "$before" ] || { log 'events missing after reboot'; exit 1; }
log 'PASS'
