import { SdkHealthReportSchema, type SdkHealthReport } from '@signaltrail/contracts';
import {
  AnalyticsBatchSchema,
  validateAnalyticsEvents,
  type AnalyticsEventSchema,
} from '@signaltrail/contracts';
export interface PublishedEvent {
  projectId: string;
  receivedAt: string;
  event: ReturnType<typeof AnalyticsEventSchema.parse>;
}
export interface IngestionOptions {
  observeSdkHealth?: (report: SdkHealthReport, projectId: string) => void;
  resolveProjectKey(key: string): string | undefined | Promise<string | undefined>;
  // Resolve only once publication is acknowledged. Cancellation cannot undo publication.
  publish(record: PublishedEvent, signal: AbortSignal): Promise<void>;
  allowedOrigins?: readonly string[];
  maxRequestBytes?: number;
  publicationTimeoutMs?: number;
  now?: () => number;
  observeRequest?: (status: number, seconds: number) => void;
}
class BodyTooLarge extends Error {}
async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) throw new BodyTooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new BodyTooLarge();
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  // Bound nesting before invoking recursive event validation. Quoted brackets are data.
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (++depth > 64) throw new Error('JSON nesting limit exceeded');
    } else if (char === '}' || char === ']') depth--;
  }
  return JSON.parse(text) as unknown;
}
export function createIngestionHandler(options: IngestionOptions) {
  const publicationTimeout = options.publicationTimeoutMs ?? 5000;
  if (
    !Number.isSafeInteger(publicationTimeout) ||
    publicationTimeout < 1 ||
    publicationTimeout > 10_000
  )
    throw new RangeError('publicationTimeoutMs must be an integer from 1 to 10000');
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const maxBytes = options.maxRequestBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError('maxRequestBytes must be a positive safe integer');
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const allowed = origin !== null && (origin === url.origin || allowedOrigins.has(origin));
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
    if (allowed) headers.set('Access-Control-Allow-Origin', origin);
    const json = (value: unknown, init?: ResponseInit) =>
      Response.json(value, {
        ...init,
        headers: new Headers([...headers, ...new Headers(init?.headers)]),
      });
    if (origin && !allowed) return json({ error: 'ORIGIN_NOT_ALLOWED' }, { status: 403 });
    const path = url.pathname;
    if (path === '/health' && request.method === 'GET') return json({ status: 'ok' });
    if (!['/v1/events', '/v1/sdk-health'].includes(path))
      return json({ error: 'NOT_FOUND' }, { status: 404 });
    if (request.method === 'OPTIONS') {
      const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (
        !allowed ||
        request.headers.get('access-control-request-method') !== 'POST' ||
        requestedHeaders.some((value) => !['authorization', 'content-type'].includes(value))
      )
        return json({ error: 'INVALID_PREFLIGHT' }, { status: 400 });
      headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'POST')
      return json(
        { error: 'METHOD_NOT_ALLOWED' },
        { status: 405, headers: { Allow: 'POST, OPTIONS' } },
      );
    const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (
      !['application/json', 'text/plain'].includes(mediaType ?? '') ||
      !['identity', null].includes(request.headers.get('content-encoding'))
    )
      return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, { status: 415 });
    let payload: unknown;
    try {
      payload = await readJson(
        request,
        path === '/v1/sdk-health' ? Math.min(maxBytes, 16 * 1024) : maxBytes,
      );
    } catch (error) {
      return json(
        { error: error instanceof BodyTooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON' },
        { status: error instanceof BodyTooLarge ? 413 : 400 },
      );
    }
    const bodyKey =
      typeof payload === 'object' &&
      payload !== null &&
      'projectKey' in payload &&
      typeof payload.projectKey === 'string'
        ? payload.projectKey
        : undefined;
    const header = request.headers.get('authorization');
    const key = header === null ? (bodyKey ?? '') : (/^Bearer (\S+)$/i.exec(header)?.[1] ?? '');
    if (!key || (header !== null && bodyKey !== undefined && bodyKey !== key))
      return json({ error: 'UNAUTHORIZED' }, { status: 401 });
    let projectId: string | undefined;
    try {
      projectId = await options.resolveProjectKey(key);
    } catch {
      return json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
    }
    if (!projectId) return json({ error: 'UNAUTHORIZED' }, { status: 401 });
    if (path === '/v1/sdk-health') {
      const report = SdkHealthReportSchema.safeParse(payload);
      if (!report.success) return json({ error: 'INVALID_HEALTH_REPORT' }, { status: 400 });
      if (!options.observeSdkHealth) return json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
      try {
        options.observeSdkHealth(report.data, projectId);
      } catch {
        return json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503 });
      }
      return new Response(null, { status: 204, headers });
    }
    const batch = AnalyticsBatchSchema.safeParse(payload);
    if (!batch.success) return json({ error: 'INVALID_BATCH' }, { status: 400 });
    const receivedAt = new Date((options.now ?? Date.now)()).toISOString();
    const results = await Promise.all(
      validateAnalyticsEvents(batch.data.events).map(async ({ index, result }) => {
        if (!result.success) return { index, status: 'rejected', code: 'INVALID_EVENT' };
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('Publication deadline exceeded'));
            }, publicationTimeout);
          });
          await Promise.race([
            Promise.resolve().then(() =>
              options.publish({ projectId, receivedAt, event: result.data }, controller.signal),
            ),
            deadline,
          ]);
          return { index, eventId: result.data.eventId, status: 'accepted' };
        } catch {
          return {
            index,
            eventId: result.data.eventId,
            status: 'retry',
            code: 'PUBLICATION_UNCONFIRMED',
            retryAfterMs: 1000,
          };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return json({ results });
  };
  return async (request: Request): Promise<Response> => {
    const start = performance.now();
    let status = 503;
    try {
      const response = await handle(request);
      status = response.status;
      return response;
    } finally {
      try {
        void Promise.resolve(
          options.observeRequest?.(status, (performance.now() - start) / 1000),
        ).catch(() => {});
      } catch {
        /* Observability cannot alter an ingestion outcome. */
      }
    }
  };
}
