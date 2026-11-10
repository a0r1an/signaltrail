import assert from 'node:assert/strict';
import test from 'node:test';
import { investigateQueryMemory } from './query-memory.mjs';

test('keeps failed query measurements, persists them immediately and continues controls', async () => {
  const saved = [];
  let calls = 0;
  const r = await investigateQueryMemory({
    runId: 'fixture-run',
    save: async (report) => saved.push(structuredClone(report)),
    request: async (sql, id) => {
      if (id) {
        calls++;
        if (calls === 1) throw new Error('MEMORY_LIMIT_EXCEEDED');
        return '{"count()":100}\n';
      }
      return sql.startsWith('SYSTEM') ? '' : '{}\n';
    },
  });
  assert.equal(r.variants.length, 15);
  assert.equal(r.variants[0].ok, false);
  assert.equal(r.variants[1].ok, true);
  assert.match(saved.find((x) => x.variants.length === 1).variants[0].message, /MEMORY_LIMIT/);
  assert.equal(r.errors.length, 0);
});
