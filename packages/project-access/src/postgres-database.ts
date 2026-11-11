import { Client, Pool, type PoolClient } from 'pg';
import type { AccessOptions } from './index.ts';
import type { ListenClient } from './key-invalidation-listener.ts';

export interface PostgresDatabaseOptions {
  connectionString: string;
  tls?: boolean;
  ca?: string;
  maxConnections?: number;
  maxInFlight?: number;
  timeoutMs?: number;
  onPoolError?(): void | Promise<void>;
  onQueryTiming?(phase: 'acquisition' | 'execution', seconds: number): void | Promise<void>;
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
  let peakInFlight = 0;
  let refused = 0;
  let executing = 0;
  let peakExecuting = 0;
  let acquiring = 0;
  let peakAcquiring = 0;
  const connectionWaitMs = { count: 0, total: 0, max: 0 };
  const queryExecutionMs = { count: 0, total: 0, max: 0 };
  const recordTiming = (metric: typeof connectionWaitMs, ms: number) => {
    metric.count++;
    metric.total += ms;
    metric.max = Math.max(metric.max, ms);
    try {
      const observation = options.onQueryTiming?.(
        metric === connectionWaitMs ? 'acquisition' : 'execution',
        ms / 1000,
      );
      if (observation !== undefined) void Promise.resolve(observation).catch(() => {});
    } catch {
      /* Observations cannot change query outcomes. */
    }
  };
  const recentRefusals: Array<{
    at: string;
    inFlight: number;
    capacity: number;
    waiting: number;
    executing: number;
    acquiring: number;
  }> = [];
  let closing: Promise<void> | undefined;
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  const connection = {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 5432),
    user,
    password,
    database,
    ssl:
      options.tls === false
        ? false
        : { rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) },
  };
  const listeners = new Set<Client>();
  const pool = new Pool({
    ...connection,
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
      if (!closed && inFlight >= maxInFlight) {
        refused++;
        recentRefusals.push({
          at: new Date().toISOString(),
          inFlight,
          capacity: maxInFlight,
          waiting: pool.waitingCount,
          executing,
          acquiring,
        });
        if (recentRefusals.length > 32) recentRefusals.shift();
      }
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
      peakInFlight = Math.max(peakInFlight, inFlight);
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
          const acquireStart = performance.now();
          acquiring++;
          peakAcquiring = Math.max(peakAcquiring, acquiring);
          try {
            client = await pool.connect();
          } finally {
            acquiring--;
            recordTiming(connectionWaitMs, performance.now() - acquireStart);
          }
          client.on('error', onClientError);
          controller.signal.throwIfAborted();
          const queryConfig = { text, values, queryMode: 'extended' as const };
          const executionStart = performance.now();
          executing++;
          peakExecuting = Math.max(peakExecuting, executing);
          let result;
          try {
            result = await client.query<Record<string, unknown>>(queryConfig);
          } finally {
            executing--;
            recordTiming(queryExecutionMs, performance.now() - executionStart);
          }
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
    snapshot: () => ({
      closed,
      inFlight,
      capacity: maxInFlight,
      waiting: pool.waitingCount,
      maxConnections,
      peakInFlight,
      refused,
      executing,
      peakExecuting,
      acquiring,
      peakAcquiring,
      connectionWaitMs: { ...connectionWaitMs },
      queryExecutionMs: { ...queryExecutionMs },
      recentRefusals: recentRefusals.map((event) => ({ ...event })),
    }),
    /** Dedicated connection outside the pool and its admission limits, for LISTEN only. */
    async connectListener(): Promise<ListenClient> {
      const failure = () => new Error('PostgreSQL listener was not confirmed');
      if (closed) throw failure();
      const client = new Client({
        ...connection,
        connectionTimeoutMillis: timeoutMs,
        keepAlive: true,
        application_name: 'signaltrail-key-invalidation',
        options: '-c default_transaction_read_only=on',
      });
      client.on('error', reportPoolError);
      listeners.add(client);
      client.once('end', () => listeners.delete(client));
      try {
        await client.connect();
        if (closed) throw failure();
        return {
          query: (text: string) => client.query(text),
          on(event: 'notification' | 'error' | 'end', listener: (value?: never) => void) {
            client.on(event, listener as () => void);
            return this;
          },
          end: () => client.end(),
        } as ListenClient;
      } catch {
        listeners.delete(client);
        void client.end().catch(() => {});
        throw failure();
      }
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      for (const controller of controllers) controller.abort();
      const shutdown = (async () => {
        await Promise.allSettled([...listeners].map((client) => client.end()));
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
