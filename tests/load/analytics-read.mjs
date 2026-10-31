import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createAnalyticsReader,
  createAnalyticsQueryHandler,
} from '../../packages/analytics/dist/index.js';
import { createClickHouseBatchWriter } from '../../workers/event-processor/dist/index.js';

export async function exerciseAnalyticsReads({ directory }) {
  const connection = {
    endpoint: 'http://127.0.0.1:38123',
    username: 'signaltrail',
    password: 'signaltrail_local',
  };
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { 'X-ClickHouse-User': connection.username, 'X-ClickHouse-Key': connection.password },
    body: await readFile(
      new URL('../../infra/clickhouse/001-analytics-events.sql', import.meta.url),
      'utf8',
    ),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).trim(), '');
  const reader = createAnalyticsReader({
    ...connection,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (
        response.status !== 200 ||
        ![null, '0'].includes(response.headers.get('X-ClickHouse-Exception-Code'))
      )
        await writeFile(
          directory + '/analytics-read-diagnostic.json',
          JSON.stringify(
            {
              status: response.status,
              code: response.headers.get('X-ClickHouse-Exception-Code'),
              fixtureError: (await response.clone().text()).slice(0, 1000),
            },
            null,
            2,
          ),
        );
      return response;
    },
  });
  const window = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' };
  assert.deepEqual(await reader.countReceivedEvents({ ...window, projectId: 'a' }), { count: '0' });
  const event = {
    schemaVersion: 1,
    eventId: 'placeholder',
    eventName: 'read_probe',
    distinctId: 'visitor',
    sessionId: 'session',
    sequence: 0,
    clientTimestamp: '2026-10-01T12:00:00.000Z',
    url: 'https://probe.invalid',
    properties: {},
    context: { sdkVersion: 'read-probe' },
  };
  const data = [
    ['a', 'repeated', '2026-10-01T12:00:00.000Z'],
    ['a', 'repeated', '2026-10-02T12:00:00.000Z'],
    ['a', 'start', window.from],
    ['a', 'end', window.to],
    ['b', 'repeated', '2026-10-01T12:00:00.000Z'],
    ['literal\\n', 'one', '2026-10-01T12:00:00.000Z'],
    ['literal\\n', 'two', '2026-10-01T12:00:00.000Z'],
    ['literal\n', 'one', '2026-10-01T12:00:00.000Z'],
    ['listing', 'event-z', window.from],
    ['listing', 'event-a', window.from],
    ['listing', 'newest', '2026-10-01T12:00:00.000Z'],
    ['listing', 'moved', window.from],
    ['listing', 'moved', '2026-10-02T12:00:00.000Z'],
  ];
  await createClickHouseBatchWriter(connection)(
    data.map(([projectId, eventId, receivedAt]) => ({
      projectId,
      receivedAt,
      event: { ...event, eventId },
    })),
  );
  const counts = {};
  for (const [projectId, expected] of [
    ['a', '1'],
    ['b', '1'],
    ['missing', '0'],
    ['literal\\n', '2'],
    ['literal\n', '1'],
    ["a' OR 1=1 --", '0'],
  ]) {
    const result = await reader.countReceivedEvents({ ...window, projectId });
    assert.equal(result.count, expected);
    counts[projectId] = result.count;
  }
  assert.deepEqual(
    await reader.countReceivedEvents({
      projectId: 'a',
      from: window.to,
      to: '2026-10-03T00:00:00.000Z',
    }),
    { count: '2' },
  );
  assert.deepEqual(
    await reader.countReceivedEvents({
      projectId: 'a',
      from: window.from,
      to: '2026-10-03T00:00:00.000Z',
    }),
    { count: '3' },
  );
  let reads = 0;
  const summaries = await reader.listReceivedEvents({ ...window, projectId: 'listing', limit: 2 });
  assert.deepEqual(
    summaries.events.map((event) => event.eventId),
    ['newest', 'event-z'],
  );
  assert.equal(summaries.hasMore, true);
  assert.equal(summaries.events[1].receivedAt, window.from);
  const allSummaries = await reader.listReceivedEvents({
    ...window,
    projectId: 'listing',
    limit: 100,
  });
  assert.deepEqual(
    allSummaries.events.map((event) => event.eventId),
    ['newest', 'event-z', 'event-a'],
  );
  assert.equal(allSummaries.hasMore, false);
  const paged = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const result = await reader.listReceivedEvents({
      ...window,
      projectId: 'listing',
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    paged.push(...result.events.map((event) => event.eventId));
    if (!result.hasMore) {
      assert.equal(result.nextCursor, undefined);
      break;
    }
    assert.equal(typeof result.nextCursor, 'string');
    cursor = result.nextCursor;
  }
  assert.deepEqual(paged, ['newest', 'event-z', 'event-a']);
  assert.deepEqual(await reader.listReceivedEvents({ ...window, projectId: 'missing' }), {
    events: [],
    hasMore: false,
  });
  const handler = createAnalyticsQueryHandler({
    resolveProjectAccess: async (request, projectId) => {
      if (request.headers.get('Authorization') !== 'Bearer fixture-dashboard-session')
        return { status: 'unauthenticated' };
      return projectId === 'a' ? { status: 'authorized', projectId: 'a' } : { status: 'forbidden' };
    },
    countReceivedEvents: async (window, signal) => {
      reads++;
      return reader.countReceivedEvents(window, signal);
    },
  });
  const query = new URL('https://fixture.invalid/v1/analytics/count');
  for (const [key, value] of Object.entries({ ...window, projectId: 'a' }))
    query.searchParams.set(key, value);
  assert.equal(
    (
      await handler(
        new Request(query, { headers: { Authorization: 'Bearer fixture-ingestion-key' } }),
      )
    ).status,
    401,
  );
  query.searchParams.set('projectId', 'b');
  assert.equal(
    (
      await handler(
        new Request(query, { headers: { Authorization: 'Bearer fixture-dashboard-session' } }),
      )
    ).status,
    403,
  );
  assert.equal(reads, 0);
  query.searchParams.set('projectId', 'a');
  const authorized = await handler(
    new Request(query, { headers: { Authorization: 'Bearer fixture-dashboard-session' } }),
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { count: '1' });
  assert.equal(reads, 1);
  return {
    passed: true,
    counts,
    halfOpenWindow: true,
    latestVersionBeforeTimeFilter: true,
    exactProjectBytes: true,
    authorizedQueryBoundary: true,
    boundedEventListing: true,
    keysetPagingAcrossTimestampTies: true,
    limitations: [
      'Server-side read library only; no query HTTP endpoint or membership authentication is deployed.',
      'Counts use latest received time, not client event time.',
    ],
  };
}
