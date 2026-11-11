import { isIP } from 'node:net';

/** Loopback by default; containers opt in to all interfaces explicitly. */
export function parseListenConfig(env: Record<string, string | undefined>) {
  const host = (name: string) => {
    const value = env[name] ?? '127.0.0.1';
    if (!isIP(value)) throw new TypeError('Listen host must be an IP address');
    return value;
  };
  const port = Number(env.PORT ?? 4100);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new RangeError('PORT must be from 1 to 65535');
  const metricsPort = Number(env.SIGNALTRAIL_METRICS_PORT ?? 9464);
  if (
    !Number.isInteger(metricsPort) ||
    metricsPort < 1 ||
    metricsPort > 65535 ||
    metricsPort === port
  )
    throw new RangeError('Metrics port must be valid and differ from the ingestion port');
  return {
    host: host('SIGNALTRAIL_INGESTION_HOST'),
    port,
    metricsHost: host('SIGNALTRAIL_METRICS_HOST'),
    metricsPort,
  };
}
