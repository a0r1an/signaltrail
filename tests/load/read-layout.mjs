import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createAnalyticsReader } from '../../packages/analytics/dist/index.js';
import { createClickHouseBatchWriter } from '../../workers/event-processor/dist/index.js';
import { ANALYTICS_SCHEMA, applyClickHouseSchema } from './clickhouse-schema.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const SKIP_DAYS = 60;
const SKIP_ROWS_PER_DAY = 20000;

/**
 * Uses only the owned analytics-read fixture's disposable ClickHouse instance. Runs before the
 * other read checks: links stored before migration 003 must be backfilled.
 */
export async function exerciseReadLayout(connection) {
  const query = async (sql, user = connection) => {
    const response = await fetch(`${connection.endpoint}/?wait_end_of_query=1`, {
      method: 'POST',
      headers: { 'X-ClickHouse-User': user.username, 'X-ClickHouse-Key': user.password },
      body: sql,
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body.slice(0, 500));
    return body;
  };
  const linkRecord = (projectId, eventId, anonymousId, userId, receivedAt) => ({
    projectId,
    receivedAt,
    event: {
      schemaVersion: 1,
      eventId,
      eventName: '$identify',
      distinctId: userId,
      sessionId: 'layout-session',
      sequence: 0,
      clientTimestamp: receivedAt,
      url: 'https://probe.invalid/',
      properties: {},
      context: { sdkVersion: 'layout-probe', identity: { kind: 'link', anonymousId, userId } },
    },
  });
  const viewRecord = (projectId, eventId, distinctId, receivedAt) => ({
    projectId,
    receivedAt,
    event: {
      schemaVersion: 1,
      eventId,
      eventName: 'viewed',
      distinctId,
      sessionId: 'layout-session',
      sequence: 1,
      clientTimestamp: receivedAt,
      url: 'https://probe.invalid/',
      properties: {},
      context: { sdkVersion: 'layout-probe' },
    },
  });

  // Base table only, with history written before the read layout existed.
  await applyClickHouseSchema(query, ['001-analytics-events.sql']);
  const at = '2026-10-01T12:00:00.000Z';
  await createClickHouseBatchWriter(connection)([
    linkRecord('layout-backfill', 'before-link', 'anon-before', 'user-before', at),
    viewRecord('layout-backfill', 'before-view', 'anon-before', at),
  ]);
  await applyClickHouseSchema(query, ANALYTICS_SCHEMA);
  await applyClickHouseSchema(query, ANALYTICS_SCHEMA); // Reapplying must be harmless.

  const definition = await query('SHOW CREATE TABLE signaltrail.analytics_events FORMAT TSVRaw');
  for (const fragment of [
    "`occurred_at` Nullable(DateTime64(3, 'UTC')) MATERIALIZED",
    'INDEX received_at_minmax received_at TYPE minmax GRANULARITY 1',
    'INDEX occurred_at_minmax occurred_at TYPE minmax GRANULARITY 1',
  ])
    assert.ok(definition.includes(fragment), fragment);
  const links = async (projectId, final = false) =>
    (
      await query(
        `SELECT event_id, anonymous_id, user_id FROM signaltrail.analytics_identity_links${final ? ' FINAL' : ''} WHERE project_id = '${projectId}' ORDER BY event_id FORMAT JSONCompactEachRow`,
      )
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  // Backfilled exactly once despite the migration running twice.
  assert.deepEqual(await links('layout-backfill'), [['before-link', 'anon-before', 'user-before']]);

  // Production identities: the processor may only INSERT events, the reader only SELECT.
  const suffix = randomBytes(4).toString('hex');
  const processor = {
    username: `layout_processor_${suffix}`,
    password: randomBytes(16).toString('hex'),
  };
  const readerUser = {
    username: `layout_reader_${suffix}`,
    password: randomBytes(16).toString('hex'),
  };
  await query(
    `CREATE USER ${processor.username} IDENTIFIED WITH sha256_password BY '${processor.password}'`,
  );
  await query(`GRANT INSERT ON signaltrail.analytics_events TO ${processor.username}`);
  await query(
    `CREATE USER ${readerUser.username} IDENTIFIED WITH sha256_password BY '${readerUser.password}'`,
  );
  await query(
    `GRANT SELECT ON signaltrail.analytics_events, SELECT ON signaltrail.analytics_identity_links TO ${readerUser.username}`,
  );
  const processorWrite = createClickHouseBatchWriter({ ...connection, ...processor });
  const later = '2026-10-01T13:00:00.000Z';
  const afterBatch = [
    linkRecord('layout-backfill', 'after-link', 'anon-after', 'user-before', later),
    viewRecord('layout-backfill', 'after-view', 'anon-after', later),
  ];
  await processorWrite(afterBatch);
  await processorWrite(afterBatch); // Replay.
  assert.deepEqual(await links('layout-backfill', true), [
    ['after-link', 'anon-after', 'user-before'],
    ['before-link', 'anon-before', 'user-before'],
  ]);
  const restrictedReader = createAnalyticsReader({ ...connection, ...readerUser });
  const day = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' };
  // Both anonymous IDs resolve to the same user through backfilled and view-inserted links.
  assert.deepEqual(
    await restrictedReader.countOccurredVisitors({ ...day, projectId: 'layout-backfill' }),
    { count: '1' },
  );
  assert.deepEqual(
    await restrictedReader.countReceivedVisitors({ ...day, projectId: 'layout-backfill' }),
    { count: '1' },
  );

  // Data skipping: one part of time-ordered rows across 60 days.
  const end = Date.parse('2026-09-01T00:00:00.000Z');
  await query(`INSERT INTO signaltrail.analytics_events
    SELECT 'layout-skip',
      concat(substring(h, 1, 8), '-', substring(h, 9, 4), '-7', substring(r, 1, 3), '-8', substring(r, 4, 3), '-', substring(r, 7, 12)),
      t, concat(replaceOne(toString(t), ' ', 'T'), 'Z'), 'viewed',
      concat('visitor-', toString(d), '-', toString(n % 100)), concat('session-', toString(d), '-', toString(n % 100)),
      n, 'https://probe.invalid/', '{}', '{}'
    FROM (
      SELECT intDiv(number, ${SKIP_ROWS_PER_DAY}) AS d, number % ${SKIP_ROWS_PER_DAY} AS n,
        fromUnixTimestamp64Milli(toInt64(${end} - (d + 1) * ${DAY_MS} + n * 4000), 'UTC') AS t,
        leftPad(lower(hex(toUnixTimestamp64Milli(t))), 12, '0') AS h,
        leftPad(lower(hex(sipHash64(number))), 18, '0') AS r
      FROM numbers(${SKIP_DAYS * SKIP_ROWS_PER_DAY})
    )`);
  const runId = randomBytes(6).toString('hex');
  let attempt = 0;
  const queryIds = {};
  const tagged = (kind) =>
    createAnalyticsReader({
      ...connection,
      ...readerUser,
      fetch: (url, init) => {
        const target = new URL(url);
        target.searchParams.set(
          'query_id',
          (queryIds[kind] = `layout-${runId}-${kind}-${attempt++}`),
        );
        return fetch(target, init);
      },
    });
  const oneDay = {
    projectId: 'layout-skip',
    from: new Date(end - 2 * DAY_MS).toISOString(),
    to: new Date(end - DAY_MS).toISOString(),
  };
  const results = {
    occurredCount: await tagged('occurredCount').countOccurredEvents(oneDay),
    receivedCount: await tagged('receivedCount').countReceivedEvents(oneDay),
    occurredList: (await tagged('occurredList').listOccurredEvents({ ...oneDay, limit: 5 })).events
      .length,
    occurredVisitors: await tagged('occurredVisitors').countOccurredVisitors(oneDay),
  };
  assert.deepEqual(results, {
    occurredCount: { count: String(SKIP_ROWS_PER_DAY) },
    receivedCount: { count: String(SKIP_ROWS_PER_DAY) },
    occurredList: 5,
    occurredVisitors: { count: '100' },
  });
  await query('SYSTEM FLUSH LOGS');
  const readRows = {};
  for (const [kind, queryId] of Object.entries(queryIds)) {
    const value = (
      await query(
        `SELECT read_rows FROM system.query_log WHERE query_id = '${queryId}' AND type = 'QueryFinish' FORMAT TSV`,
      )
    ).trim();
    assert.ok(value, `missing query log for ${kind}`);
    readRows[kind] = Number(value);
  }
  const totalRows = SKIP_DAYS * SKIP_ROWS_PER_DAY;
  // One day is 1/60 of the rows; allow granule overlap but require skipping most of the data.
  for (const [kind, value] of Object.entries(readRows))
    assert.ok(value < totalRows / 4, `${kind} read ${value} of ${totalRows} rows`);
  await query(`DROP USER ${processor.username}`);
  await query(`DROP USER ${readerUser.username}`);
  return {
    passed: true,
    backfilledOnceAcrossReapply: true,
    insertOnlyProcessorFeedsLinks: true,
    replayedLinksDeduplicated: true,
    readerNeedsOnlySelect: true,
    skipRows: { total: totalRows, read: readRows },
  };
}
