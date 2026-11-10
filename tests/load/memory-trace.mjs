export async function captureMemoryTrace({ request, append }) {
  const record = { startedAt: new Date().toISOString(), observations: [], errors: [] };
  const statements = [
    [
      'memory',
      "SELECT 'async' AS source, metric, toFloat64(value) AS value FROM system.asynchronous_metrics WHERE match(lower(metric), 'memory|jemalloc|cache|cgroup') UNION ALL SELECT 'current' AS source, metric, toFloat64(value) AS value FROM system.metrics WHERE match(lower(metric), 'memory|cache|merge|insert|log|profiler|query')",
    ],
    [
      'merges',
      'SELECT database, table, elapsed, progress, num_parts, memory_usage FROM system.merges',
    ],
    [
      'parts',
      'SELECT database, table, active, count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes FROM system.parts GROUP BY database, table, active ORDER BY parts DESC',
    ],
  ];
  for (const [name, sql] of statements) {
    try {
      const body = await request(
        sql + ' SETTINGS max_threads=1, max_memory_usage=67108864 FORMAT JSONEachRow',
      );
      record.observations.push({
        name,
        at: new Date().toISOString(),
        rows: body.trim().split('\n').filter(Boolean).map(JSON.parse),
      });
    } catch (error) {
      record.errors.push({ name, at: new Date().toISOString(), message: error.message });
    }
  }
  record.finishedAt = new Date().toISOString();
  await append(record);
  return record;
}
