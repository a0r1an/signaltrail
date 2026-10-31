import type { PublishedAnalyticsEvent } from '@signaltrail/contracts';

export interface ClickHouseWriterOptions {
  endpoint: string;
  database?: string;
  table?: string;
  username: string;
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
async function readAcknowledgement(response: Response, signal: AbortSignal): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      // Successful INSERTs have no result rows. Permit only small whitespace bodies.
      if (bytes > 4096 || chunk.value.some((byte: number) => ![9, 10, 13, 32].includes(byte)))
        throw new Error('Unconfirmed insert');
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createClickHouseBatchWriter(options: ClickHouseWriterOptions) {
  options = { ...options };
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new RangeError('timeoutMs must be from 1 to 30000');
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new TypeError('Invalid ClickHouse endpoint');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new TypeError('Invalid ClickHouse endpoint');
  const database = options.database ?? 'signaltrail';
  const table = options.table ?? 'analytics_events';
  if (
    ![database, table].every(
      (value) => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(value),
    )
  )
    throw new TypeError('Invalid ClickHouse identifier');
  if (
    typeof options.username !== 'string' ||
    !options.username ||
    typeof options.password !== 'string'
  )
    throw new TypeError('Invalid ClickHouse credentials');
  if (options.username.includes(':') || /[\r\n]/.test(options.username + options.password))
    throw new TypeError('Invalid ClickHouse credentials');
  const authorization =
    'Basic ' + Buffer.from(options.username + ':' + options.password).toString('base64');
  endpoint.searchParams.set('query', `INSERT INTO ${database}.${table} FORMAT JSONEachRow`);
  endpoint.searchParams.set('wait_end_of_query', '1');
  endpoint.searchParams.set('async_insert', '0');
  endpoint.searchParams.set('date_time_input_format', 'best_effort');
  const send = options.fetch ?? globalThis.fetch;
  return async (records: readonly PublishedAnalyticsEvent[]) => {
    if (records.length < 1 || records.length > 100)
      throw new RangeError('ClickHouse batches must contain from 1 to 100 records');
    const body = records
      .map((record) => {
        const event = record.event;
        return (
          JSON.stringify({
            project_id: record.projectId,
            event_id: event.eventId,
            received_at: record.receivedAt,
            client_timestamp: event.clientTimestamp,
            event_name: event.eventName,
            distinct_id: event.distinctId,
            session_id: event.sessionId,
            sequence: event.sequence,
            url: event.url,
            properties_json: JSON.stringify(event.properties),
            context_json: JSON.stringify(event.context),
          }) + '\n'
        );
      })
      .join('');
    if (Buffer.byteLength(body, 'utf8') > 4 * 1024 * 1024)
      throw new RangeError('ClickHouse batch exceeds 4 MiB');
    const controller = new AbortController();
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectDeadline(new Error('ClickHouse insert was not acknowledged'));
    }, timeoutMs);
    try {
      await Promise.race([
        (async () => {
          const response = await send(endpoint.href, {
            method: 'POST',
            headers: {
              Authorization: authorization,
              'Content-Type': 'application/x-ndjson',
            },
            body,
            signal: controller.signal,
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
          });
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw new Error('ClickHouse insert was not acknowledged');
          }
          await readAcknowledgement(response, controller.signal);
          if (
            response.status !== 200 ||
            ![null, '0'].includes(response.headers.get('X-ClickHouse-Exception-Code'))
          )
            throw new Error('ClickHouse insert was not acknowledged');
        })(),
        deadline,
      ]);
    } catch {
      // Storage exceptions can contain SQL, event values, credentials, or response bodies.
      throw new Error('ClickHouse insert was not acknowledged');
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function createClickHouseWriter(options: ClickHouseWriterOptions) {
  const writeBatch = createClickHouseBatchWriter(options);
  return async (record: PublishedAnalyticsEvent) => writeBatch([record]);
}
