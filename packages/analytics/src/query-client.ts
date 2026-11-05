import type {
  AnalyticsCountRequest,
  AnalyticsCountResponse,
  AnalyticsEventListRequest,
  AnalyticsEventPage,
} from './api-types.ts';
import {
  isCountResponse,
  isEventPage,
  queryJson,
  utcMilliseconds,
  validIdentifier,
} from './query-response.ts';

export interface QueryClientOptions {
  endpoint: string;
  /** Required: caller owns session credentials, cookies, and their verification boundary. */
  fetch: typeof fetch;
  timeoutMs?: number;
  maxConcurrentRequests?: number;
}
export type QueryClientErrorCode =
  'INVALID_RESPONSE' | 'NETWORK' | 'TIMEOUT' | 'ABORTED' | 'CAPACITY' | 'CLOSED' | 'HTTP_ERROR';
export class AnalyticsQueryClientError extends Error {
  readonly retryable: boolean;
  readonly code: QueryClientErrorCode;
  readonly status: number | undefined;
  constructor(code: QueryClientErrorCode, status: number | undefined = undefined) {
    super(
      code === 'INVALID_RESPONSE'
        ? 'Analytics response was not confirmed'
        : 'Analytics request was not confirmed',
    );
    this.name = 'AnalyticsQueryClientError';
    this.code = code;
    this.status = status;
    this.retryable =
      ['NETWORK', 'TIMEOUT', 'CAPACITY'].includes(code) ||
      (code === 'HTTP_ERROR' && (status === 429 || (status !== undefined && status >= 500)));
  }
}

export function createQueryClient(options: QueryClientOptions) {
  const send = options.fetch;
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new TypeError('Invalid query client configuration');
  }
  const timeoutMs = options.timeoutMs ?? 12000;
  const capacity = options.maxConcurrentRequests ?? 4;
  if (
    typeof send !== 'function' ||
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000 ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > 32
  )
    throw new TypeError('Invalid query client configuration');
  if (!endpoint.pathname.endsWith('/')) endpoint.pathname += '/';
  const base = endpoint.href;
  let closed = false;
  const active = new Map<AbortController, (error: AnalyticsQueryClientError) => void>();

  function target(
    operation: 'count' | 'events',
    input: AnalyticsCountRequest | AnalyticsEventListRequest,
  ) {
    const allowed = [
      'projectId',
      'from',
      'to',
      'eventName',
      'sessionId',
      ...(operation === 'events' ? ['limit', 'cursor'] : []),
    ];
    const query = input as AnalyticsEventListRequest;
    if (
      !query ||
      typeof query !== 'object' ||
      Array.isArray(query) ||
      Object.keys(query).some((key) => !allowed.includes(key)) ||
      !validIdentifier(query.projectId, 1024)
    )
      throw new TypeError('Invalid analytics query');
    const from = utcMilliseconds(query.from),
      to = utcMilliseconds(query.to);
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to <= from ||
      to - from > 31 * 86400000 ||
      [query.eventName, query.sessionId].some(
        (value) => value !== undefined && !validIdentifier(value),
      ) ||
      (query.limit !== undefined &&
        (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) ||
      (query.cursor !== undefined &&
        (typeof query.cursor !== 'string' ||
          query.cursor.length > 8192 ||
          !/^[A-Za-z0-9_-]+$/.test(query.cursor)))
    )
      throw new TypeError('Invalid analytics query');
    const url = new URL('v1/analytics/' + operation, base);
    for (const key of allowed) {
      const value = (query as unknown as Record<string, unknown>)[key];
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (url.href.length > (operation === 'count' ? 4096 : 16384))
      throw new RangeError('Analytics query URL exceeded its bound');
    return { url: url.href, maximum: query.limit ?? 50 };
  }
  async function execute(
    operation: 'count' | 'events',
    query: AnalyticsCountRequest | AnalyticsEventListRequest,
    signal?: AbortSignal,
  ): Promise<AnalyticsCountResponse | AnalyticsEventPage> {
    if (closed) throw new AnalyticsQueryClientError('CLOSED');
    if (signal?.aborted) throw new AnalyticsQueryClientError('ABORTED');
    const request = target(operation, query);
    if (active.size >= capacity) throw new AnalyticsQueryClientError('CAPACITY');
    const controller = new AbortController();
    let cancellation: AnalyticsQueryClientError | undefined;
    let cancel!: (error: AnalyticsQueryClientError) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      cancel = (error) => {
        if (cancellation) return;
        cancellation = error;
        controller.abort();
        reject(error);
      };
    });
    active.set(controller, cancel);
    const timer = setTimeout(() => cancel(new AnalyticsQueryClientError('TIMEOUT')), timeoutMs);
    const abort = () => cancel(new AnalyticsQueryClientError('ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const work = (async () => {
      let response: Response | undefined;
      try {
        if (cancellation) throw cancellation;
        try {
          response = await send(request.url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
            cache: 'no-store',
            redirect: 'error',
          });
        } catch {
          throw cancellation ?? new AnalyticsQueryClientError('NETWORK');
        }
        if (cancellation) {
          void response.body?.cancel().catch(() => {});
          throw cancellation;
        }
        if (response.redirected) throw new AnalyticsQueryClientError('INVALID_RESPONSE');
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          throw new AnalyticsQueryClientError('HTTP_ERROR', response.status);
        }
        const body = await queryJson(
          response,
          controller.signal,
          operation === 'count' ? 4096 : 192 * 1024,
        );
        if (operation === 'count' && isCountResponse(body)) return body;
        if (operation === 'events' && isEventPage(body, request.maximum)) return body;
        throw new AnalyticsQueryClientError('INVALID_RESPONSE');
      } catch (error) {
        if (cancellation) throw cancellation;
        if (error instanceof AnalyticsQueryClientError) throw error;
        // Never expose response bytes or credential-bearing fetch errors.
        throw new AnalyticsQueryClientError('INVALID_RESPONSE');
      } finally {
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        active.delete(controller);
      }
    })();
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    async countReceivedEvents(
      query: AnalyticsCountRequest,
      signal?: AbortSignal,
    ): Promise<AnalyticsCountResponse> {
      return (await execute('count', query, signal)) as AnalyticsCountResponse;
    },
    async listReceivedEvents(
      query: AnalyticsEventListRequest,
      signal?: AbortSignal,
    ): Promise<AnalyticsEventPage> {
      return (await execute('events', query, signal)) as AnalyticsEventPage;
    },
    close() {
      closed = true;
      for (const cancel of active.values()) cancel(new AnalyticsQueryClientError('CLOSED'));
    },
    snapshot() {
      return { closed, inFlight: active.size, capacity };
    },
  };
}
