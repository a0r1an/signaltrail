#!/bin/sh
set -eu

brokers=${REDPANDA_BROKERS:-redpanda:9092}
topic=${SIGNALTRAIL_REDPANDA_TOPIC:-signaltrail.analytics.v1}
partitions=${SIGNALTRAIL_TOPIC_PARTITIONS:-3}
replicas=${SIGNALTRAIL_TOPIC_REPLICAS:-1}
retention_ms=${SIGNALTRAIL_TOPIC_RETENTION_MS:-604800000}
retention_bytes=${SIGNALTRAIL_TOPIC_RETENTION_BYTES:--1}

case "$topic" in ''|*[!A-Za-z0-9._-]*|'.'|'..') printf 'Invalid topic name\n' >&2; exit 1 ;; esac
[ "${#topic}" -le 249 ] || { printf 'Topic name too long\n' >&2; exit 1; }

topics=$(rpk topic list --format text -X "brokers=$brokers")
if ! printf '%s\n' "$topics" | awk -v topic="$topic" '$1 == topic { found = 1 } END { exit !found }'; then
  if ! rpk topic create "$topic" --partitions "$partitions" --replicas "$replicas" \
    --topic-config cleanup.policy=delete \
    --topic-config "retention.ms=$retention_ms" \
    --topic-config "retention.bytes=$retention_bytes" \
    --topic-config write.caching=false -X "brokers=$brokers"; then
    # Another initializer may have won the creation race. Success still requires
    # the complete postcondition below; other creation failures remain visible.
    printf 'Topic creation failed; verifying whether an identical topic now exists\n' >&2
  fi
fi

# Parse only exact field names from the text format of the pinned rpk version.
# Its summary and scalar configuration values occupy the first two columns.
description=$(rpk topic describe "$topic" --print-summary --print-configs --print-all --format text -X "brokers=$brokers")
expect_field() {
  if ! actual=$(printf '%s\n' "$description" | awk -v field="$1" '$1 == field && NF >= 2 { count++; value = $2 } END { if (count != 1) exit 1; print value }'); then
    printf 'Cannot verify %s for %s; existing topic settings were not altered\n' "$1" "$topic" >&2
    exit 1
  fi
  if [ "$actual" != "$2" ]; then
    printf 'Topic %s has %s=%s; expected %s. No existing settings were changed.\n' "$topic" "$1" "$actual" "$2" >&2
    exit 1
  fi
}
expect_field NAME "$topic"
expect_field PARTITIONS "$partitions"
expect_field REPLICAS "$replicas"
expect_field cleanup.policy delete
expect_field retention.ms "$retention_ms"
expect_field retention.bytes "$retention_bytes"
expect_field write.caching false
printf 'Verified topic %s\n' "$topic"
