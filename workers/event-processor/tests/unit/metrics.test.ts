import { expect, it } from 'vitest';
import { createProcessorMetrics } from '../../src/metrics.ts';

it('exports process-local completions and retries without customer labels', async () => {
  const state = { running: false, stored: 0, deadLettered: 0, retries: 0 };
  const metrics = createProcessorMetrics(() => ({ ...state }));
  try {
    expect(await metrics.registry.metrics()).toContain('signaltrail_processor_running 0');
    state.running = true;
    state.stored = 4;
    state.deadLettered = 1;
    state.retries = 3;
    const first = await metrics.registry.metrics();
    expect(first).toContain('signaltrail_processor_running 1');
    expect(first).toContain('signaltrail_processor_stored_total 4');
    expect(first).toContain('signaltrail_processor_dead_lettered_total 1');
    expect(first).toContain('signaltrail_processor_retries_total 3');
    expect(await metrics.registry.metrics()).toBe(first);
    state.stored++;
    const values = await metrics.registry.getMetricsAsJSON();
    expect(
      values.find((metric) => metric.name === 'signaltrail_processor_stored_total')?.values,
    ).toEqual([{ value: 5, labels: {} }]);
  } finally {
    await metrics.close();
  }
});

it('exports attempt latency histograms with only the fixed outcome labels', async () => {
  const metrics = createProcessorMetrics(() => ({
    running: true,
    stored: 1,
    deadLettered: 0,
    retries: 1,
  }));
  try {
    metrics.observeAttempt('stored', 0.5);
    metrics.observeAttempt('failed', 0.25);
    const values = await metrics.registry.getMetricsAsJSON();
    const histogram = values.find(
      (metric) => metric.name === 'signaltrail_processor_attempt_duration_seconds',
    );
    expect(histogram?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metricName: 'signaltrail_processor_attempt_duration_seconds_count',
          value: 1,
          labels: { outcome: 'stored' },
        }),
        expect.objectContaining({
          metricName: 'signaltrail_processor_attempt_duration_seconds_sum',
          value: 0.5,
          labels: { outcome: 'stored' },
        }),
        expect.objectContaining({
          metricName: 'signaltrail_processor_attempt_duration_seconds_sum',
          value: 0.25,
          labels: { outcome: 'failed' },
        }),
      ]),
    );
  } finally {
    await metrics.close();
  }
});

it('measures chunk records and source bytes without project or event labels', async () => {
  const metrics = createProcessorMetrics(() => ({
    running: true,
    stored: 0,
    deadLettered: 0,
    retries: 0,
  }));
  try {
    metrics.observeChunk(100, 8192);
    metrics.observeChunk(5, 512);
    const text = await metrics.registry.metrics();
    expect(text).toContain('signaltrail_processor_chunk_records_count 2');
    expect(text).toContain('signaltrail_processor_chunk_records_sum 105');
    expect(text).toContain('signaltrail_processor_chunk_source_bytes_sum 8704');
    expect(text).toContain('signaltrail_processor_chunk_records_bucket{le="100"} 2');
  } finally {
    await metrics.close();
  }
});
