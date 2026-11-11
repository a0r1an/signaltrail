-- Apply with the migration identity after 001. Every statement is idempotent.
-- Event time is parsed once at insert; out-of-range client strings stay NULL.
-- Min/max indexes let time-window reads skip granules, which works because
-- time-ordered (UUIDv7) event IDs keep each project's rows clustered by time.
ALTER TABLE signaltrail.analytics_events
    ADD COLUMN IF NOT EXISTS occurred_at Nullable(DateTime64(3, 'UTC'))
        MATERIALIZED if(match(client_timestamp, '^(19[0-9]{2}|2[0-2][0-9]{2})-'), parseDateTime64BestEffortOrNull(client_timestamp, 3, 'UTC'), NULL),
    ADD INDEX IF NOT EXISTS received_at_minmax received_at TYPE minmax GRANULARITY 1,
    ADD INDEX IF NOT EXISTS occurred_at_minmax occurred_at TYPE minmax GRANULARITY 1;

-- Identity links, kept apart so visitor counts need not scan all event history.
-- Same dedupe key and version as events: replays and replacements match FINAL reads.
CREATE TABLE IF NOT EXISTS signaltrail.analytics_identity_links
(
    project_id String,
    event_id String,
    received_at DateTime64(3, 'UTC'),
    anonymous_id String,
    user_id String
)
ENGINE = ReplacingMergeTree(received_at)
ORDER BY (project_id, event_id);

-- The definer, not the insert-only processor, needs SELECT on the events table.
CREATE MATERIALIZED VIEW IF NOT EXISTS signaltrail.analytics_identity_links_mv
TO signaltrail.analytics_identity_links
DEFINER = CURRENT_USER SQL SECURITY DEFINER
AS SELECT
    project_id,
    event_id,
    received_at,
    JSONExtractString(context_json, 'identity', 'anonymousId') AS anonymous_id,
    JSONExtractString(context_json, 'identity', 'userId') AS user_id
FROM signaltrail.analytics_events
WHERE JSONExtractString(context_json, 'identity', 'kind') IN ('identified', 'link')
    AND anonymous_id != '' AND user_id != '' AND user_id = distinct_id;

-- Backfill links stored before the view existed; rows already present are skipped.
INSERT INTO signaltrail.analytics_identity_links
SELECT
    project_id,
    event_id,
    received_at,
    JSONExtractString(context_json, 'identity', 'anonymousId') AS anonymous_id,
    JSONExtractString(context_json, 'identity', 'userId') AS user_id
FROM signaltrail.analytics_events
WHERE JSONExtractString(context_json, 'identity', 'kind') IN ('identified', 'link')
    AND anonymous_id != '' AND user_id != '' AND user_id = distinct_id
    AND (project_id, event_id, received_at) NOT IN (
        SELECT project_id, event_id, received_at FROM signaltrail.analytics_identity_links
    );
