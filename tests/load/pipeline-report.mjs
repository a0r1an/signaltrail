function storageSummary(text = '') {
  const lines = text.split('\n');
  const prefix = 'signaltrail_processor_storage_write_duration_seconds';
  const value = (suffix, outcome) => {
    const start = `${prefix}_${suffix}{outcome="${outcome}"} `;
    const line = lines.find((line) => line.startsWith(start));
    return line ? Number(line.slice(start.length)) : null;
  };
  const confirmedWrites = value('count', 'confirmed');
  if (!(confirmedWrites > 0)) return null;
  const sum = value('sum', 'confirmed');
  if (!Number.isSafeInteger(confirmedWrites) || sum === null || !Number.isFinite(sum) || sum < 0)
    throw new Error('Incomplete storage latency measurements');
  const buckets = lines
    .filter((line) => line.startsWith(prefix + '_bucket{') && line.includes('outcome="confirmed"'))
    .map((line) => ({
      upper: Number(line.match(/le="([^"]+)"/)[1].replace('+Inf', 'Infinity')),
      count: Number(line.slice(line.indexOf('}') + 1).trim()),
    }))
    .sort((a, b) => a.upper - b.upper);
  const p95 = buckets.find((bucket) => bucket.count >= confirmedWrites * 0.95)?.upper;
  return {
    confirmedWrites,
    failedWrites: value('count', 'failed') ?? 0,
    meanConfirmedSeconds: sum / confirmedWrites,
    p95ConfirmedUpperBoundSeconds: Number.isFinite(p95) ? p95 : null,
  };
}

export function summarizeWorkerSamples(samples) {
  if (
    samples.length < 2 ||
    samples.some((entry, index) => {
      const previous = samples[index - 1];
      return (
        !Number.isFinite(entry.elapsedSeconds) ||
        !Number.isFinite(entry.worker.cpuSeconds) ||
        !Number.isFinite(entry.worker.rssBytes) ||
        !(entry.worker.rssBytes > 0) ||
        entry.worker.cpuSeconds < 0 ||
        (previous &&
          (entry.elapsedSeconds <= previous.elapsedSeconds ||
            entry.worker.cpuSeconds < previous.worker.cpuSeconds))
      );
    })
  )
    throw new Error('Invalid worker resource measurement window');
  const first = samples[0];
  const last = samples[samples.length - 1];
  const windowSeconds = last.elapsedSeconds - first.elapsedSeconds;
  return {
    windowSeconds,
    averageCpuCores: (last.worker.cpuSeconds - first.worker.cpuSeconds) / windowSeconds,
    maxRssBytes: Math.max(...samples.map((entry) => entry.worker.rssBytes)),
    storage: storageSummary(last.metrics),
  };
}
