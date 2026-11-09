import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capacityTargets } from './capacity-targets.mjs';

test('capacity discovery separates test runs and exposes fixture, host, worker and broker endpoints', () => {
  const targets = capacityTargets({
    profile: 'capacity-4gb-db8-q24-rebalanced',
    runId: '2026-11-09T00-00-00Z',
  });
  assert.equal(targets.length, 4);
  assert.ok(
    targets.every(
      (t) => t.labels.environment === 'test' && t.labels.run_id === '2026-11-09T00-00-00Z',
    ),
  );
  assert.equal(new Set(targets.map((t) => t.labels.job)).size, 4);
  assert.ok(targets.some((t) => t.labels.__metrics_path__ === '/processor-metrics'));
  assert.ok(targets.some((t) => t.targets[0] === 'host.docker.internal:34107'));
});
