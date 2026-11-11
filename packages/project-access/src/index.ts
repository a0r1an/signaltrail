export {
  createIngestionKey,
  hashIngestionKey,
  createStoredProjectResolver,
} from './ingestion-keys.ts';
export { createControlPlaneMigrationStatement } from './tracked-migrations.ts';
export { createCachedProjectResolver } from './cached-project-resolver.ts';
export type { ProjectCacheOptions } from './cached-project-resolver.ts';
export { INGESTION_KEY_CHANNEL, startIngestionKeyListener } from './key-invalidation-listener.ts';
export type { IngestionKeyListenerOptions, ListenClient } from './key-invalidation-listener.ts';
export { createProjectListReader } from './project-list.ts';
export type { ProjectPage } from './project-list.ts';
export { createInitialMigrationStatement } from './initial-migration.ts';
export { createPostgresMembershipDatabase } from './postgres-database.ts';
export type { PostgresDatabaseOptions } from './postgres-database.ts';

export interface Principal {
  issuer: string;
  subject: string;
}
export type ProjectAccess =
  | { status: 'authorized'; projectId: string }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' };
export interface AccessOptions {
  resolveIdentity(request: Request, signal: AbortSignal): Promise<Principal | null>;
  query(input: {
    text: string;
    values: readonly string[];
    signal: AbortSignal;
  }): Promise<{ rows: unknown[] }>;
}

const membershipQuery = `SELECT p.id::text AS project_id
FROM signaltrail_control.projects p
JOIN signaltrail_control.organization_memberships m ON m.organization_id = p.organization_id
JOIN signaltrail_control.principals u ON u.id = m.principal_id
WHERE p.id = $1::uuid AND u.issuer = $2 AND u.subject = $3
AND m.role IN ('owner', 'admin', 'member')
LIMIT 1`;

export function createProjectAccessResolver(options: AccessOptions) {
  options = { ...options };
  return async (
    request: Request,
    requestedProjectId: string,
    signal: AbortSignal,
  ): Promise<ProjectAccess> => {
    try {
      signal.throwIfAborted();
      const identity = await options.resolveIdentity(request, signal);
      signal.throwIfAborted();
      if (identity === null) return { status: 'unauthenticated' };
      if (
        !identity ||
        ![identity.issuer, identity.subject].every(
          (value) =>
            typeof value === 'string' &&
            /\S/.test(value) &&
            Buffer.byteLength(value) <= 1024 &&
            Buffer.from(value).toString() === value,
        )
      )
        throw new Error('Invalid verified principal');
      if (
        typeof requestedProjectId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedProjectId)
      )
        return { status: 'forbidden' };
      const projectId = requestedProjectId.toLowerCase();
      const result = await options.query({
        text: membershipQuery,
        values: [projectId, identity.issuer, identity.subject],
        signal,
      });
      signal.throwIfAborted();
      if (!Array.isArray(result.rows) || result.rows.length > 1)
        throw new Error('Inconsistent membership result');
      if (result.rows.length === 0) return { status: 'forbidden' };
      const row = result.rows[0] as { project_id?: unknown } | null;
      if (!row || Object.keys(row).length !== 1 || row.project_id !== projectId)
        throw new Error('Inconsistent project scope');
      return { status: 'authorized', projectId };
    } catch {
      throw new Error('Project access was not confirmed');
    }
  };
}
export { createInitialProjectStatement } from './bootstrap-project.ts';
export type { InitialProjectInput } from './bootstrap-project.ts';
