import { expect, it } from 'vitest';
import { getAnalyticsServiceConfig } from '../../src/features/analytics/config';
const env = {
  SIGNALTRAIL_CLICKHOUSE_READ_URL: 'http://127.0.0.1:8123',
  SIGNALTRAIL_CLICKHOUSE_READ_USER: 'reader',
  SIGNALTRAIL_CLICKHOUSE_READ_PASSWORD: 'fixture',
  SIGNALTRAIL_MEMBERSHIP_DATABASE_URL: 'postgres://reader:fixture@localhost:5433/signaltrail',
  SIGNALTRAIL_MEMBERSHIP_TLS: 'false',
};
it('accepts explicit loopback development services without inventing default credentials', () => {
  expect(getAnalyticsServiceConfig(env)).toEqual({
    clickhouse: {
      endpoint: env.SIGNALTRAIL_CLICKHOUSE_READ_URL,
      username: 'reader',
      password: 'fixture',
    },
    membership: { connectionString: env.SIGNALTRAIL_MEMBERSHIP_DATABASE_URL, tls: false },
  });
});
it.each([
  {},
  { SIGNALTRAIL_CLICKHOUSE_READ_PASSWORD: '' },
  { SIGNALTRAIL_CLICKHOUSE_READ_URL: 'http://remote.invalid' },
  { SIGNALTRAIL_CLICKHOUSE_READ_URL: 'https://user:password@remote.invalid' },
  { SIGNALTRAIL_MEMBERSHIP_DATABASE_URL: 'postgres://reader:fixture@remote.invalid/signaltrail' },
  { SIGNALTRAIL_MEMBERSHIP_TLS: 'no' },
  { SIGNALTRAIL_CLICKHOUSE_READ_USER: 'user\nprivate' },
  { SIGNALTRAIL_MEMBERSHIP_CA: 'certificate' },
])('fails closed for missing or insecure service configuration: %j', (patch) => {
  expect(
    getAnalyticsServiceConfig(Object.keys(patch).length ? { ...env, ...patch } : {}),
  ).toBeNull();
});
it('requires verified TLS for remote services', () => {
  const configured = getAnalyticsServiceConfig({
    ...env,
    SIGNALTRAIL_CLICKHOUSE_READ_URL: 'https://storage.example.com',
    SIGNALTRAIL_MEMBERSHIP_DATABASE_URL:
      'postgres://reader:fixture@metadata.example.com/signaltrail',
    SIGNALTRAIL_MEMBERSHIP_TLS: 'true',
  });
  expect(configured?.membership.tls).toBe(true);
});
