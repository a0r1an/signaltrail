import { Pool, type PoolClient } from 'pg';
import type { AccessOptions } from './index.ts';

export interface PostgresDatabaseOptions {
  connectionString: string;
  tls?: boolean;
  ca?: string;
  maxConnections?: number;
  maxInFlight?: number;
  timeoutMs?: number;
  onPoolError?(): void | Promise<void>;
}

export function createPostgresMembershipDatabase(options: PostgresDatabaseOptions) {
  options = { ...options };
  const maxConnections = options.maxConnections ?? 4;
  const maxInFlight = options.maxInFlight ?? 16;
  const timeoutMs = options.timeoutMs ?? 5000;
  let url: URL;
  let user: string, password: string, database: string;
  try {
    if (
      typeof options.connectionString !== 'string' ||
      Buffer.byteLength(options.connectionString) > 8192
    )
      throw new Error();
    url = new URL(options.connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      (url.port !== '' && Number(url.port) < 1) ||
      url.pathname.length < 2 ||
      url.search ||
      url.hash
    )
      throw new Error();
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
    if ([user, password, database].some((value) => value.includes('\0'))) throw new Error();
    if (
      !Number.isSafeInteger(maxConnections) ||
      maxConnections < 1 ||
      maxConnections > 32 ||
      !Number.isSafeInteger(maxInFlight) ||
      maxInFlight < 1 ||
      maxInFlight > 128 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 10 ||
      timeoutMs > 10000
    )
      throw new Error();
    if (
      options.ca !== undefined &&
      (typeof options.ca !== 'string' ||
        !options.ca.trim() ||
        Buffer.byteLength(options.ca) > 65536 ||
        options.tls === false)
    )
      throw new Error();
  } catch {
    throw new TypeError('Invalid PostgreSQL adapter configuration');
  }
  let closed = false;
  let inFlight = 0;
  let closing: Promise<void> | undefined;
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  const pool = new Pool({
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 5432),
    user,
    password,
    database,
    ssl:
      options.tls === false
        ? false
        : { rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) },
    max: maxConnections,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: Math.max(1, timeoutMs - 50),
    lock_timeout: Math.max(1, timeoutMs - 50),
    idleTimeoutMillis: 30000,
    application_name: 'signaltrail-project-access',
    options: '-c default_transaction_read_only=on',
  });
  const reportPoolError = () => {
    try {
      void Promise.resolve(options.onPoolError?.()).catch(() => {});
    } catch {
      /* Diagnostics cannot crash the pool. */
    }
  };
  pool.on('error', reportPoolError);
  return {
    async query(input: Parameters<AccessOptions['query']>[0]): Promise<{ rows: unknown[] }> {
      const failure = () => new Error('PostgreSQL query was not confirmed');
      if (
        closed ||
        inFlight >= maxInFlight ||
        !input ||
        !(input.signal instanceof AbortSignal) ||
        input.signal.aborted ||
        typeof input.text !== 'string' ||
        !input.text.trim() ||
        Buffer.byteLength(input.text) > 16384 ||
        input.text.includes('\0') ||
        !Array.isArray(input.values) ||
        input.values.length > 16 ||
        !input.values.every(
          (value) =>
            typeof value === 'string' &&
            Buffer.byteLength(value) <= 4096 &&
            !value.includes('\0') &&
            Buffer.from(value).toString() === value,
        )
      )
        throw failure();
      const text = input.text;
      const values = [...input.values];
      const signal = input.signal;
      const controller = new AbortController();
      controllers.add(controller);
      inFlight++;
      let client: PoolClient | undefined;
      let released = false;
      const onClientError = () => {
        reportPoolError();
        controller.abort();
      };
      const release = (destroy: boolean) => {
        if (client && !released) {
          released = true;
          client.release(destroy);
          client.removeListener('error', onClientError);
        }
      };
      const discard = () => {
        try {
          release(true);
        } catch {
          reportPoolError();
        }
      };
      let rejectWait!: (error: Error) => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectWait = reject;
      });
      const onAbort = () => {
        discard();
        rejectWait(failure());
      };
      const cancel = () => controller.abort();
      controller.signal.addEventListener('abort', onAbort, { once: true });
      signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, timeoutMs);
      if (signal.aborted) cancel();
      const work = (async () => {
        try {
          controller.signal.throwIfAborted();
          client = await pool.connect();
          client.on('error', onClientError);
          controller.signal.throwIfAborted();
          const queryConfig = { text, values, queryMode: 'extended' as const };
          const result = await client.query<Record<string, unknown>>(queryConfig);
          controller.signal.throwIfAborted();
          release(false);
          return { rows: result.rows };
        } catch {
          discard();
          throw failure();
        }
      })();
      const tracked = work.finally(() => {
        inFlight--;
        controllers.delete(controller);
        controller.signal.removeEventListener('abort', onAbort);
        pending.delete(tracked);
      });
      pending.add(tracked);
      try {
        return await Promise.race([tracked, cancelled]);
      } catch {
        throw failure();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      }
    },
    snapshot: () => ({ closed, inFlight, capacity: maxInFlight, waiting: pool.waitingCount }),
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      for (const controller of controllers) controller.abort();
      const shutdown = (async () => {
        await Promise.allSettled([...pending]);
        await pool.end();
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      closing = Promise.race([
        shutdown,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('PostgreSQL shutdown was not confirmed')),
            timeoutMs + 1000,
          );
        }),
      ])
        .catch(() => {
          throw new Error('PostgreSQL shutdown was not confirmed');
        })
        .finally(() => clearTimeout(timer));
      return closing;
    },
  };
}
