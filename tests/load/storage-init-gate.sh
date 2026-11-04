#!/bin/sh
# Only the owned readiness scenario sets this flag. Never mount in production.
if [ "${SIGNALTRAIL_STORAGE_INIT_GATE:-0}" = '1' ]; then
  touch /tmp/signaltrail-init-active
  attempt=0
  while [ ! -f /tmp/signaltrail-init-release ]; do
    if [ "$attempt" -ge 120 ]; then
      echo 'SignalTrail test initialization gate timed out' >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
fi
