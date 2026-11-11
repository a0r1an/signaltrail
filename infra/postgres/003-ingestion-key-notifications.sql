-- Ingestion caches key lookups only while it LISTENs here. Any key change (create, revoke,
-- delete, including project cascades) notifies the key's SHA-256 hex on commit; TRUNCATE
-- notifies `all`. Payloads are hashes, never keys or project IDs.
BEGIN;
CREATE FUNCTION signaltrail_control.notify_ingestion_key_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        PERFORM pg_notify('signaltrail_ingestion_keys', 'all');
        RETURN NULL;
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        PERFORM pg_notify('signaltrail_ingestion_keys', encode(OLD.key_hash, 'hex'));
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        PERFORM pg_notify('signaltrail_ingestion_keys', encode(NEW.key_hash, 'hex'));
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER ingestion_keys_notify
    AFTER INSERT OR UPDATE OR DELETE ON signaltrail_control.ingestion_keys
    FOR EACH ROW EXECUTE FUNCTION signaltrail_control.notify_ingestion_key_change();
CREATE TRIGGER ingestion_keys_notify_truncate
    AFTER TRUNCATE ON signaltrail_control.ingestion_keys
    FOR EACH STATEMENT EXECUTE FUNCTION signaltrail_control.notify_ingestion_key_change();
COMMIT;
