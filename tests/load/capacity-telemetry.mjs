import { createRequire } from 'node:module';
const { Registry, Gauge, Counter, Histogram } = createRequire(
  new URL('../../apps/ingestion/package.json', import.meta.url),
)('@prometheus-io/client');

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : undefined);
export function createCapacityTelemetry({ registry = new Registry(), kind = 'host' } = {}) {
  const metrics = new Map(),
    previous = new Map();
  const metric = (Type, suffix, help, labels) => {
    const name = `signaltrail_capacity_${suffix}`;
    if (!metrics.has(name))
      metrics.set(
        name,
        new Type({ name, help, labelNames: Object.keys(labels), registers: [registry] }),
      );
    return metrics.get(name);
  };
  const gauge = (name, value, labels = {}) => {
    if (Number.isFinite(value))
      metric(Gauge, name, name.replaceAll('_', ' '), labels).set(labels, value);
  };
  const counter = (name, value, labels = {}) => {
    if (!Number.isFinite(value) || value < 0) return;
    const key = name + JSON.stringify(labels),
      last = previous.get(key) ?? 0;
    metric(Counter, name, name.replaceAll('_', ' '), labels).inc(
      labels,
      value >= last ? value - last : value,
    );
    previous.set(key, value);
  };
  const timing =
    kind === 'ingestion'
      ? new Histogram({
          name: 'signaltrail_capacity_metadata_duration_seconds',
          help: 'Observed acquisition or execution round-trip duration, including failures',
          labelNames: ['phase'],
          buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
          registers: [registry],
        })
      : undefined;
  const loop =
    kind === 'ingestion'
      ? new Histogram({
          name: 'signaltrail_capacity_interval_loop_max_seconds',
          help: 'Distribution of one-second interval event-loop maxima, not individual request delays',
          buckets: [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
          registers: [registry],
        })
      : undefined;
  const keyValues = (text) =>
    Object.fromEntries(
      text
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((row) => row.length === 2 && number(row[1]) !== undefined)
        .map(([key, val]) => [key, Number(val)]),
    );
  const memory = (raw, service) => {
    if (typeof raw !== 'string') return;
    const values = keyValues(raw),
      single = raw.split('\n').filter((line) => /^\d+$/.test(line));
    if (single.length >= 2) {
      gauge('memory_current_bytes', Number(single[0]), { service });
      gauge('memory_limit_bytes', Number(single[1]), { service });
    }
    for (const event of ['low', 'high', 'max', 'oom', 'oom_kill'])
      counter('memory_events_total', values[event], { service, event });
    for (const item of ['anon', 'file', 'kernel', 'slab_reclaimable', 'slab_unreclaimable'])
      gauge('memory_stat_bytes', values[item], { service, kind: item });
    pressure(raw, 'memory', service);
  };
  const pressure = (text, resource, scope) => {
    for (const line of text.split('\n')) {
      const match = /^(some|full) .*total=(\d+)/.exec(line);
      if (match)
        counter('pressure_stall_seconds_total', Number(match[2]) / 1e6, {
          resource,
          scope,
          level: match[1],
        });
    }
  };
  return {
    registry,
    observeDatabaseTiming(phase, seconds) {
      if (['acquisition', 'execution'].includes(phase) && seconds >= 0 && Number.isFinite(seconds))
        timing?.observe({ phase }, seconds);
    },
    updateApplication(state) {
      const m = state.metadata;
      if (m) {
        for (const key of [
          'inFlight',
          'executing',
          'waiting',
          'acquiring',
          'capacity',
          'maxConnections',
          'peakInFlight',
        ])
          gauge('metadata_' + key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()), m[key]);
        counter('metadata_refused_total', m.refused);
      }
      if (state.admission) {
        counter('http_refused_total', state.admission.refused);
        gauge('http_peak_active_requests', state.admission.peakActiveRequests);
      }
    },
    updateInterval(record) {
      gauge('interval_last_timestamp_seconds', Date.parse(record.at) / 1000);
      gauge('interval_collection_seconds', record.collectionMs / 1000);
      gauge('interval_elapsed_seconds', record.elapsedMs / 1000);
      gauge('interval_event_loop_utilization', record.eventLoopUtilization?.utilization);
      if (Number.isFinite(record.eventLoopDelayMs?.max))
        loop?.observe(record.eventLoopDelayMs.max / 1000);
      for (const [name, reading] of Object.entries(record.resources ?? {})) {
        gauge('resource_available', reading.available ? 1 : 0, { resource: name });
        if (!reading.available) continue;
        if (name.endsWith('Pressure')) {
          const resource = name.includes('Cpu') ? 'cpu' : name.includes('Io') ? 'io' : 'memory';
          pressure(reading.value, resource, name.startsWith('vm') ? 'vm' : 'app');
        }
        if (name === 'cgroupCpuStat') {
          const values = keyValues(reading.value);
          counter('cpu_throttled_seconds_total', values.throttled_usec / 1e6, { service: 'app' });
        }
        if (name === 'cgroupMemoryEvents')
          for (const event of ['high', 'max', 'oom', 'oom_kill'])
            counter('memory_events_total', keyValues(reading.value)[event], {
              service: 'app',
              event,
            });
        if (name === 'vmStat')
          for (const line of reading.value.split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (!/^cpu\d+$/.test(parts[0])) continue;
            const modes = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];
            modes.forEach((mode, i) =>
              counter('cpu_ticks_total', Number(parts[i + 1]), { cpu: parts[0], mode }),
            );
          }
      }
      gauge('postgres_observation_available', record.postgres?.available ? 1 : 0);
      const waits = metric(
        Gauge,
        'postgres_backends',
        'Observed backend states; short waits may be missed',
        { state: '', wait_type: '' },
      );
      waits.reset();
      if (record.postgres?.available)
        for (const row of record.postgres.rows ?? []) {
          const groups = new Map();
          for (const wait of row.waits ?? []) {
            const state = ['active', 'idle', 'idle in transaction'].includes(wait.state)
              ? wait.state
              : 'other';
            const type = [
              'Client',
              'IO',
              'Lock',
              'LWLock',
              'Activity',
              'Timeout',
              'IPC',
              'BufferPin',
              'Extension',
            ].includes(wait.wait_event_type)
              ? wait.wait_event_type
              : 'none_or_other';
            const key = JSON.stringify([state, type]);
            groups.set(key, (groups.get(key) ?? 0) + wait.backends);
          }
          for (const [key, count] of groups) {
            const [state, wait_type] = JSON.parse(key);
            waits.set({ state, wait_type }, count);
          }
          counter('postgres_temp_bytes_total', number(row.temp_bytes));
          counter('postgres_deadlocks_total', number(row.deadlocks));
        }
    },
    updateSample(sample, plan) {
      gauge('sample_last_timestamp_seconds', Date.parse(sample.finishedAt ?? sample.at) / 1000);
      gauge('sample_collection_seconds', sample.collectionMs / 1000);
      for (const stat of sample.stats ?? []) {
        const service = stat.Name?.includes('-k6-')
          ? 'generator'
          : stat.Name?.replace(/^signaltrail-memory-/, '').replace(/-1$/, '');
        if (!['app', 'clickhouse', 'postgres', 'redpanda', 'valkey', 'generator'].includes(service))
          continue;
        gauge('container_cpu_cores', parseFloat(stat.CPUPerc) / 100, { service });
        const match = /^([\d.]+)(GiB|MiB|KiB|B)/.exec(stat.MemUsage ?? '');
        if (match)
          gauge(
            'container_displayed_memory_bytes',
            Number(match[1]) * { GiB: 1073741824, MiB: 1048576, KiB: 1024, B: 1 }[match[2]],
            { service },
          );
        if (plan.services[service])
          gauge('memory_limit_bytes', plan.services[service] * 1048576, { service });
      }
      memory(sample.clickhouseMemory, 'clickhouse');
      if (sample.pipeline) gauge('source_lag_records', number(sample.pipeline.source?.total));
    },
    setRun({
      startedAt,
      endedAt = 0,
      active,
      offeredRate,
      connections,
      queryLimit,
      httpLimit,
      accepted,
      stored,
      dropped,
    }) {
      gauge('run_started_timestamp_seconds', startedAt);
      gauge('run_ended_timestamp_seconds', endedAt);
      gauge('run_active', active ? 1 : 0);
      gauge('offered_events_per_second', offeredRate);
      gauge('configured_metadata_connections', connections);
      gauge('configured_metadata_queries', queryLimit);
      gauge('configured_http_requests', httpLimit);
      gauge('accepted_events', accepted);
      gauge('unique_stored_events', stored);
      gauge('generator_dropped_iterations', dropped);
    },
    close() {
      registry.clear();
    },
  };
}
