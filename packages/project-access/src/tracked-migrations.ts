import { createHash } from 'node:crypto';
/** Repository-owned, ordered migration sources only. This is not a SQL sanitizer. */
export function createControlPlaneMigrationStatement(
  sources: readonly { version: number; source: string }[],
): string {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 16)
    throw new TypeError('Invalid control-plane migrations');
  const entries = sources.map((entry, index) => {
    if (
      !entry ||
      entry.version !== index + 1 ||
      typeof entry.source !== 'string' ||
      Buffer.byteLength(entry.source) > 65536 ||
      entry.source.includes('\0') ||
      Buffer.from(entry.source).toString() !== entry.source
    )
      throw new TypeError('Invalid control-plane migration source');
    const lines = entry.source.trim().split('\n');
    while (lines[0]?.trimStart().startsWith('--')) lines.shift();
    const sql = lines.join('\n').trim();
    if (!sql.toUpperCase().startsWith('BEGIN;') || !sql.toUpperCase().endsWith('COMMIT;'))
      throw new TypeError('Invalid control-plane migration source');
    const body = sql.slice(6, -7).trim();
    if (!body) throw new TypeError('Invalid control-plane migration source');
    return {
      version: entry.version,
      body,
      checksum: createHash('sha256').update(entry.source).digest('hex'),
    };
  });
  const binding = createHash('sha256')
    .update(entries.map((entry) => entry.checksum).join(':'))
    .digest('hex')
    .slice(0, 16);
  const gate = `$st_gate_${binding}$`;
  const statements = entries.map((entry) => {
    const payload = `$st_sql_${entry.version}_${binding}$`;
    if (entry.body.includes(gate) || entry.body.includes(payload))
      throw new TypeError('Invalid control-plane migration source');
    return `IF EXISTS (SELECT 1 FROM signaltrail_migrations.applied WHERE version = ${entry.version} AND checksum <> '${entry.checksum}') THEN
      RAISE EXCEPTION 'Migration checksum differs';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM signaltrail_migrations.applied WHERE version = ${entry.version}) THEN
      EXECUTE ${payload}${entry.body}${payload};
      INSERT INTO signaltrail_migrations.applied(version,checksum) VALUES (${entry.version}, '${entry.checksum}');
    END IF;`;
  });
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
  IF EXISTS (SELECT 1 FROM signaltrail_migrations.applied WHERE version > ${entries.length}) THEN
    RAISE EXCEPTION 'Unsupported control-plane migration version';
  END IF;
  IF (SELECT count(*) FROM signaltrail_migrations.applied) <> (SELECT COALESCE(max(version),0) FROM signaltrail_migrations.applied) THEN
    RAISE EXCEPTION 'Migration history is incomplete';
  END IF;
  ${statements.join('\n  ')}
END;
${gate};
COMMIT;`;
}
