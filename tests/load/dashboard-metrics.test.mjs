import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingDashboardMetrics } from './dashboard-metrics.mjs';

test('dashboard contract catches queries for metrics absent from the real exporters', () => {
  const dashboard = {
    panels: [
      {
        targets: [
          { expr: 'rate(signaltrail_real_total{job="fixture"}[1m]) + signaltrail_missing' },
        ],
      },
    ],
  };
  assert.deepEqual(
    missingDashboardMetrics(dashboard, [
      '# TYPE signaltrail_real_total counter\nsignaltrail_real_total 1\n',
    ]),
    ['signaltrail_missing'],
  );
});
