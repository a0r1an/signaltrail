import { createHash, randomBytes } from 'node:crypto';
import type { AccessOptions } from './index.ts';
const statement = `SELECT project_id::text AS project_id FROM signaltrail_control.ingestion_keys
WHERE key_hash = decode($1, 'hex') AND revoked_at IS NULL LIMIT 2`;
function validKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length !== 50 || !/^st_pub_[A-Za-z0-9_-]{43}$/.test(key))
    return false;
  const bytes = Buffer.from(key.slice(7), 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === key.slice(7);
}
/** Public SDK credential, not a dashboard session or read permission. Store only its hash. */
export function createIngestionKey(): string {
  return 'st_pub_' + randomBytes(32).toString('base64url');
}
export function hashIngestionKey(key: string): string {
  if (!validKey(key)) throw new TypeError('Invalid ingestion key');
  return createHash('sha256').update(key).digest('hex');
}
export function createStoredProjectResolver(query: AccessOptions['query']) {
  return async (key: string, signal?: AbortSignal): Promise<string | undefined> => {
    if (!validKey(key)) return undefined;
    const cancellation = signal ?? AbortSignal.timeout(5000);
    try {
      cancellation.throwIfAborted();
      const result = await query({
        text: statement,
        values: [hashIngestionKey(key)],
        signal: cancellation,
      });
      cancellation.throwIfAborted();
      if (!Array.isArray(result.rows) || result.rows.length > 1) throw new Error();
      if (!result.rows.length) return undefined;
      const row = result.rows[0] as { project_id?: unknown } | null;
      if (
        !row ||
        Object.keys(row).length !== 1 ||
        typeof row.project_id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.project_id)
      )
        throw new Error();
      return row.project_id;
    } catch {
      throw new Error('Ingestion project was not confirmed');
    }
  };
}
