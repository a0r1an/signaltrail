export function capacityTargets({ profile, runId }) {
  const common = { environment: 'test', profile, run_id: runId };
  return [
    { targets: ['host.docker.internal:34105'], labels: { ...common, job: 'signaltrail-capacity' } },
    {
      targets: ['host.docker.internal:34107'],
      labels: { ...common, job: 'signaltrail-capacity-host' },
    },
    {
      targets: ['host.docker.internal:34105'],
      labels: {
        ...common,
        job: 'signaltrail-capacity-processor',
        __metrics_path__: '/processor-metrics',
      },
    },
    {
      targets: ['host.docker.internal:34105'],
      labels: {
        ...common,
        job: 'signaltrail-capacity-redpanda',
        __metrics_path__: '/broker-metrics',
      },
    },
  ];
}
