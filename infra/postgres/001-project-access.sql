-- Initial control-plane schema. Apply with a migration identity to an empty schema.
-- No session tokens, public ingestion keys, or credentials belong in these rows.
BEGIN;
CREATE SCHEMA signaltrail_control;
CREATE TABLE signaltrail_control.principals (
    id uuid PRIMARY KEY,
    issuer text NOT NULL CHECK (octet_length(issuer) BETWEEN 1 AND 1024 AND btrim(issuer) <> ''),
    subject text NOT NULL CHECK (octet_length(subject) BETWEEN 1 AND 1024 AND btrim(subject) <> ''),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (issuer, subject)
);
CREATE TABLE signaltrail_control.organizations (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200 AND btrim(name) <> ''),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE signaltrail_control.projects (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES signaltrail_control.organizations(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200 AND btrim(name) <> ''),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX projects_organization ON signaltrail_control.projects (organization_id);
CREATE TABLE signaltrail_control.organization_memberships (
    organization_id uuid NOT NULL REFERENCES signaltrail_control.organizations(id) ON DELETE CASCADE,
    principal_id uuid NOT NULL REFERENCES signaltrail_control.principals(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (organization_id, principal_id)
);
CREATE INDEX memberships_principal ON signaltrail_control.organization_memberships (principal_id);
COMMIT;
