export function parseCollectorDelivery(text) {
  const evidence = {};
  const names = {
    prometheus_remote_storage_samples_total: 'remoteWritten',
    prometheus_remote_storage_samples_failed_total: 'remoteFailed',
    prometheus_remote_storage_samples_retried_total: 'remoteRetried',
    prometheus_remote_storage_samples_pending: 'remotePending',
  };
  for (const line of text.split('\n')) {
    const match = /^(\w+)\{([^\n]*)\}\s+([\d.eE+-]+)$/.exec(line);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    if (
      match[1] === 'prometheus_forwarded_samples_total' &&
      match[2].includes('component_id="prometheus.scrape.load"')
    )
      evidence.loadForwarded = value;
    if (names[match[1]]) evidence[names[match[1]]] = (evidence[names[match[1]]] ?? 0) + value;
  }
  return evidence;
}
export async function readCollectorDelivery() {
  try {
    const response = await fetch('http://127.0.0.1:12345/metrics', {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('Collector unavailable');
    const counters = parseCollectorDelivery(await response.text());
    return {
      available: Number.isFinite(counters.loadForwarded),
      at: new Date().toISOString(),
      ...counters,
    };
  } catch {
    return { available: false, at: new Date().toISOString() };
  }
}
