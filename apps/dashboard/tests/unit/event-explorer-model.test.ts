import { expect, it, vi } from 'vitest';
import {
  createEventExplorerModel,
  type ExplorerClient,
} from '../../src/features/event-explorer/model';

const query = { from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' };
const event = {
  eventId: 'event-z',
  eventName: 'viewed',
  sessionId: 'session',
  sequence: '0',
  receivedAt: '2026-11-01T12:00:00.000Z',
};
const page = { events: [event], hasMore: true as const, nextCursor: 'next-cursor' };
function fixture() {
  const client = {
    countEvents: vi.fn<ExplorerClient['countEvents']>(async () => ({
      count: '18446744073709551615',
    })),
    listEvents: vi.fn<ExplorerClient['listEvents']>(async () => page),
  };
  return {
    client,
    model: createEventExplorerModel({ projectId: 'trusted-project', initialQuery: query, client }),
  };
}

it('loads an exact count and first page under the fixed authorized project', async () => {
  const { client, model } = fixture();
  await model.apply(query);
  expect(model.getSnapshot()).toMatchObject({
    count: '18446744073709551615',
    page,
    pageIndex: 1,
    loading: false,
  });
  expect(client.countEvents).toHaveBeenCalledWith(
    { ...query, projectId: 'trusted-project' },
    expect.any(AbortSignal),
  );
  expect(client.listEvents).toHaveBeenCalledWith(
    { ...query, projectId: 'trusted-project', limit: 50 },
    expect.any(AbortSignal),
  );
});

it('pages with opaque cursors and resets to first without recounting', async () => {
  const { client, model } = fixture();
  await model.apply(query);
  client.listEvents.mockResolvedValueOnce({
    events: [{ ...event, eventId: 'event-a' }],
    hasMore: false,
  });
  await model.next();
  expect(model.getSnapshot()).toMatchObject({
    pageIndex: 2,
    cursor: 'next-cursor',
    page: { hasMore: false },
  });
  expect(client.listEvents.mock.calls[1]![0]).toMatchObject({
    cursor: 'next-cursor',
    projectId: 'trusted-project',
  });
  await model.next();
  expect(client.listEvents).toHaveBeenCalledTimes(2);
  await model.first();
  expect(model.getSnapshot()).toMatchObject({ pageIndex: 1, cursor: undefined });
  expect(client.countEvents).toHaveBeenCalledTimes(1);
});

it('clears existing data after session or membership denial on refresh', async () => {
  const { client, model } = fixture();
  await model.apply(query);
  client.countEvents.mockRejectedValueOnce({ status: 403, message: 'private' });
  await model.refresh();
  expect(model.getSnapshot()).toMatchObject({
    page: undefined,
    count: undefined,
    eventsError: 'forbidden',
    countError: 'forbidden',
  });
});

it('keeps valid events available when only the count fails', async () => {
  const { client, model } = fixture();
  client.countEvents.mockRejectedValueOnce(new Error('private error'));
  await model.apply(query);
  expect(model.getSnapshot()).toMatchObject({
    page,
    count: undefined,
    countError: 'unavailable',
    eventsError: undefined,
  });
});

it('ignores stale results and aborts old work when filters change', async () => {
  const { client, model } = fixture();
  let finishPage!: (value: typeof page) => void;
  let finishCount!: (value: { count: string }) => void;
  client.listEvents.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPage = resolve;
      }),
  );
  client.countEvents.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCount = resolve;
      }),
  );
  const old = model.apply(query);
  const newQuery = { ...query, eventName: 'new-event' };
  await model.apply(newQuery);
  expect(client.listEvents.mock.calls[0]![1]!.aborted).toBe(true);
  finishPage({ ...page, events: [{ ...event, eventId: 'old-event' }] });
  finishCount({ count: '1' });
  await old;
  expect(model.getSnapshot()).toMatchObject({
    query: newQuery,
    page,
    count: '18446744073709551615',
  });
});

it('retains the current page and position when a later page fails', async () => {
  const { client, model } = fixture();
  await model.apply(query);
  client.listEvents.mockRejectedValueOnce(new Error('private storage detail'));
  await model.next();
  expect(model.getSnapshot()).toMatchObject({
    page,
    pageIndex: 1,
    cursor: undefined,
    eventsError: 'unavailable',
    loading: false,
  });
});

