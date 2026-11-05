import assert from 'node:assert/strict';
import { createClickHouseBatchWriter } from '../../workers/event-processor/dist/index.js';

/** Uses only the owned analytics-read fixture's disposable ClickHouse instance. */
export async function exerciseVisitorReads(connection, reader, window) {
  let sequence = 0;
  const records = [];
  function add(
    projectId,
    distinctId,
    identity,
    eventName = 'viewed',
    receivedAt = '2026-10-01T12:00:00.000Z',
  ) {
    records.push({
      projectId,
      receivedAt,
      event: {
        schemaVersion: 1,
        eventId: `visitor-${sequence}`,
        eventName,
        distinctId,
        sessionId: 'visitor-session',
        sequence: sequence++,
        clientTimestamp: receivedAt,
        url: 'https://probe.invalid/',
        properties: {},
        context: { sdkVersion: 'visitor-probe', ...(identity ? { identity } : {}) },
      },
    });
  }
  const link = (project, anon, user) =>
    add(
      project,
      user,
      { kind: 'link', anonymousId: anon, userId: user },
      '$identify',
      '2026-10-03T12:00:00.000Z',
    );
  add('visitors', 'anon-a');
  add('visitors', 'anon-b');
  add('visitors', 'unrelated');
  add('visitors', 'customer', { kind: 'identified', anonymousId: 'anon-a', userId: 'customer' });
  link('visitors', 'anon-a', 'customer');
  link('visitors', 'anon-b', 'customer');
  link('foreign-visitors', 'unrelated', 'customer');
  add('conflicted-visitors', 'anon');
  add('conflicted-visitors', 'a', { kind: 'identified', anonymousId: 'anon', userId: 'a' });
  add('conflicted-visitors', 'b', { kind: 'identified', anonymousId: 'anon', userId: 'b' });
  add('collision-visitors', 'same-id');
  add('collision-visitors', 'same-id', {
    kind: 'identified',
    anonymousId: 'other-anon',
    userId: 'same-id',
  });
  link('collision-visitors', 'same-id', 'different-user');
  link('collision-visitors', 'other-anon', 'same-id');
  link('control-only-visitors', 'control-anon', 'control-user');
  const write = createClickHouseBatchWriter(connection);
  await write(records);
  await write(records); // Replayed links and events must not change the answer.
  const counts = {};
  for (const [projectId, expected] of [
    ['visitors', '2'],
    ['conflicted-visitors', '3'],
    ['collision-visitors', '2'],
    ['control-only-visitors', '0'],
  ]) {
    counts[projectId] = await reader.countReceivedVisitors({ ...window, projectId });
    assert.deepEqual(counts[projectId], { count: expected });
  }
  assert.deepEqual(
    await reader.countReceivedVisitors({
      ...window,
      projectId: 'visitors',
      eventName: 'viewed',
      sessionId: 'visitor-session',
    }),
    { count: '2' },
  );
  assert.deepEqual(await reader.countReceivedEvents({ ...window, projectId: 'visitors' }), {
    count: '4',
  });
  const afterLinks = {
    from: '2026-10-03T00:00:00Z',
    to: '2026-10-04T00:00:00Z',
    projectId: 'visitors',
  };
  assert.deepEqual(await reader.countReceivedEvents(afterLinks), { count: '0' });
  assert.deepEqual((await reader.listReceivedEvents(afterLinks)).events, []);
  return {
    passed: true,
    counts,
    retroactiveOutsideWindowLinks: true,
    projectIsolation: true,
    conflictingLinksRemainAnonymous: true,
    namespacedOneHopResolution: true,
    replayDeduplication: true,
    controlEventsExcluded: true,
  };
}
