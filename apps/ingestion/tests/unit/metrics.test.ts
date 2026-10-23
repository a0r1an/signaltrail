import { expect, it } from 'vitest';
import { createIngestionMetrics } from '../../src/metrics.ts';
it('exports publisher pressure without project or event labels', async () => {
  const metrics = createIngestionMetrics(
    () => ({
      outstandingEvents: 3,
      outstandingBytes: 123,
      peakEvents: 4,
      peakBytes: 200,
      refused: 2,
      completed: 5,
      failed: 1,
      cancelled: 1,
      lateCompletions: 1,
      durationSeconds: 0.5,
    }),
    { maxEvents: 1000, maxBytes: 8388608 },
  );
  try {
    const text = await metrics.registry.metrics();
    expect(text).toContain('signaltrail_publications_outstanding_events 3');
    expect(text).toContain('signaltrail_publications_refused_total 2');
    expect(text).toContain('signaltrail_publications_limit_bytes 8388608');
    expect(text).toContain('signaltrail_process_resident_memory_bytes');
    expect(text).not.toContain('projectId');
  } finally {
    metrics.close();
  }
});

it('does not turn a successful response into a failure when diagnostics throw', async () => {
  const { createIngestionHandler } = await import('../../src/handler.ts');
  const handle = createIngestionHandler({
    resolveProjectKey: () => 'project',
    publish: async () => {},
    observeRequest: () => {
      throw new Error('metrics unavailable');
    },
  });
  await expect(handle(new Request('http://localhost/health'))).resolves.toHaveProperty(
    'status',
    200,
  );
});
