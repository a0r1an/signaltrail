const fields = [
  'SIGNALTRAIL_CLICKHOUSE_READ_URL',
  'SIGNALTRAIL_CLICKHOUSE_READ_USER',
  'SIGNALTRAIL_CLICKHOUSE_READ_PASSWORD',
  'SIGNALTRAIL_MEMBERSHIP_DATABASE_URL',
  'SIGNALTRAIL_MEMBERSHIP_TLS',
];
export function patchDashboardServices(source, values) {
  if (
    Object.keys(values).length !== fields.length ||
    fields.some(
      (key) => typeof values[key] !== 'string' || !values[key] || /[\r\n]/.test(values[key]),
    )
  )
    throw new Error('Invalid local service configuration');
  const kept = source
    .split(/\r?\n/)
    .filter((line) => {
      const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line.trimStart());
      return !match || !fields.includes(match[1]);
    })
    .join('\n');
  return (
    kept.replace(/\n*$/, '\n') + fields.map((key) => `${key}=${values[key]}`).join('\n') + '\n'
  );
}
