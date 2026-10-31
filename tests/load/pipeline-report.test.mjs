import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeWorkerSamples } from './pipeline-report.mjs';

test('summarizes worker CPU in cores over the observed window and peak resident memory', () => {
  const result = summarizeWorkerSamples([
    { elapsedSeconds: 1, worker: { cpuSeconds: 3, rssBytes: 100 } },
    { elapsedSeconds: 3, worker: { cpuSeconds: 4, rssBytes: 150 } },
  ]);
  assert.equal(result.windowSeconds, 2);
  assert.equal(result.averageCpuCores, 0.5);
  assert.equal(result.maxRssBytes, 150);
});

test('reports mean storage acknowledgement time and an honest histogram p95 upper bound', () => {
  const metrics = [
    'signaltrail_processor_storage_write_duration_seconds_bucket{le="0.01",outcome="confirmed"} 2',
    'signaltrail_processor_storage_write_duration_seconds_bucket{outcome="confirmed",le="0.05"} 20',
    'signaltrail_processor_storage_write_duration_seconds_bucket{le="+Inf",outcome="confirmed"} 20',
    'signaltrail_processor_storage_write_duration_seconds_sum{outcome="confirmed"} 0.4',
    'signaltrail_processor_storage_write_duration_seconds_count{outcome="confirmed"} 20',
    'signaltrail_processor_storage_write_duration_seconds_count{outcome="failed"} 1',
  ].join('\n');
  const result = summarizeWorkerSamples([
    { elapsedSeconds: 0, worker: { cpuSeconds: 0, rssBytes: 100 } },
    { elapsedSeconds: 2, worker: { cpuSeconds: 1, rssBytes: 100 }, metrics },
  ]);
  assert.deepEqual(result.storage, {
    confirmedWrites: 20,
    failedWrites: 1,
    meanConfirmedSeconds: 0.02,
    p95ConfirmedUpperBoundSeconds: 0.05,
  });
});

test('rejects invalid CPU windows and incomplete latency measurements instead of writing misleading numbers', () => {
  const sample = { elapsedSeconds: 1, worker: { cpuSeconds: 2, rssBytes: 100 } };
  assert.throws(() => summarizeWorkerSamples([sample, sample]));
  assert.throws(() =>
    summarizeWorkerSamples([
      sample,
      { ...sample, elapsedSeconds: 2, worker: { cpuSeconds: 1, rssBytes: 100 } },
    ]),
  );
  assert.throws(() =>
    summarizeWorkerSamples([
      sample,
      {
        ...sample,
        elapsedSeconds: 2,
        metrics:
          'signaltrail_processor_storage_write_duration_seconds_count{outcome="confirmed"} 1',
      },
    ]),
  );
});
