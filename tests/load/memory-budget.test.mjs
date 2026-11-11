import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryPlan, memoryPlans, verifyMemoryLimits } from './memory-budget.mjs';

test('capacity profile requires all target services on the same two logical CPUs', () => {
  const plan = memoryPlans['capacity-4gb'];
  const containers = Object.entries(plan.services).map(([service, mib]) => ({
    Config: { Labels: { 'com.docker.compose.service': service } },
    HostConfig: { Memory: mib * 1048576, MemorySwap: mib * 1048576, CpusetCpus: '0,1' },
    State: { Running: true, OOMKilled: false },
    RestartCount: 0,
  }));
  assert.doesNotThrow(() => verifyMemoryLimits(containers, plan));
  containers[0].HostConfig.CpusetCpus = '';
  assert.throws(() => verifyMemoryLimits(containers, plan));
});

test('two GiB plan reserves host memory and validates its own smaller limits', () => {
  const plan = memoryPlans['memory-2gb'];
  assert.ok(plan);
  assert.equal(
    Object.values(plan.services).reduce((sum, n) => sum + n, 0) + plan.hostReserveMiB,
    2048,
  );
  const containers = Object.entries(plan.services).map(([service, mib]) => ({
    Config: { Labels: { 'com.docker.compose.service': service } },
    HostConfig: { Memory: mib * 1048576, MemorySwap: mib * 1048576 },
    State: { Running: true, OOMKilled: false },
    RestartCount: 0,
  }));
  assert.doesNotThrow(() => verifyMemoryLimits(containers, plan));
  assert.throws(() => verifyMemoryLimits(containers));
});

test('reserves host memory within a four GiB total and refuses unenforced limits', () => {
  assert.equal(
    Object.values(memoryPlan.services).reduce((a, b) => a + b, 0) + memoryPlan.hostReserveMiB,
    4096,
  );
  const containers = Object.entries(memoryPlan.services).map(([service, mib]) => ({
    Config: { Labels: { 'com.docker.compose.service': service } },
    HostConfig: { Memory: mib * 1048576, MemorySwap: mib * 1048576 },
    State: { Running: true, OOMKilled: false },
    RestartCount: 0,
  }));
  assert.doesNotThrow(() => verifyMemoryLimits(containers));
  containers[0].HostConfig.Memory = 0;
  assert.throws(() => verifyMemoryLimits(containers));
});

test('refuses missing services, swap, restarts and out-of-memory termination', () => {
  const fixture = () =>
    Object.entries(memoryPlan.services).map(([service, mib]) => ({
      Config: { Labels: { 'com.docker.compose.service': service } },
      HostConfig: { Memory: mib * 1048576, MemorySwap: mib * 1048576 },
      State: { Running: true, OOMKilled: false },
      RestartCount: 0,
    }));
  assert.throws(() => verifyMemoryLimits(fixture().slice(1)));
  for (const mutate of [
    (value) => (value.HostConfig.MemorySwap = -1),
    (value) => (value.State.OOMKilled = true),
    (value) => (value.State.Running = false),
    (value) => (value.RestartCount = 1),
  ]) {
    const containers = fixture();
    mutate(containers[0]);
    assert.throws(() => verifyMemoryLimits(containers));
  }
});

test('rebalanced profile gives ClickHouse more room while preserving four GiB and host reserve', () => {
  const plan = memoryPlans['capacity-4gb-db8-q24-rebalanced'];
  assert.ok(plan);
  assert.deepEqual(plan.services, {
    redpanda: 1280,
    clickhouse: 1536,
    postgres: 128,
    valkey: 128,
    app: 384,
  });
  assert.equal(plan.hostReserveMiB, 640);
  assert.equal(
    Object.values(plan.services).reduce((sum, n) => sum + n, 0) + plan.hostReserveMiB,
    4096,
  );
  assert.equal(plan.cpuSet, '0,1');
  const containers = Object.entries(plan.services).map(([service, mib]) => ({
    Config: { Labels: { 'com.docker.compose.service': service } },
    HostConfig: { Memory: mib * 1048576, MemorySwap: mib * 1048576, CpusetCpus: '0,1' },
    State: { Running: true, OOMKilled: false },
    RestartCount: 0,
  }));
  assert.doesNotThrow(() => verifyMemoryLimits(containers, plan));
  assert.throws(() =>
    verifyMemoryLimits(containers, memoryPlans['capacity-4gb-db8-q24-generator']),
  );
});

test('endurance preserves the verified revised four-GiB allocation and CPU affinity', () => {
  assert.deepEqual(
    memoryPlans['capacity-4gb-db8-q24-endurance'],
    memoryPlans['capacity-4gb-db8-q24-rebalanced'],
  );
});

test('step-down endurance keeps the revised four-GiB allocation and CPU affinity', () => {
  assert.deepEqual(
    memoryPlans['capacity-4gb-db8-q24-endurance-50'],
    memoryPlans['capacity-4gb-db8-q24-endurance'],
  );
});

test('async insert profiles keep the revised four-GiB allocation and CPU affinity', () => {
  for (const name of ['capacity-4gb-memory-trace-async', 'capacity-4gb-memory-trace-async-smoke'])
    assert.deepEqual(memoryPlans[name], memoryPlans['capacity-4gb-memory-trace']);
});

test('dashboard profiles keep the revised four-GiB allocation and CPU affinity', () => {
  for (const name of [
    'capacity-4gb-memory-trace-async-dashboard',
    'capacity-4gb-memory-trace-async-dashboard-smoke',
    'capacity-4gb-memory-trace-async-dashboard-endurance',
    'capacity-4gb-memory-trace-async-dashboard-viewers5',
    'capacity-4gb-memory-trace-async-dashboard-viewers5-smoke',
  ])
    assert.deepEqual(memoryPlans[name], memoryPlans['capacity-4gb-memory-trace']);
});
