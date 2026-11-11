import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANALYTICS_RETENTION,
  ANALYTICS_SCHEMA,
  clickhouseStatements,
  splitStatements,
} from './clickhouse-schema.mjs';

test('splits migration files into single HTTP statements and drops comment-only trailers', () => {
  assert.deepEqual(
    splitStatements('-- head\nSELECT 1;\n-- note; with semicolon\nSELECT 2;\n-- tail\n'),
    ['-- head\nSELECT 1', '-- note; with semicolon\nSELECT 2'],
  );
});

test('analytics schema applies the base table then the read layout; retention covers both tables', async () => {
  assert.deepEqual(ANALYTICS_SCHEMA, ['001-analytics-events.sql', '003-analytics-read-layout.sql']);
  assert.deepEqual(ANALYTICS_RETENTION, [
    '002-analytics-retention.sql',
    '004-identity-link-retention.sql',
  ]);
  const statements = await clickhouseStatements(ANALYTICS_SCHEMA);
  assert.equal(statements.length, 5);
  assert.match(
    statements[0],
    /^-- [\s\S]*CREATE TABLE IF NOT EXISTS signaltrail\.analytics_events/,
  );
  assert.match(statements[1], /ADD COLUMN IF NOT EXISTS occurred_at/);
  assert.match(statements[3], /DEFINER = CURRENT_USER SQL SECURITY DEFINER/);
  assert.match(statements[4], /^-- Backfill[\s\S]*NOT IN/);
  assert.equal((await clickhouseStatements(ANALYTICS_RETENTION)).length, 2);
});
