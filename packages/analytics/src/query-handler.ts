import type { ReceivedEventWindow, EventListWindow, EventSummary } from './index.ts';

export type ProjectAccess =
  | { status: 'authorized'; projectId: string }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' };

export interface AnalyticsQueryOptions {
  resolveProjectAccess(
    request: Request,
    requestedProjectId: string,
    signal: AbortSignal,
  ): Promise<ProjectAccess>;
  countReceivedEvents(
    window: ReceivedEventWindow,
    signal?: AbortSignal,
  ): Promise<{ count: string }>;
  listReceivedEvents?(
    window: EventListWindow,
    signal?: AbortSignal,
  ): Promise<{ events: EventSummary[]; hasMore: boolean }>;
  timeoutMs?: number;
  maxConcurrentRequests?: number;
}

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function createAnalyticsQueryHandler(options: AnalyticsQueryOptions) {
  options = { ...options };
  const timeoutMs = options.timeoutMs ?? 10000;
  const maximum = options.maxConcurrentRequests ?? 32;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 1024
  )
    throw new RangeError('Invalid query admission configuration');
  let active = 0;
  return async (request: Request): Promise<Response> => {
    if (request.url.length > 4096) return json({ error: 'URI_TOO_LONG' }, 414);
    const url = new URL(request.url);
    const listing = url.pathname === '/v1/analytics/events' && !!options.listReceivedEvents;
    if (!listing && url.pathname !== '/v1/analytics/count')
      return json({ error: 'NOT_FOUND' }, 404);
    if (request.method !== 'GET') {
      const response = json({ error: 'METHOD_NOT_ALLOWED' }, 405);
      response.headers.set('Allow', 'GET');
      return response;
    }
    const parameters = ['projectId', 'from', 'to'];
    const allowed = listing ? [...parameters, 'limit'] : parameters;
    if (
      [...url.searchParams.keys()].some((key) => !allowed.includes(key)) ||
      url.searchParams.getAll('limit').length > 1 ||
      parameters.some(
        (key) =>
          url.searchParams.getAll(key).length !== 1 || !/\S/.test(url.searchParams.get(key) ?? ''),
      )
    )
      return json({ error: 'INVALID_REQUEST' }, 400);
    if (active >= maximum || request.signal.aborted)
      return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
    active++;
    const controller = new AbortController();
    const work = (async () => {
      try {
        const access = await options.resolveProjectAccess(
          request,
          url.searchParams.get('projectId') ?? '',
          controller.signal,
        );
        controller.signal.throwIfAborted();
        if (access.status === 'unauthenticated') return json({ error: 'UNAUTHENTICATED' }, 401);
        if (access.status !== 'authorized') return json({ error: 'FORBIDDEN' }, 403);
        try {
          if (listing) {
            const rawLimit = url.searchParams.get('limit');
            if (rawLimit !== null && (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100))
              return json({ error: 'INVALID_WINDOW' }, 400);
            return json(
              await options.listReceivedEvents!(
                {
                  projectId: access.projectId,
                  from: url.searchParams.get('from') ?? '',
                  to: url.searchParams.get('to') ?? '',
                  ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
                },
                controller.signal,
              ),
              200,
            );
          }
          return json(
            await options.countReceivedEvents(
              {
                projectId: access.projectId,
                from: url.searchParams.get('from') ?? '',
                to: url.searchParams.get('to') ?? '',
              },
              controller.signal,
            ),
            200,
          );
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError)
            return json({ error: 'INVALID_WINDOW' }, 400);
          throw error;
        }
      } catch {
        return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
      } finally {
        active--;
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const deadline = new Promise<Response>((resolve) => {
      cancel = () => {
        controller.abort();
        resolve(json({ error: 'SERVICE_UNAVAILABLE' }, 503));
      };
      timer = setTimeout(cancel, timeoutMs);
      request.signal.addEventListener('abort', cancel, { once: true });
      if (request.signal.aborted) cancel();
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', cancel);
    }
  };
}
