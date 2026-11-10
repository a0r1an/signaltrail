import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHeap, diffHeaps } from './heap-profile.mjs';

test('compares live sampled stack bytes without counting a shared caller twice', () => {
  const a = parseHeap('{"line":"root;DB::buffer 100"}\n{"line":"root;DB::merge 50"}\n');
  const b = parseHeap('{"line":"root;DB::buffer 300"}\n{"line":"root;DB::merge 20"}\n');
  assert.equal(a.totalBytes, 150);
  assert.equal(b.totalBytes, 320);
  assert.deepEqual(diffHeaps(a, b), [
    { stack: 'root;DB::buffer', bytes: 200 },
    { stack: 'root;DB::merge', bytes: -30 },
  ]);
});
test('rejects empty or malformed profiles rather than claiming no allocations', () => {
  assert.throws(() => parseHeap(''), /empty/);
  assert.throws(() => parseHeap('{"line":"not a collapsed stack"}'), /Invalid/);
});
