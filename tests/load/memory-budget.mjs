export const memoryPlan = {
  hostReserveMiB: 640,
  services: { redpanda: 1280, clickhouse: 1280, postgres: 256, valkey: 128, app: 512 },
};
export const memoryPlans = {
  'capacity-4gb-db8-q24-endurance': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-db8-q24-endurance-50': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-telemetry': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-memory-trace': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-memory-trace-async-dashboard': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-memory-trace-async-dashboard-smoke': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-memory-trace-async': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-memory-trace-async-smoke': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-memory-trace-heap': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-memory-trace-heap-batched': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-memory-trace-heap-batched-smoke': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-memory-trace-heap-smoke': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-memory-trace-smoke': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-query-memory': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-query-memory-no-text-log': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-telemetry-failure': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'capacity-4gb-db8-q24-rebalanced': {
    hostReserveMiB: 640,
    cpuSet: '0,1',
    services: { redpanda: 1280, clickhouse: 1536, postgres: 128, valkey: 128, app: 384 },
  },
  'memory-4gb': memoryPlan,
  'capacity-4gb-db8-q24-generator': { ...memoryPlan, cpuSet: '0,1' },
  'capacity-4gb-db8-q24-noqueries': { ...memoryPlan, cpuSet: '0,1' },
  'capacity-4gb-db8-q24': { ...memoryPlan, cpuSet: '0,1' },
  'capacity-4gb-db4-long': { ...memoryPlan, cpuSet: '0,1' },
  'capacity-4gb-db8-long': { ...memoryPlan, cpuSet: '0,1' },
  'capacity-4gb-db8': { ...memoryPlan, cpuSet: '0,1' },
  'capacity-4gb-http32': { ...memoryPlan, cpuSet: '0,1' },
  'capacity-4gb-http128': { ...memoryPlan, cpuSet: '0,1' },
  'capacity-4gb': { ...memoryPlan, cpuSet: '0,1' },
  'capacity-4gb-boundary': { ...memoryPlan, cpuSet: '0,1' },
  'capacity-4gb-confirm': { ...memoryPlan, cpuSet: '0,1' },
  'memory-2gb': {
    hostReserveMiB: 384,
    services: { redpanda: 640, clickhouse: 512, postgres: 128, valkey: 64, app: 320 },
  },
};
export function verifyMemoryLimits(containers, plan = memoryPlan) {
  const seen = new Set();
  for (const container of containers) {
    const service = container.Config.Labels['com.docker.compose.service'];
    const expected = plan.services[service] * 1048576;
    if (
      !expected ||
      seen.has(service) ||
      container.HostConfig.Memory !== expected ||
      container.HostConfig.MemorySwap !== expected ||
      (plan.cpuSet && container.HostConfig.CpusetCpus !== plan.cpuSet) ||
      !container.State.Running ||
      container.State.OOMKilled ||
      container.RestartCount !== 0
    )
      throw new Error(`Memory enforcement or lifecycle invariant failed: ${service}`);
    seen.add(service);
  }
  if (seen.size !== Object.keys(plan.services).length)
    throw new Error('Missing constrained services');
}
