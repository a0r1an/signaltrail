export const analyticalSql =
  'SELECT event_name, count(), uniqExact(distinct_id) FROM signaltrail.analytics_events FINAL GROUP BY event_name';

// Diagnostic controls only. Removing FINAL changes semantics and is never adopted here.
export const queryMemoryVariants = [
  { name: 'baseline', sql: analyticalSql },
  { name: 'single-thread', sql: analyticalSql + ' SETTINGS max_threads=1' },
  {
    name: 'spill-16m',
    sql: analyticalSql + ' SETTINGS max_bytes_before_external_group_by=16777216',
  },
  {
    name: 'count-only',
    sql: 'SELECT event_name, count() FROM signaltrail.analytics_events FINAL GROUP BY event_name',
  },
  { name: 'without-final-control', sql: analyticalSql.replace(' FINAL', '') },
];

export async function investigateQueryMemory({ request, save, runId }) {
  const report = { variants: [], snapshots: [], errors: [] };
  const capture = async (name, sql) => {
    try {
      report.snapshots.push({
        name,
        data: JSON.parse(
          await request(sql + ' FORMAT JSONEachRow').then(
            (s) => '[' + s.trim().split('\n').filter(Boolean).join(',') + ']',
          ),
        ),
      });
    } catch (error) {
      report.errors.push({ name, message: error.message });
    }
    await save(report);
  };
  await capture(
    'server-limits',
    "SELECT name, value FROM system.server_settings WHERE name IN ('max_server_memory_usage','max_server_memory_usage_to_ram_ratio','max_threads','uncompressed_cache_size','mark_cache_size')",
  );
  await capture(
    'query-settings',
    "SELECT name, value FROM system.settings WHERE name IN ('max_threads','max_memory_usage','max_bytes_before_external_group_by','max_bytes_ratio_before_external_group_by','max_bytes_before_external_sort','log_queries')",
  );
  await capture(
    'memory-before',
    "SELECT metric, value FROM system.asynchronous_metrics WHERE metric LIKE '%Memory%' OR metric LIKE '%Cache%'",
  );
  await capture(
    'parts-before',
    'SELECT database, table, count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes FROM system.parts WHERE active GROUP BY database, table ORDER BY bytes DESC',
  );
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const variant of queryMemoryVariants) {
      const queryId = `${runId}-${variant.name}-${repeat}`;
      const started = performance.now();
      try {
        const body = await request(variant.sql + ' FORMAT JSONEachRow', queryId);
        report.variants.push({
          name: variant.name,
          repeat,
          queryId,
          ok: true,
          ms: performance.now() - started,
          body,
        });
      } catch (error) {
        report.variants.push({
          name: variant.name,
          repeat,
          queryId,
          ok: false,
          ms: performance.now() - started,
          message: error.message,
        });
      }
      await save(report);
    }
  }
  try {
    await request('SYSTEM FLUSH LOGS');
  } catch (error) {
    report.errors.push({ name: 'flush-query-log', message: error.message });
  }
  // runId is generated locally from an ISO timestamp/profile, never external SQL input.
  if (!/^[a-zA-Z0-9_.:-]+$/.test(runId)) throw new Error('Invalid diagnostic run ID');
  await capture(
    'query-log',
    `SELECT query_id, toString(type) AS type, query_duration_ms, read_rows, read_bytes, memory_usage, exception_code, exception, Settings['max_threads'] AS max_threads, ProfileEvents['ExternalAggregationWritePart'] AS spill_parts, ProfileEvents['ExternalAggregationCompressedBytes'] AS spill_bytes FROM system.query_log WHERE startsWith(query_id, '${runId}-') AND type != 'QueryStart' ORDER BY event_time_microseconds`,
  );
  await capture(
    'memory-after',
    "SELECT metric, value FROM system.asynchronous_metrics WHERE metric LIKE '%Memory%' OR metric LIKE '%Cache%'",
  );
  await capture(
    'tracked-memory',
    "SELECT metric, value FROM system.metrics WHERE metric LIKE '%Memory%' OR metric LIKE '%Merge%' OR metric LIKE '%Query%' OR metric LIKE '%Log%'",
  );
  return report;
}
