import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCapacityStage, capacityWorkloads } from './capacity-stage.mjs';

test('boundary repeat holds 100 EPS longer and narrows the first measured 100–200 EPS bracket', () => {
  const stages = capacityWorkloads('capacity-4gb-boundary');
  assert.deepEqual(
    stages.map((s) => s.rate),
    [100, 150, 175, 200],
  );
  assert.equal(stages[0].durationSeconds, 120);
  assert.ok(stages.every((s) => s.sessionCount === 1000 && s.durationSeconds >= 60));
  assert.throws(() => capacityWorkloads('arbitrary'));
});

test('conservative confirmation runs the previously passing 50 EPS for three minutes', () => {
  assert.deepEqual(capacityWorkloads('capacity-4gb-confirm'), [
    { users: 500, rate: 50, sessionCount: 1000, durationSeconds: 180 },
  ]);
});

const summary = () => ({
  metrics: {
    events_accepted: { values: { count: 100 } },
    events_retry: { values: { count: 0 } },
    events_rejected: { values: { count: 0 } },
    responses_malformed: { values: { count: 0 } },
    http_req_failed: { values: { rate: 0 } },
    http_req_duration: { values: { 'p(95)': 20, 'p(99)': 40 } },
  },
});
test('capacity requires complete measurements, no losses/refusals and bounded latency', () => {
  assert.deepEqual(assessCapacityStage(summary()), []);
  for (const [metric, field, value] of [
    ['events_retry', 'count', 1],
    ['events_rejected', 'count', 1],
    ['responses_malformed', 'count', 1],
    ['http_req_failed', 'rate', 0.01],
    ['events_accepted', 'count', 0],
    ['http_req_duration', 'p(95)', 501],
    ['http_req_duration', 'p(99)', 2001],
  ]) {
    const s = summary();
    s.metrics[metric].values[field] = value;
    assert.ok(assessCapacityStage(s).length, metric);
  }
  const s = summary();
  s.metrics.dropped_iterations = { values: { count: 1 } };
  assert.ok(assessCapacityStage(s).length);
  delete s.metrics.http_req_duration;
  assert.ok(assessCapacityStage(s).length);
});

test('paired HTTP admission profiles use the identical two-minute 100 EPS workload', () => {
  const expected = [{ users: 1000, rate: 100, sessionCount: 1000, durationSeconds: 120 }];
  assert.deepEqual(capacityWorkloads('capacity-4gb-http32'), expected);
  assert.deepEqual(capacityWorkloads('capacity-4gb-http128'), expected);
});

test('eight-connection comparison preserves the two-minute 100 EPS workload', () => {
  assert.deepEqual(
    capacityWorkloads('capacity-4gb-db8'),
    capacityWorkloads('capacity-4gb-http128'),
  );
});

test('long pool comparisons hold the same 100 EPS workload for five minutes', () => {
  const expected = [{ users: 1000, rate: 100, sessionCount: 1000, durationSeconds: 300 }];
  assert.deepEqual(capacityWorkloads('capacity-4gb-db4-long'), expected);
  assert.deepEqual(capacityWorkloads('capacity-4gb-db8-long'), expected);
});

test('long capacity traffic has time for its duration and summary shutdown', async () => {
  const { capacityCommandTimeoutMs } = await import('./capacity-stage.mjs');
  assert.equal(capacityCommandTimeoutMs('capacity-4gb-db4-long'), 420000);
  assert.equal(capacityCommandTimeoutMs('capacity-4gb-http128'), 300000);
});

test('24-query gate comparison preserves the five-minute eight-connection workload', () => {
  assert.deepEqual(
    capacityWorkloads('capacity-4gb-db8-q24'),
    capacityWorkloads('capacity-4gb-db8-long'),
  );
});

test('analytical-load control retains the five-minute 100 EPS workload', () => {
  assert.deepEqual(
    capacityWorkloads('capacity-4gb-db8-q24-noqueries'),
    capacityWorkloads('capacity-4gb-db8-q24'),
  );
});

test('generator-isolation control keeps the five-minute full analytical workload', () => {
  assert.deepEqual(
    capacityWorkloads('capacity-4gb-db8-q24-generator'),
    capacityWorkloads('capacity-4gb-db8-q24'),
  );
});

test('memory redistribution preserves the isolated-generator five-minute workload', () => {
  assert.deepEqual(
    capacityWorkloads('capacity-4gb-db8-q24-rebalanced'),
    capacityWorkloads('capacity-4gb-db8-q24-generator'),
  );
});
