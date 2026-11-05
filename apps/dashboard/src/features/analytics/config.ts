export interface AnalyticsServiceConfig {
  clickhouse: { endpoint: string; username: string; password: string };
  membership: { connectionString: string; tls: boolean; ca?: string };
}
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
/** Server-only configuration values. Callers must never serialize or log this object. */
export function getAnalyticsServiceConfig(
  env: Record<string, string | undefined>,
): AnalyticsServiceConfig | null {
  const endpoint = env.SIGNALTRAIL_CLICKHOUSE_READ_URL;
  const username = env.SIGNALTRAIL_CLICKHOUSE_READ_USER;
  const password = env.SIGNALTRAIL_CLICKHOUSE_READ_PASSWORD;
  const connectionString = env.SIGNALTRAIL_MEMBERSHIP_DATABASE_URL;
  const ca = env.SIGNALTRAIL_MEMBERSHIP_CA;
  const tlsValue = env.SIGNALTRAIL_MEMBERSHIP_TLS ?? 'true';
  if (
    !endpoint ||
    !username ||
    !password ||
    !connectionString ||
    !['true', 'false'].includes(tlsValue) ||
    /[:\r\n]/.test(username) ||
    /[\r\n]/.test(password) ||
    Buffer.byteLength(username) > 1024 ||
    Buffer.byteLength(password) > 16384 ||
    Buffer.byteLength(endpoint) > 8192 ||
    Buffer.byteLength(connectionString) > 8192 ||
    (ca !== undefined && (!ca.trim() || Buffer.byteLength(ca) > 65536 || tlsValue === 'false'))
  )
    return null;
  try {
    const storage = new URL(endpoint),
      membership = new URL(connectionString);
    if (
      (storage.protocol !== 'https:' &&
        !(storage.protocol === 'http:' && loopback(storage.hostname))) ||
      storage.username ||
      storage.password ||
      storage.search ||
      storage.hash ||
      !['postgres:', 'postgresql:'].includes(membership.protocol) ||
      !membership.hostname ||
      !membership.username ||
      !membership.password ||
      membership.pathname.length < 2 ||
      membership.search ||
      membership.hash ||
      (tlsValue === 'false' && !loopback(membership.hostname))
    )
      return null;
    return {
      clickhouse: { endpoint, username, password },
      membership: { connectionString, tls: tlsValue === 'true', ...(ca ? { ca } : {}) },
    };
  } catch {
    return null;
  }
}
