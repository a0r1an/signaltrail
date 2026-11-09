import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readResourceDiagnostics } from './resource-diagnostics.mjs';

test('resource diagnostics retain allowlisted pressure/counter files and explicit unavailable evidence', async () => {
  const result = await readResourceDiagnostics(async (path) => {
    if (path === '/sys/fs/cgroup/cpu.stat')
      return 'usage_usec 123\nnr_throttled 7\nthrottled_usec 456\n';
    if (path === '/proc/pressure/io') return 'some avg10=1.00 avg60=0.00 avg300=0.00 total=100\n';
    throw new Error('unavailable');
  });
  assert.equal(result.cgroupCpuStat.value, 'usage_usec 123\nnr_throttled 7\nthrottled_usec 456\n');
  assert.match(result.vmIoPressure.value, /total=100/);
  assert.deepEqual(result.cgroupIoPressure, { available: false });
  assert.equal(Object.keys(result).length, 12);
});
