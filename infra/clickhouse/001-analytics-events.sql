-- Apply with a migration identity, not the processor's insert-only identity.
CREATE TABLE IF NOT EXISTS signaltrail.analytics_events
(
    project_id String,
    event_id String,
    received_at DateTime64(3, 'UTC'),
    -- Preserve valid ISO client times even outside ClickHouse's DateTime64 range.
    client_timestamp String,
    event_name LowCardinality(String),
    distinct_id String,
    session_id String,
    sequence UInt64,
    url String,
    properties_json String,
    context_json String
)
ENGINE = ReplacingMergeTree(received_at)
-- No time partition: retries across receive dates must share a dedupe key.
ORDER BY (project_id, event_id);
-- Reads requiring unique events must use FINAL; background merging is eventual.
-- Event retention and production partitioning require a separate policy decision.
