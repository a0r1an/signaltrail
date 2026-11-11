import { readFileSync } from 'node:fs';
import {
  createCachedProjectResolver,
  createPostgresMembershipDatabase,
  createStoredProjectResolver,
  startIngestionKeyListener,
  type ListenClient,
  type AccessOptions,
  type PostgresDatabaseOptions,
} from '@signaltrail/project-access';
import { createDevelopmentProjectResolver } from './development-projects.ts';
export interface ProjectRuntime {
  mode: 'development' | 'stored';
  resolveProjectKey(key: string): string | undefined | Promise<string | undefined>;
  verify(): Promise<void>;
  close(): Promise<void>;
}
interface ReadDatabase {
  query: AccessOptions['query'];
  close(): Promise<void>;
  /** Dedicated LISTEN connection; without it every key lookup reaches PostgreSQL. */
  connectListener?(): Promise<ListenClient>;
}
export function createProjectRuntime(
  env: Record<string, string | undefined>,
  dependencies: { createDatabase?: (options: PostgresDatabaseOptions) => ReadDatabase } = {},
): ProjectRuntime {
  if (![undefined, 'development', 'test', 'production'].includes(env.NODE_ENV))
    throw new TypeError('Invalid project runtime mode');
  if (env.NODE_ENV !== 'production') {
    try {
      const resolveProjectKey = createDevelopmentProjectResolver(
        JSON.parse(env.SIGNALTRAIL_DEV_PROJECTS ?? '[]') as unknown,
      );
      return {
        mode: 'development',
        resolveProjectKey,
        verify: async () => {},
        close: async () => {},
      };
    } catch {
      throw new TypeError('Invalid development project configuration');
    }
  }
  if (env.SIGNALTRAIL_DEV_PROJECTS?.trim())
    throw new TypeError('Development project mappings are not allowed in production');
  const connectionString = env.SIGNALTRAIL_INGESTION_DATABASE_URL;
  const tlsValue = env.SIGNALTRAIL_INGESTION_DATABASE_TLS ?? 'true';
  let ca = env.SIGNALTRAIL_INGESTION_DATABASE_CA;
  try {
    // Containers mount the CA as a file; multi-line PEM does not fit env files.
    const caFile = env.SIGNALTRAIL_INGESTION_DATABASE_CA_FILE;
    if (caFile !== undefined) {
      if (ca !== undefined || !caFile.startsWith('/')) throw new Error();
      ca = readFileSync(caFile, 'utf8');
    }
    if (
      !connectionString ||
      Buffer.byteLength(connectionString) > 8192 ||
      !['true', 'false'].includes(tlsValue)
    )
      throw new Error();
    const url = new URL(connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      url.pathname.length < 2 ||
      (url.port !== '' && Number(url.port) < 1) ||
      url.search ||
      url.hash ||
      (tlsValue === 'false' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
      (ca !== undefined && (!ca.trim() || Buffer.byteLength(ca) > 65536 || tlsValue === 'false'))
    )
      throw new Error();
  } catch {
    throw new TypeError('Invalid production project database configuration');
  }
  const createDatabase = dependencies.createDatabase ?? createPostgresMembershipDatabase;
  let database: ReadDatabase;
  try {
    database = createDatabase({
      connectionString,
      tls: tlsValue === 'true',
      ...(ca ? { ca } : {}),
    });
  } catch {
    throw new TypeError('Invalid production project database configuration');
  }
  // Key lookups are cached only while revocation notifications are being received.
  const cache = createCachedProjectResolver(createStoredProjectResolver(database.query));
  const listener = database.connectListener
    ? startIngestionKeyListener({
        connect: database.connectListener,
        onTrusted: cache.setTrusted,
        onInvalidate: cache.invalidate,
        onClear: cache.clear,
      })
    : undefined;
  return {
    mode: 'stored',
    resolveProjectKey: cache.resolve,
    async close() {
      await listener?.stop();
      await database.close();
    },
    async verify() {
      try {
        const result = await database.query({
          text: "SELECT project_id::text AS project_id FROM signaltrail_control.ingestion_keys WHERE key_hash = decode($1, 'hex') AND revoked_at IS NULL LIMIT 0",
          values: ['0'.repeat(64)],
          signal: AbortSignal.timeout(5000),
        });
        if (!Array.isArray(result.rows) || result.rows.length) throw new Error();
      } catch {
        throw new Error('Ingestion project database readiness was not confirmed');
      }
    },
  };
}
