import assert from 'node:assert/strict';
import { createClickHouseBatchWriter } from '../../workers/event-processor/dist/index.js';

export async function exerciseEventTimeReads(connection, reader, window) {
  const make = (id, clientTimestamp, receivedAt = '2026-10-01T12:00:00Z') => ({
    projectId: 'event-time',
    receivedAt,
    event: {
      schemaVersion: 1,
      eventId: id,
      eventName: 'event_time_probe',
      distinctId: 'anonymous',
      sessionId: 'time-session',
      sequence: 0,
      clientTimestamp,
      url: 'https://probe.invalid/',
      properties: {},
      context: { sdkVersion: 'event-time-probe' },
    },
  });
  const write = createClickHouseBatchWriter(connection);
  const records = [
    make('late', '2026-10-01T12:00:00Z', '2026-10-02T12:00:00Z'),
    make('replayed', '2026-10-01T13:00:00Z'),
    make('future', '2026-10-02T13:00:00Z'),
    make('start', window.from, '2026-10-02T12:00:00Z'),
    make('end', window.to),
    make('ancient', '0001-01-01T00:00:00Z'),
    make('far-future', '9999-01-01T00:00:00Z'),
    make('legacy-invalid', 'invalid legacy string'),
  ];
  await write(records);
  await write([make('replayed', '2026-10-01T13:00:00Z', '2026-10-03T12:00:00Z')]);
  const control = make('identity-link', '2026-10-03T12:00:00Z', '2026-10-03T12:00:00Z');
  control.event.eventName = '$identify';
  control.event.distinctId = 'customer';
  control.event.context.identity = { kind: 'link', anonymousId: 'anonymous', userId: 'customer' };
  await write([control]);
  const scope = { ...window, projectId: 'event-time' };
  const occurred = await reader.countOccurredEvents(scope);
  assert.deepEqual(occurred, { count: '3' });
  assert.deepEqual(await reader.countOccurredVisitors(scope), { count: '1' });
  assert.deepEqual(await reader.countReceivedEvents(scope), { count: '5' });
  const listed = [];
  let cursor;
  do {
    const page = await reader.listOccurredEvents({
      ...scope,
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    listed.push(...page.events);
    cursor = page.nextCursor;
    if (cursor)
      await assert.rejects(
        reader.listReceivedEvents({ ...scope, cursor }),
        /does not match query scope/,
      );
  } while (cursor);
  assert.deepEqual(
    listed.map((event) => event.eventId),
    ['replayed', 'late', 'start'],
  );
  assert.equal(listed[0].occurredAt, '2026-10-01T13:00:00.000Z');
  assert.equal(listed[0].receivedAt, '2026-10-03T12:00:00.000Z');
  assert.deepEqual(await reader.countOccurredEvents({ ...scope, eventName: 'missing' }), {
    count: '0',
  });
  return {
    passed: true,
    occurred,
    received: { count: '5' },
    lateArrivalUsesClientTime: true,
    occurrencePagingWithReceivedDiagnostics: true,
    crossBasisCursorRejected: true,
    stableEventTimeAcrossRetry: true,
    halfOpenBoundary: true,
    invalidAndOutOfRangeStringsExcluded: true,
    identifiedVisitors: '1',
    limitations: ['Client clock accuracy and skew policy are not established by these reads.'],
  };
}
