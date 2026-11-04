import { createHash } from 'node:crypto';

/** Repository-owned migration SQL only; never pass customer-provided statements. */
export function createInitialMigrationStatement(source: string): string {
  if (
    typeof source !== 'string' ||
    Buffer.byteLength(source) > 65536 ||
    source.includes('\0') ||
    Buffer.from(source).toString() !== source
  )
    throw new TypeError('Invalid initial migration source');
  const lines = source.trim().split('\n');
  while (lines[0]?.trimStart().startsWith('--')) lines.shift();
  const statement = lines.join('\n').trim();
  if (!statement.toUpperCase().startsWith('BEGIN;') || !statement.toUpperCase().endsWith('COMMIT;'))
    throw new TypeError('Invalid initial migration source');
  const body = statement.slice(6, -7).trim();
  if (!body) throw new TypeError('Invalid initial migration source');
  const checksum = createHash('sha256').update(source).digest('hex');
  const gate = `$st_gate_${checksum.slice(0, 16)}$`;
  const payload = `$st_sql_${checksum.slice(0, 16)}$`;
  if (body.includes(gate) || body.includes(payload))
    throw new TypeError('Invalid initial migration source');
  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';
SET LOCAL search_path = pg_catalog;
SELECT pg_advisory_xact_lock(74268490801812921::bigint);
CREATE SCHEMA IF NOT EXISTS signaltrail_migrations;
CREATE TABLE IF NOT EXISTS signaltrail_migrations.applied (
  version integer PRIMARY KEY CHECK (version >= 1),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO ${gate}
BEGIN
  IF EXISTS (SELECT 1 FROM signaltrail_migrations.applied WHERE version > 1) THEN
    RAISE EXCEPTION 'Unsupported control-plane migration version';
  END IF;
  IF EXISTS (SELECT 1 FROM signaltrail_migrations.applied WHERE version = 1 AND checksum <> '${checksum}') THEN
    RAISE EXCEPTION 'Migration checksum differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM signaltrail_migrations.applied WHERE version = 1) THEN
    EXECUTE ${payload}${body}${payload};
    INSERT INTO signaltrail_migrations.applied(version, checksum) VALUES (1, '${checksum}');
  END IF;
END;
${gate};
COMMIT;`;
}
