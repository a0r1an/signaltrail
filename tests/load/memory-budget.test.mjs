import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryPlan, memoryPlans, verifyMemoryLimits } from './memory-budget.mjs';

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
