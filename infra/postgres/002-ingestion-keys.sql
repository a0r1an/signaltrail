-- Public browser ingestion keys are stored as hashes, separately from dashboard membership.
BEGIN;
CREATE TABLE signaltrail_control.ingestion_keys (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES signaltrail_control.projects(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200 AND btrim(name) <> ''),
    key_hash bytea NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at timestamptz
);
CREATE INDEX ingestion_keys_project ON signaltrail_control.ingestion_keys (project_id);
COMMIT;
