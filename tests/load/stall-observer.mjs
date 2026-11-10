// Fixture-only, bounded observations. No SQL text, keys or parameter values are retained.
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { readResourceDiagnostics } from './resource-diagnostics.mjs';

export function startStallObserver({
  database,
  snapshot,
  readResources = readResourceDiagnostics,
  onRecord = () => {},
}) {
  const records = [];
  let totalRecords = 0,
    busy = false,
    stopped = false;
  let previousAt = performance.now(),
    previousCpu = process.cpuUsage();
  let previousElu = performance.eventLoopUtilization();
  let gcCount = 0,
    gcTotalMs = 0,
    gcMaxMs = 0;
  const gc = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount++;
      gcTotalMs += entry.duration;
      gcMaxMs = Math.max(gcMaxMs, entry.duration);
    }
  });
  gc.observe({ entryTypes: ['gc'] });
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    const started = performance.now();
    const currentCpu = process.cpuUsage();
    const currentElu = performance.eventLoopUtilization();
    const elapsedMs = started - previousAt;
    const record = {
      at: new Date().toISOString(),
      elapsedMs,
      schedulingOverrunMs: Math.max(0, elapsedMs - 1000),
      processCpuMs: {
        user: (currentCpu.user - previousCpu.user) / 1000,
        system: (currentCpu.system - previousCpu.system) / 1000,
      },
      eventLoopUtilization: performance.eventLoopUtilization(currentElu, previousElu),
      eventLoopDelayMs: { max: loop.max / 1e6, p99: loop.percentile(99) / 1e6 },
      gc: { count: gcCount, totalMs: gcTotalMs, maxMs: gcMaxMs },
      application: snapshot(),
    };
    previousAt = started;
    previousCpu = currentCpu;
    previousElu = currentElu;
    gcCount = 0;
    gcTotalMs = 0;
    gcMaxMs = 0;
    loop.reset();
    try {
      const [resources, postgres] = await Promise.all([
        readResources(),
        database
          .query(
            `SELECT
          (SELECT coalesce(json_agg(w), '[]'::json) FROM (
            SELECT state, wait_event_type, wait_event, count(*)::int AS backends,
              max(extract(epoch FROM clock_timestamp()-query_start)*1000)::float8 AS oldest_query_ms
            FROM pg_stat_activity WHERE application_name='signaltrail-project-access'
            GROUP BY state, wait_event_type, wait_event
          ) w) AS waits,
          blks_read, blks_hit, temp_bytes, deadlocks
          FROM pg_stat_database WHERE datname=current_database()`,
          )
          .then((result) => ({ available: true, rows: result.rows }))
          .catch(() => ({ available: false })),
      ]);
      record.resources = resources;
      record.postgres = postgres;
    } catch {
      record.collectionFailed = true;
    } finally {
      record.finishedAt = new Date().toISOString();
      record.collectionMs = performance.now() - started;
      try {
        onRecord(record);
      } catch {
        record.metricsObservationFailed = true;
      }
      record.sequence = totalRecords + 1;
      records.push(record);
      totalRecords++;
      if (records.length > 600) records.shift();
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 1000);
  timer.unref();
  return {
    snapshot: () => ({ totalRecords, retained: records.length, latest: records.slice(-2) }),
    records: (after = 0) => ({
      totalRecords,
      missingBefore: Math.max(0, (records[0]?.sequence ?? totalRecords + 1) - after - 1),
      records: records.filter((record) => record.sequence > after),
    }),
    stop() {
      stopped = true;
      clearInterval(timer);
      gc.disconnect();
      loop.disable();
    },
  };
}
