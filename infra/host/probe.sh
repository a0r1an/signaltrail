#!/bin/sh
# Host probe: disk behaviour on the data volume and platform facts. One JSON object.
# fsync latency matters most: Redpanda acknowledges an event only after fsync.
#   sudo infra/host/probe.sh > probe.json      (about one minute; writes ~1 GB, then removes it)
set -eu
data=${SIGNALTRAIL_DATA:-/var/lib/signaltrail}
dir="$data/probe-$$"
mkdir -p "$dir"
trap 'rm -rf "$dir"' EXIT
job() { fio --directory="$dir" --output-format=json --runtime=20 --time_based --group_reporting "$@"; }

fsync=$(job --name=fsync --rw=write --bs=4k --size=64m --fdatasync=1)
randread=$(job --name=randread --rw=randread --bs=4k --size=256m --direct=1 --ioengine=libaio --iodepth=16)
seqwrite=$(job --name=seqwrite --rw=write --bs=1m --size=512m --direct=1 --ioengine=libaio --iodepth=4)

# EC2 instance metadata (IMDSv2) when present; empty elsewhere.
token=$(curl -fsS -m 1 -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)
meta() { [ -n "$token" ] && curl -fsS -m 1 -H "X-aws-ec2-metadata-token: $token" \
  "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true; }

printf '{"at":"%s","kernel":"%s","cpus":%s,"instanceType":"%s","availabilityZone":"%s","dataFilesystem":"%s","fio":{"fsync":%s,"randread":%s,"seqwrite":%s}}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(uname -srm)" "$(nproc)" "$(meta instance-type)" \
  "$(meta placement/availability-zone)" "$(df -T "$data" | awk 'NR == 2 { print $2 }')" \
  "$fsync" "$randread" "$seqwrite"
