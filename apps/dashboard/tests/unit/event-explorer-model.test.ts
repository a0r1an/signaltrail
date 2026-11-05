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
    countReceivedEvents: vi.fn<ExplorerClient['countReceivedEvents']>(async () => ({
      count: '18446744073709551615',
    })),
    listReceivedEvents: vi.fn<ExplorerClient['listReceivedEvents']>(async () => page),
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
  expect(client.countReceivedEvents).toHaveBeenCalledWith(
    { ...query, projectId: 'trusted-project' },
    expect.any(AbortSignal),
  );
  expect(client.listReceivedEvents).toHaveBeenCalledWith(
    { ...query, projectId: 'trusted-project', limit: 50 },
    expect.any(AbortSignal),
  );
});

it('pages with opaque cursors and resets to first without recounting', async () => {
  const { client, model } = fixture();
  await model.apply(query);
  client.listReceivedEvents.mockResolvedValueOnce({
    events: [{ ...event, eventId: 'event-a' }],
    hasMore: false,
  });
  await model.next();
  expect(model.getSnapshot()).toMatchObject({
    pageIndex: 2,
    cursor: 'next-cursor',
    page: { hasMore: false },
  });
  expect(client.listReceivedEvents.mock.calls[1]![0]).toMatchObject({
    cursor: 'next-cursor',
    projectId: 'trusted-project',
  });
  await model.next();
  expect(client.listReceivedEvents).toHaveBeenCalledTimes(2);
  await model.first();
  expect(model.getSnapshot()).toMatchObject({ pageIndex: 1, cursor: undefined });
  expect(client.countReceivedEvents).toHaveBeenCalledTimes(1);
});

it('clears existing data after session or membership denial on refresh', async () => {
  const { client, model } = fixture();
  await model.apply(query);
  client.countReceivedEvents.mockRejectedValueOnce({ status: 403, message: 'private' });
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
  client.countReceivedEvents.mockRejectedValueOnce(new Error('private error'));
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
  client.listReceivedEvents.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPage = resolve;
      }),
  );
  client.countReceivedEvents.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCount = resolve;
      }),
  );
  const old = model.apply(query);
  const newQuery = { ...query, eventName: 'new-event' };
  await model.apply(newQuery);
  expect(client.listReceivedEvents.mock.calls[0]![1]!.aborted).toBe(true);
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
  client.listReceivedEvents.mockRejectedValueOnce(new Error('private storage detail'));
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
  client.listReceivedEvents.mockImplementationOnce(
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
  expect(client.listReceivedEvents.mock.calls[0]![1]!.aborted).toBe(true);
  expect(listener).toHaveBeenCalledTimes(notifications);
  expect(sharedClose).not.toHaveBeenCalled();
  expect(model.getSnapshot()).toMatchObject({
    closed: true,
    page: undefined,
    count: undefined,
    loading: false,
  });
  await model.apply(query);
  expect(client.listReceivedEvents).toHaveBeenCalledTimes(1);
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
  expect(client.listReceivedEvents.mock.calls[0]![0]).toEqual({
    ...query,
    eventName: ' original ',
    projectId: 'trusted-project',
    limit: 50,
  });
  expect(client.countReceivedEvents.mock.calls[0]![0]).toEqual({
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
  client.listReceivedEvents.mockRejectedValueOnce({ status: 401 });
  client.countReceivedEvents.mockImplementationOnce(
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
  expect(client.listReceivedEvents).toHaveBeenCalledTimes(2);
});

it('ignores authorization failures from an obsolete filter request', async () => {
  const { client, model } = fixture();
  let finishPage!: (value: typeof page) => void;
  let rejectCount!: (reason: unknown) => void;
  client.listReceivedEvents.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPage = resolve;
      }),
  );
  client.countReceivedEvents.mockImplementationOnce(
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
