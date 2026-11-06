import { createHash } from 'node:crypto';
import type { AccessOptions, Principal } from './index.ts';
export interface ProjectPage {
  projects: { id: string; name: string }[];
  hasMore: boolean;
  nextCursor?: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const statement = `SELECT p.id::text AS project_id, p.name AS project_name
FROM signaltrail_control.projects p
JOIN signaltrail_control.organization_memberships m ON m.organization_id = p.organization_id
JOIN signaltrail_control.principals u ON u.id = m.principal_id
WHERE u.issuer = $1 AND u.subject = $2 AND m.role IN ('owner','admin','member')
AND ($3 = '' OR p.id > NULLIF($3, '')::uuid)
ORDER BY p.id ASC LIMIT $4::integer`;
function scope(principal: Principal): string {
  return createHash('sha256')
    .update(JSON.stringify([principal.issuer, principal.subject]))
    .digest('hex');
}
function position(cursor: string | undefined, expectedScope: string): string {
  if (cursor === undefined) return '';
  try {
    if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
      version?: unknown;
      scope?: unknown;
      id?: unknown;
    } | null;
    if (
      !value ||
      Object.keys(value).length !== 3 ||
      value.version !== 1 ||
      value.scope !== expectedScope ||
      typeof value.id !== 'string' ||
      !uuid.test(value.id)
    )
      throw new Error();
    return value.id;
  } catch {
    throw new TypeError('Invalid project cursor');
  }
}
/** The principal must already be verified by the server's session provider. */
export function createProjectListReader(query: AccessOptions['query']) {
  return async (
    principal: Principal,
    options: { limit?: number; cursor?: string },
    signal: AbortSignal,
  ): Promise<ProjectPage> => {
    if (
      !principal ||
      ![principal.issuer, principal.subject].every(
        (value) =>
          typeof value === 'string' &&
          /\S/.test(value) &&
          Buffer.byteLength(value) <= 1024 &&
          Buffer.from(value).toString() === value,
      )
    )
      throw new Error('Project access was not confirmed');
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Invalid project limit');
    const binding = scope(principal),
      after = position(options.cursor, binding);
    try {
      signal.throwIfAborted();
      const result = await query({
        text: statement,
        values: [principal.issuer, principal.subject, after, String(limit + 1)],
        signal,
      });
      signal.throwIfAborted();
      if (!Array.isArray(result.rows) || result.rows.length > limit + 1) throw new Error();
      let previous = after;
      const projects = result.rows.map((raw) => {
        const row = raw as { project_id?: unknown; project_name?: unknown } | null;
        if (
          !row ||
          Object.keys(row).length !== 2 ||
          typeof row.project_id !== 'string' ||
          !uuid.test(row.project_id) ||
          row.project_id <= previous ||
          typeof row.project_name !== 'string' ||
          !/\S/.test(row.project_name) ||
          [...row.project_name].length > 200 ||
          Buffer.from(row.project_name).toString() !== row.project_name
        )
          throw new Error();
        previous = row.project_id;
        return { id: row.project_id, name: row.project_name };
      });
      const hasMore = projects.length > limit;
      const selected = projects.slice(0, limit);
      const nextCursor = hasMore
        ? Buffer.from(
            JSON.stringify({ version: 1, scope: binding, id: selected.at(-1)!.id }),
          ).toString('base64url')
        : undefined;
      return { projects: selected, hasMore, ...(nextCursor ? { nextCursor } : {}) };
    } catch {
      throw new Error('Projects were not confirmed');
    }
  };
}
