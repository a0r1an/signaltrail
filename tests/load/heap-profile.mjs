import assert from 'node:assert/strict';

export function parseHeap(body) {
  const stacks = {};
  assert.ok(body.trim(), 'Heap profile is empty');
  for (const row of body.trim().split('\n')) {
    const { line } = JSON.parse(row);
    const match = /^(.*\S)\s+(\d+)$/.exec(line);
    assert.ok(match, 'Invalid collapsed heap stack');
    const bytes = Number(match[2]);
    assert.ok(Number.isSafeInteger(bytes), 'Invalid sampled byte count');
    stacks[match[1]] = (stacks[match[1]] ?? 0) + bytes;
  }
  const totalBytes = Object.values(stacks).reduce((a, b) => a + b, 0);
  assert.ok(totalBytes > 0, 'Heap profile has no live sampled bytes');
  return { stacks, totalBytes };
}
export function diffHeaps(before, after) {
  return [...new Set([...Object.keys(before.stacks), ...Object.keys(after.stacks)])]
    .map((stack) => ({ stack, bytes: (after.stacks[stack] ?? 0) - (before.stacks[stack] ?? 0) }))
    .filter((row) => row.bytes !== 0)
    .sort((a, b) => b.bytes - a.bytes);
}
