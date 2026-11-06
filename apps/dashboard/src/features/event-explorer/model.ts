import type {
  AnalyticsCountRequest,
  AnalyticsCountResponse,
  AnalyticsEventListRequest,
  AnalyticsEventPage,
  AnalyticsOccurredEventPage,
} from '@signaltrail/analytics/api-types';

export type ExplorerQuery = Omit<AnalyticsCountRequest, 'projectId'>;
export type ExplorerError = 'sign_in' | 'forbidden' | 'invalid_query' | 'unavailable';
export interface ExplorerClient {
  countEvents(query: AnalyticsCountRequest, signal?: AbortSignal): Promise<AnalyticsCountResponse>;
  countVisitors?(
    query: AnalyticsCountRequest,
    signal?: AbortSignal,
  ): Promise<AnalyticsCountResponse>;
  listEvents(
    query: AnalyticsEventListRequest,
    signal?: AbortSignal,
  ): Promise<AnalyticsEventPage | AnalyticsOccurredEventPage>;
}
export interface ExplorerState {
  query: ExplorerQuery;
  page: AnalyticsEventPage | AnalyticsOccurredEventPage | undefined;
  count: string | undefined;
  visitors: string | undefined;
  cursor: string | undefined;
  pageIndex: number;
  loading: boolean;
  closed: boolean;
  eventsError: ExplorerError | undefined;
  countError: ExplorerError | undefined;
  visitorError: ExplorerError | undefined;
}
export interface ExplorerOptions {
  projectId: string;
  initialQuery: ExplorerQuery;
  client: ExplorerClient;
}

function pickQuery(query: ExplorerQuery): ExplorerQuery {
  return {
    from: query.from,
    to: query.to,
    ...(query.eventName === undefined ? {} : { eventName: query.eventName }),
    ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
  };
}
function classify(error: unknown): ExplorerError {
  if (error && typeof error === 'object' && 'status' in error) {
    if (error.status === 401) return 'sign_in';
    if (error.status === 403) return 'forbidden';
    if (error.status === 400 || error.status === 414) return 'invalid_query';
  }
  return error instanceof TypeError || error instanceof RangeError
    ? 'invalid_query'
    : 'unavailable';
}

export function createEventExplorerModel(options: ExplorerOptions) {
  const { projectId, client } = options;
  if (typeof projectId !== 'string' || !/\S/.test(projectId))
    throw new TypeError('A selected project is required');
  let state: Readonly<ExplorerState> = Object.freeze({
    query: pickQuery(options.initialQuery),
    page: undefined,
    count: undefined,
    visitors: undefined,
    cursor: undefined,
    pageIndex: 1,
    loading: false,
    closed: false,
    eventsError: undefined,
    countError: undefined,
    visitorError: undefined,
  });
  const listeners = new Set<() => void>();
  let revision = 0;
  let pending: AbortController | undefined;
  function emit(next: ExplorerState) {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  }
  async function load(
    input: ExplorerQuery,
    cursor: string | undefined,
    pageIndex: number,
    recount: boolean,
    reset: boolean,
  ) {
    if (state.closed) return;
    const query = pickQuery(input);
    const requestId = ++revision;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    emit({
      ...state,
      query,
      loading: true,
      eventsError: undefined,
      countError: recount ? undefined : state.countError,
      visitorError: recount ? undefined : state.visitorError,
      ...(reset
        ? {
            page: undefined,
            count: undefined,
            visitors: undefined,
            cursor: undefined,
            pageIndex: 1,
          }
        : {}),
    });
    function watch<T>(promise: Promise<T>): Promise<T> {
      return promise.catch((error: unknown) => {
        const kind = classify(error);
        if (
          !state.closed &&
          requestId === revision &&
          (kind === 'sign_in' || kind === 'forbidden')
        ) {
          revision++;
          pending = undefined;
          controller.abort();
          emit({
            ...state,
            page: undefined,
            count: undefined,
            visitors: undefined,
            cursor: undefined,
            pageIndex: 1,
            loading: false,
            eventsError: kind,
            countError: kind,
            visitorError: kind,
          });
        }
        throw error;
      });
    }
    const pagePromise = watch(
      (async () =>
        client.listEvents(
          { ...query, projectId, limit: 50, ...(cursor === undefined ? {} : { cursor }) },
          controller.signal,
        ))(),
    );
    const countPromise = watch(
      (async () =>
        recount ? client.countEvents({ ...query, projectId }, controller.signal) : undefined)(),
    );
    const visitorPromise = watch(
      (async () =>
        recount && client.countVisitors
          ? client.countVisitors({ ...query, projectId }, controller.signal)
          : undefined)(),
    );
    const [events, count, visitors] = await Promise.allSettled([
      pagePromise,
      countPromise,
      visitorPromise,
    ]);
    if (state.closed || requestId !== revision) return;
    pending = undefined;
    const eventsError = events.status === 'rejected' ? classify(events.reason) : undefined;
    const countError =
      count.status === 'rejected' ? classify(count.reason) : recount ? undefined : state.countError;
    emit({
      ...state,
      loading: false,
      eventsError,
      countError,
      visitorError:
        visitors.status === 'rejected'
          ? classify(visitors.reason)
          : recount
            ? undefined
            : state.visitorError,
      ...(events.status === 'fulfilled' ? { page: events.value, cursor, pageIndex } : {}),
      ...(count.status === 'fulfilled' && count.value !== undefined
        ? { count: count.value.count }
        : {}),
      ...(visitors.status === 'fulfilled' && visitors.value !== undefined
        ? { visitors: visitors.value.count }
        : {}),
    });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      if (!state.closed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    apply(query: ExplorerQuery) {
      return load(query, undefined, 1, true, true);
    },
    refresh() {
      return load(state.query, state.cursor, state.pageIndex, true, false);
    },
    async next() {
      if (state.loading || !state.page?.hasMore) return;
      await load(state.query, state.page.nextCursor, state.pageIndex + 1, false, false);
    },
    async first() {
      if (state.loading || state.pageIndex === 1) return;
      await load(state.query, undefined, 1, false, false);
    },
    cancel() {
      if (state.closed) return;
      revision++;
      pending?.abort();
      pending = undefined;
      emit({ ...state, loading: false, page: undefined, count: undefined, visitors: undefined });
    },
    close() {
      if (state.closed) return;
      revision++;
      pending?.abort();
      pending = undefined;
      state = Object.freeze({
        ...state,
        closed: true,
        loading: false,
        page: undefined,
        count: undefined,
        visitors: undefined,
      });
      listeners.clear();
    },
  };
}
