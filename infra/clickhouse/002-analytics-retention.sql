-- Apply with a migration identity after 001. Idempotent.
-- Default 90-day raw-event retention by server receipt time, not client clocks.
-- Row TTL keeps the unpartitioned dedupe key intact; expired rows are removed by
-- background merges. To change the period, re-run with a different interval.
ALTER TABLE signaltrail.analytics_events
    MODIFY TTL toDateTime(received_at) + INTERVAL 90 DAY DELETE;
