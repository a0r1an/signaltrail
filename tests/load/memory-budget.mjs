export const memoryPlan = {
  hostReserveMiB: 640,
  services: { redpanda: 1280, clickhouse: 1280, postgres: 256, valkey: 128, app: 512 },
};
export function verifyMemoryLimits(containers) {
  const seen = new Set();
  for (const container of containers) {
    const service = container.Config.Labels['com.docker.compose.service'];
    const expected = memoryPlan.services[service] * 1048576;
    if (
      !expected ||
      seen.has(service) ||
      container.HostConfig.Memory !== expected ||
      container.HostConfig.MemorySwap !== expected ||
      !container.State.Running ||
      container.State.OOMKilled ||
      container.RestartCount !== 0
    )
      throw new Error(`Memory enforcement or lifecycle invariant failed: ${service}`);
    seen.add(service);
  }
  if (seen.size !== Object.keys(memoryPlan.services).length)
    throw new Error('Missing constrained services');
}