it('disposes owned requests and subscriptions without closing the shared client', async () => {
  const { client, model } = fixture();
  const sharedClose = vi.fn();
  const listener = vi.fn();
  Object.assign(client, { close: sharedClose });
  model.subscribe(listener);
  let finish!: (value: typeof page) => void;
  client.listEvents.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = model.apply(query);
  model.close();
  const notifications = listener.mock.calls.length;
  finish(page);
  await pending;
  expect(client.listEvents.mock.calls[0]![1]!.aborted).toBe(true);
  expect(listener).toHaveBeenCalledTimes(notifications);
  expect(sharedClose).not.toHaveBeenCalled();
  expect(model.getSnapshot()).toMatchObject({
    closed: true,
    page: undefined,
    count: undefined,
    loading: false,
  });
  await model.apply(query);
  expect(client.listEvents).toHaveBeenCalledTimes(1);
});

it('snapshots filter values and excludes caller-supplied project or cursor overrides', async () => {
  const { client, model } = fixture();
  const mutable = {
    ...query,
    eventName: ' original ',
    projectId: 'forged',
    cursor: 'forged',
    limit: 100,
  };
  const loading = model.apply(mutable);
  mutable.eventName = 'changed';
  await loading;
  expect(client.listEvents.mock.calls[0]![0]).toEqual({
    ...query,
    eventName: ' original ',
    projectId: 'trusted-project',
    limit: 50,
  });
  expect(client.countEvents.mock.calls[0]![0]).toEqual({
    ...query,
    eventName: ' original ',
    projectId: 'trusted-project',
  });
  expect(model.getSnapshot().query.eventName).toBe(' original ');
});

it('clears data immediately after authorization denial while a sibling request is still pending', async () => {
  const { client, model } = fixture();
  await model.apply(query);
  let finish!: (value: { count: string }) => void;
  client.listEvents.mockRejectedValueOnce({ status: 401 });
  client.countEvents.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const loading = model.refresh();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(model.getSnapshot()).toMatchObject({
    page: undefined,
    count: undefined,
    eventsError: 'sign_in',
    loading: false,
  });
  finish({ count: 'late' });
  await loading;
  expect(model.getSnapshot().count).toBeUndefined();
});

it('can cancel and reload the same model for React effect replay', async () => {
  const { client, model } = fixture();
  await model.apply(query);
  model.cancel();
  expect(model.getSnapshot()).toMatchObject({ closed: false, loading: false, page: undefined });
  await model.apply(query);
  expect(model.getSnapshot()).toMatchObject({ page, loading: false, closed: false });
  expect(client.listEvents).toHaveBeenCalledTimes(2);
});

it('ignores authorization failures from an obsolete filter request', async () => {
  const { client, model } = fixture();
  let finishPage!: (value: typeof page) => void;
  let rejectCount!: (reason: unknown) => void;
  client.listEvents.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPage = resolve;
      }),
  );
  client.countEvents.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectCount = reject;
      }),
  );
  const old = model.apply(query);
  await model.apply({ ...query, eventName: 'current' });
  finishPage(page);
  rejectCount({ status: 401 });
  await old;
  expect(model.getSnapshot()).toMatchObject({
    page,
    count: '18446744073709551615',
    eventsError: undefined,
  });
});
it('loads visitor totals without recounting them for cursor-only navigation', async () => {
  const countVisitors = vi.fn(async () => ({ count: '9007199254740993' }));
  const base = fixture();
  const client = { ...base.client, countVisitors };
  const model = createEventExplorerModel({
    projectId: 'trusted-project',
    initialQuery: query,
    client,
  });
  await model.apply(query);
  expect(model.getSnapshot()).toMatchObject({ visitors: '9007199254740993' });
  await model.next();
  expect(countVisitors).toHaveBeenCalledTimes(1);
  expect(countVisitors).toHaveBeenCalledWith(
    { ...query, projectId: 'trusted-project' },
    expect.any(AbortSignal),
  );
});
it('keeps event data and totals usable when only visitor counting fails', async () => {
  const base = fixture();
  const model = createEventExplorerModel({
    projectId: 'trusted-project',
    initialQuery: query,
    client: {
      ...base.client,
      countVisitors: async () => {
        throw new Error('private detail');
      },
    },
  });
  await model.apply(query);
  expect(model.getSnapshot()).toMatchObject({
    page,
    count: '18446744073709551615',
    visitors: undefined,
    visitorError: 'unavailable',
    eventsError: undefined,
    countError: undefined,
  });
});
it('clears all event and visitor data when the visitor request reports revoked access', async () => {
  const base = fixture(),
    countVisitors = vi.fn(async () => ({ count: '1' }));
  const model = createEventExplorerModel({
    projectId: 'trusted-project',
    initialQuery: query,
    client: { ...base.client, countVisitors },
  });
  await model.apply(query);
  countVisitors.mockRejectedValueOnce({ status: 403 });
  await model.refresh();
  expect(model.getSnapshot()).toMatchObject({
    page: undefined,
    count: undefined,
    visitors: undefined,
    eventsError: 'forbidden',
    countError: 'forbidden',
    visitorError: 'forbidden',
  });
});
