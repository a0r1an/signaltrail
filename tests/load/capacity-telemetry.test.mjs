import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCapacityTelemetry } from './capacity-telemetry.mjs';

test('capacity telemetry exposes distinct refusal counters and real timing histograms', async () => {
  const metrics = createCapacityTelemetry({ kind: 'ingestion' });
  metrics.observeDatabaseTiming('acquisition', 0.002);
  metrics.observeDatabaseTiming('execution', 0.02);
  metrics.updateApplication({
    metadata: {
      inFlight: 16,
      executing: 8,
      waiting: 8,
      acquiring: 8,
      capacity: 16,
      maxConnections: 8,
      refused: 3,
      peakInFlight: 16,
    },
    admission: { activeRequests: 20, refused: 2, peakActiveRequests: 25 },
  });
  const body = await metrics.registry.metrics();
  assert.match(body, /signaltrail_capacity_metadata_refused_total 3/);
  assert.match(body, /signaltrail_capacity_http_refused_total 2/);
  assert.match(
    body,
    /signaltrail_capacity_metadata_duration_seconds_count\{phase="acquisition"\} 1/,
  );
  assert.match(
    body,
    /signaltrail_capacity_metadata_duration_seconds_sum\{phase="execution"\} 0.02/,
  );
  assert.doesNotMatch(body, /projectKey|eventId/);
  metrics.close();
});

test('resource telemetry preserves cumulative pressure and exposes actual ClickHouse cap', async () => {
  const metrics = createCapacityTelemetry();
  metrics.updateSample(
    {
      at: '2026-11-09T00:00:00Z',
      stats: [],
      clickhouseMemory:
        'max 7\noom 0\nsome avg10=0.00 total=2000000\nfull avg10=0.00 total=1000000\n1000\n2000\nanon 700\nfile 200\n',
    },
    { services: {} },
  );
  const body = await metrics.registry.metrics();
  assert.match(body, /signaltrail_capacity_memory_current_bytes\{service="clickhouse"\} 1000/);
  assert.match(body, /signaltrail_capacity_memory_limit_bytes\{service="clickhouse"\} 2000/);
  assert.match(
    body,
    /signaltrail_capacity_memory_events_total\{service="clickhouse",event="max"\} 7/,
  );
  assert.match(
    body,
    /signaltrail_capacity_pressure_stall_seconds_total\{resource="memory",scope="clickhouse",level="some"\} 2/,
  );
  assert.doesNotMatch(body, /NaN|undefined/);
  metrics.close();
});
