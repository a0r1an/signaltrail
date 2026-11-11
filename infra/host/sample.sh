#!/bin/sh
# Host sampler: one JSON line every SAMPLE_SECONDS (default 5) with CPU counters
# (including steal), available memory, disk counters and per-container usage.
#   sudo infra/host/sample.sh > samples.jsonl   (stop with SIGTERM)
set -eu
interval=${SAMPLE_SECONDS:-5}
while :; do
  cpu=$(sed -n 's/^cpu  *//p' /proc/stat)
  mem=$(sed -n 's/^MemAvailable: *\([0-9]*\) kB/\1/p' /proc/meminfo)
  disks=$(awk '$3 ~ /^(nvme[0-9]+n[0-9]+|vd[a-z]+|xvd[a-z]+|sd[a-z]+)$/ { printf "%s{\"name\":\"%s\",\"reads\":%s,\"readMs\":%s,\"writes\":%s,\"writeMs\":%s,\"ioMs\":%s}", sep, $3, $4, $7, $8, $11, $13; sep="," }' /proc/diskstats)
  containers=$(docker stats --no-stream --format '{"name":"{{.Name}}","cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}"}' 2>/dev/null | paste -sd, -)
  printf '{"at":"%s","cpu":"%s","memAvailableKiB":%s,"disks":[%s],"containers":[%s]}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$cpu" "${mem:-0}" "$disks" "$containers"
  sleep "$interval"
done
