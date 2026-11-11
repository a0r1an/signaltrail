import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClickHouseBatchWriter } from '../../workers/event-processor/dist/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Uses only the owned analytics-read fixture's disposable ClickHouse instance. */
export async function exerciseRetention(connection) {
  const query = async (sql) => {
    const response = await fetch(`${connection.endpoint}/?wait_end_of_query=1`, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': connection.username,
        'X-ClickHouse-Key': connection.password,
      },
      body: sql,
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body.slice(0, 500));
    return body;
  };
  await query(
    await readFile(
      new URL('../../infra/clickhouse/002-analytics-retention.sql', import.meta.url),
      'utf8',
    ),
  );
  const definition = await query('SHOW CREATE TABLE signaltrail.analytics_events FORMAT TSVRaw');
  assert.match(definition, /TTL toDateTime\(received_at\) \+ toIntervalDay\(90\)/);
  // Reapplying the migration must be harmless.
  await query(
    await readFile(
      new URL('../../infra/clickhouse/002-analytics-retention.sql', import.meta.url),
      'utf8',
    ),
  );
  const now = Date.now();
  const at = (days) => new Date(now - days * DAY_MS).toISOString();
  const record = (eventId, receivedAt) => ({
    projectId: 'retention',
    receivedAt,
    event: {
      schemaVersion: 1,
      eventId,
      eventName: 'retention_probe',
      distinctId: 'visitor',
      sessionId: 'session',
      sequence: 0,
      clientTimestamp: receivedAt,
      url: 'https://probe.invalid',
      properties: {},
      context: { sdkVersion: 'retention-probe' },
    },
  });
  const write = createClickHouseBatchWriter(connection);
  await write([record('expired', at(91)), record('kept', at(89))]);
  // A retry of a retained event arrives later; dedupe must still yield one row.
  await write([record('kept', at(1)), record('recent', at(0))]);
  await query(
    'ALTER TABLE signaltrail.analytics_events MATERIALIZE TTL SETTINGS mutations_sync = 2',
  );
  await query('OPTIMIZE TABLE signaltrail.analytics_events FINAL');
  const rows = async (final) =>
    Object.fromEntries(
      (
        await query(
          `SELECT event_id, toString(count()) AS c FROM signaltrail.analytics_events${final ? ' FINAL' : ''} WHERE project_id = 'retention' GROUP BY event_id FORMAT JSONEachRow`,
        )
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const { event_id, c } = JSON.parse(line);
          return [event_id, c];
        }),
    );
  const unique = await rows(true);
  const physical = await rows(false);
  assert.deepEqual(unique, { kept: '1', recent: '1' });
  assert.deepEqual(physical, { kept: '1', recent: '1' });
  return {
    retentionDays: 90,
    expression: 'toDateTime(received_at) + INTERVAL 90 DAY DELETE',
    expiredRemoved: true,
    retainedRetryDeduplicated: true,
    uniqueRows: unique,
    physicalRowsAfterMerge: physical,
  };
}
