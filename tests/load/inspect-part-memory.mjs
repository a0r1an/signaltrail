// Read-only diagnostics for the currently advertised isolated capacity fixture.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const lock = JSON.parse(await readFile('test-results/load.lock', 'utf8'));
process.kill(lock.pid, 0);
const targets = JSON.parse(await readFile('test-results/load-targets.json', 'utf8'));
const runId = targets[0]?.labels?.run_id;
assert.ok(
  typeof runId === 'string' && /^[\w.:-]+$/.test(runId) && runId.includes('capacity-4gb'),
  'No active isolated capacity fixture',
);
const report = { at: new Date().toISOString(), runId, observations: [] };
for (const [name, sql] of [
  [
    'part-states',
    'SELECT database, table, active, count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes, sum(primary_key_bytes_in_memory) AS primary_key_bytes FROM system.parts GROUP BY database, table, active ORDER BY parts DESC',
  ],
  [
    'retention-settings',
    "SELECT name,value FROM system.merge_tree_settings WHERE name IN ('old_parts_lifetime','cleanup_delay_period','cleanup_delay_period_random_add','parts_to_delay_insert')",
  ],
]) {
  const r = await fetch('http://127.0.0.1:38124/?wait_end_of_query=1', {
    method: 'POST',
    headers: { 'X-ClickHouse-User': 'signaltrail', 'X-ClickHouse-Key': 'signaltrail_local' },
    body: sql + ' SETTINGS max_threads=1, max_memory_usage=67108864 FORMAT JSONEachRow',
    signal: AbortSignal.timeout(15000),
  });
  const body = await r.text();
  assert.equal(r.status, 200, body);
  report.observations.push({ name, rows: body.trim().split('\n').filter(Boolean).map(JSON.parse) });
}
const file = `test-results/load/${runId}/part-memory-${report.at.replaceAll(':', '-')}.json`;
await writeFile(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`Saved: ${file}`);
