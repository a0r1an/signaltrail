import { expect, it } from 'vitest';
import { parseListenConfig } from '../../src/listen-config.ts';

it('defaults to loopback-only listeners', () => {
  expect(parseListenConfig({})).toEqual({
    host: '127.0.0.1',
    port: 4100,
    metricsHost: '127.0.0.1',
    metricsPort: 9464,
  });
});

it('lets a container bind all interfaces explicitly', () => {
  expect(
    parseListenConfig({
      SIGNALTRAIL_INGESTION_HOST: '0.0.0.0',
      PORT: '8080',
      SIGNALTRAIL_METRICS_HOST: '0.0.0.0',
      SIGNALTRAIL_METRICS_PORT: '9100',
    }),
  ).toEqual({ host: '0.0.0.0', port: 8080, metricsHost: '0.0.0.0', metricsPort: 9100 });
});

it.each([
  [{ PORT: '0' }, 'PORT must be from 1 to 65535'],
  [{ PORT: 'http' }, 'PORT must be from 1 to 65535'],
  [{ SIGNALTRAIL_METRICS_PORT: '4100' }, 'Metrics port must be valid and differ'],
  [{ SIGNALTRAIL_INGESTION_HOST: 'example.com' }, 'Listen host must be an IP address'],
  [{ SIGNALTRAIL_METRICS_HOST: '' }, 'Listen host must be an IP address'],
])('rejects invalid listener configuration %o', (env, message) => {
  expect(() => parseListenConfig(env)).toThrow(message);
});
