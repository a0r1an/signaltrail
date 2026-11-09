export function assessCapacityStage(summary) {
  const reasons = [];
  const value = (name, field) => summary?.metrics?.[name]?.values?.[field];
  if (!(
    Number.isSafeInteger(value('events_accepted', 'count')) && value('events_accepted', 'count') > 0
  ))
    reasons.push('No accepted events');
  for (const name of ['events_retry', 'events_rejected', 'responses_malformed']) {
    if (value(name, 'count') !== 0) reasons.push(`${name} is nonzero or missing`);
  }
  if ((value('dropped_iterations', 'count') ?? 0) !== 0)
    reasons.push('Generator dropped iterations');
  if (value('http_req_failed', 'rate') !== 0) reasons.push('HTTP failures');
  for (const [field, max] of [
    ['p(95)', 500],
    ['p(99)', 2000],
  ]) {
    const n = value('http_req_duration', field);
    if (!Number.isFinite(n) || n < 0 || n > max)
      reasons.push(`HTTP ${field} exceeds ${max} ms or is missing`);
  }
  return reasons;
}

export function capacityWorkloads(profile) {
  if (
    [
      'capacity-4gb-db4-long',
      'capacity-4gb-db8-long',
      'capacity-4gb-db8-q24',
      'capacity-4gb-db8-q24-noqueries',
      'capacity-4gb-db8-q24-generator',
    ].includes(profile)
  )
    return [{ users: 1000, rate: 100, sessionCount: 1000, durationSeconds: 300 }];
  if (['capacity-4gb-http32', 'capacity-4gb-http128', 'capacity-4gb-db8'].includes(profile))
    return [{ users: 1000, rate: 100, sessionCount: 1000, durationSeconds: 120 }];
  if (profile === 'capacity-4gb-confirm')
    return [{ users: 500, rate: 50, sessionCount: 1000, durationSeconds: 180 }];
  if (!['capacity-4gb', 'capacity-4gb-boundary'].includes(profile))
    throw new Error('Unknown capacity workload');
  const rates =
    profile === 'capacity-4gb-boundary'
      ? [100, 150, 175, 200]
      : [10, 25, 50, 100, 200, 400, 800, 1600];
  return rates.map((rate, index) => ({
    users: rate * 10,
    rate,
    sessionCount: 1000,
    durationSeconds: profile === 'capacity-4gb-boundary' && index === 0 ? 120 : 60,
  }));
}

export function capacityCommandTimeoutMs(profile) {
  return Math.max(
    300000,
    (Math.max(...capacityWorkloads(profile).map((s) => s.durationSeconds)) + 120) * 1000,
  );
}
