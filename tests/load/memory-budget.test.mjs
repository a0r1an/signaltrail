import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryPlan, verifyMemoryLimits } from './memory-budget.mjs';

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
