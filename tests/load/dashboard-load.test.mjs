import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessDashboard, dashboardWindow, summarizeDashboard } from './dashboard-load.mjs';

test('page loads rotate through the 1/7/30-day windows the reader allows', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z');
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => dashboardWindow(i, now)),
    [
      { days: 1, from: '2026-11-09T12:00:00.000Z', to: '2026-11-10T12:00:00.000Z' },
      { days: 7, from: '2026-11-03T12:00:00.000Z', to: '2026-11-10T12:00:00.000Z' },
      { days: 30, from: '2026-10-11T12:00:00.000Z', to: '2026-11-10T12:00:00.000Z' },
      { days: 1, from: '2026-11-09T12:00:00.000Z', to: '2026-11-10T12:00:00.000Z' },
    ],
  );
});

const page = (days, ms, failed = []) => ({
  days,
  ms,
  queries: Object.fromEntries(
    ['list', 'count', 'visitors'].map((kind) => [
      kind,
      failed.includes(kind) ? { ok: false, ms, error: 'boom' } : { ok: true, ms: ms - 1 },
    ]),
  ),
});

test('summarizes page and per-query latency, errors and window coverage', () => {
  const summary = summarizeDashboard([
    page(1, 100),
    page(7, 200),
    page(30, 300, ['visitors']),
    page(30, 400),
  ]);
  assert.equal(summary.pages, 4);
  assert.equal(summary.failedPages, 1);
  assert.deepEqual(summary.errors, { list: 0, count: 0, visitors: 1 });
  assert.equal(summary.pageMs.max, 400);
  assert.equal(summary.pageMs.p95, 400);
  assert.equal(summary.byWindow['30'].pageMsMax, 400);
  assert.equal(summary.byQuery.count.max, 399);
});

test('fails on any dashboard error, missing page loads or slow p95', () => {
  assert.deepEqual(assessDashboard(summarizeDashboard([page(1, 100), page(30, 900)])), []);
  assert.deepEqual(assessDashboard(summarizeDashboard([page(1, 100, ['count'])])), [
    'Dashboard queries failed: count=1',
  ]);
  assert.deepEqual(assessDashboard(summarizeDashboard([])), ['No dashboard page loads completed']);
  assert.deepEqual(assessDashboard(summarizeDashboard([page(30, 2500)])), [
    'Dashboard page p95 exceeds 2000 ms',
  ]);
});
