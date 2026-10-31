export { createAnalyticsQueryHandler } from './query-handler.ts';
export type { AnalyticsQueryOptions, ProjectAccess } from './query-handler.ts';

export interface AnalyticsReaderOptions {
  endpoint: string;
  username: string;
  password: string;
  database?: string;
  table?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
export interface ReceivedEventWindow {
  /** Must come from server-side project authorization, never a public ingestion key. */
  projectId: string;
  from: string;
  to: string;
}
function timestamp(value: string) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    throw new TypeError('Expected a UTC ISO timestamp');
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new TypeError('Invalid timestamp');
  return milliseconds;
}

async function boundedBody(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing query result');
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) throw new Error('Query result exceeded its bound');
      chunks.push(chunk.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export function createAnalyticsReader(options: AnalyticsReaderOptions) {
  options = { ...options };
  const send = options.fetch ?? globalThis.fetch;
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new TypeError('Invalid analytics endpoint');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new TypeError('Invalid analytics endpoint');
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new RangeError('Invalid query timeout');
  if (
    typeof options.username !== 'string' ||
    !options.username ||
    options.username.includes(':') ||
    typeof options.password !== 'string' ||
    /[\r\n]/.test(options.username + options.password)
  )
    throw new TypeError('Invalid analytics credentials');
  const database = options.database ?? 'signaltrail';
  const table = options.table ?? 'analytics_events';
  if (
    ![database, table].every(
      (value) => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(value),
    )
  )
    throw new TypeError('Invalid analytics identifier');
  const authorization =
    'Basic ' + Buffer.from(options.username + ':' + options.password).toString('base64');
  endpoint.searchParams.set(
    'query',
    `SELECT toString(count()) AS count FROM ${database}.${table} FINAL WHERE project_id = unhex({project_hex:String}) AND received_at >= parseDateTime64BestEffort({from:String}, 3, 'UTC') AND received_at < parseDateTime64BestEffort({to:String}, 3, 'UTC') FORMAT JSONEachRow`,
  );
  endpoint.searchParams.set(
    'max_execution_time',
    String(Math.max(1, Math.ceil(timeoutMs / 1000) - 1)),
  );
  endpoint.searchParams.set('max_memory_usage', String(64 * 1024 * 1024));
  endpoint.searchParams.set('max_threads', '2');
  endpoint.searchParams.set('optimize_move_to_prewhere', '0');
  // HTTP GET enforces readonly; explicitly changing that setting is rejected.
  endpoint.searchParams.set('wait_end_of_query', '1');
  return {
    async countReceivedEvents(window: ReceivedEventWindow) {
      if (
        typeof window.projectId !== 'string' ||
        !/\S/.test(window.projectId) ||
        Buffer.byteLength(window.projectId) > 1024 ||
        Buffer.from(window.projectId).toString('utf8') !== window.projectId
      )
        throw new TypeError('Invalid authorized project scope');
      const from = timestamp(window.from);
      const to = timestamp(window.to);
      if (to <= from || to - from > 31 * 86400000)
        throw new RangeError('Received-time window must be positive and at most 31 days');
      const target = new URL(endpoint);
      // HTTP String parameters use ClickHouse's escaped format. Hex binds exact
      // project bytes, including literal backslashes and control characters.
      target.searchParams.set('param_project_hex', Buffer.from(window.projectId).toString('hex'));
      target.searchParams.set('param_from', new Date(from).toISOString());
      target.searchParams.set('param_to', new Date(to).toISOString());
      const controller = new AbortController();
      let rejectDeadline!: (error: Error) => void;
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
      });
      const timer = setTimeout(() => {
        controller.abort();
        rejectDeadline(new Error('Analytics query was not confirmed'));
      }, timeoutMs);
      try {
        return await Promise.race([
          (async () => {
            const response = await send(target.href, {
              method: 'GET',
              headers: { Authorization: authorization },
              signal: controller.signal,
              credentials: 'omit',
              redirect: 'error',
              cache: 'no-store',
            });
            if (
              controller.signal.aborted ||
              response.status !== 200 ||
              ![null, '0'].includes(response.headers.get('X-ClickHouse-Exception-Code'))
            ) {
              void response.body?.cancel().catch(() => {});
              throw new Error('Unconfirmed query');
            }
            const result = JSON.parse(await boundedBody(response, controller.signal)) as {
              count?: unknown;
            } | null;
            if (
              !result ||
              Object.keys(result).length !== 1 ||
              typeof result.count !== 'string' ||
              !/^(0|[1-9]\d{0,19})$/.test(result.count) ||
              BigInt(result.count) > 18446744073709551615n
            )
              throw new Error('Invalid query count');
            return { count: result.count };
          })(),
          deadline,
        ]);
      } catch {
        throw new Error('Analytics query was not confirmed');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
