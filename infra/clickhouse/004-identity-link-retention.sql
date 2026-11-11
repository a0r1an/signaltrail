-- Links expire with the events they came from, matching 002's 90-day retention.
ALTER TABLE signaltrail.analytics_identity_links
    MODIFY TTL toDateTime(received_at) + INTERVAL 90 DAY DELETE;
