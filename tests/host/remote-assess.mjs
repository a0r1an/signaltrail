// Pure assessment for remote host runs: CPU from /proc/stat, the generator-side
// ledger, per-stage pass/fail and the measured limits.

/**
 * Aggregate `cpu` line: user nice system idle iowait irq softirq steal guest guest_nice.
 * Busy excludes steal: time the hypervisor takes is not the instance's own use.
 */
export function parseProcStat(text) {
  const line = text.split('\n').find((row) => row.startsWith('cpu '));
  if (!line) throw new Error('No aggregate cpu line');
  const [user, nice, system, idle, iowait, irq, softirq, steal] = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { busy: user + nice + system + irq + softirq, steal, total };
}

/** Instance-level percentages, matching how burstable baselines are stated. */
export function cpuBetween(a, b) {
  const total = b.total - a.total;
  return {
    busyPercent: (100 * (b.busy - a.busy)) / total,
    stealPercent: (100 * (b.steal - a.steal)) / total,
  };
}

// Strongest first: an event the server accepted stays accepted.
const OUTCOMES = ['accepted', 'retry', 'rejected', 'transport_error'];

/** k6 writes one JSON line per event: what the client was told. */
export function parseLedger(text) {
  const entries = {};
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (typeof record?.id !== 'string' || !OUTCOMES.includes(record.status)) {
      malformed++;
      continue;
    }
    const previous = entries[record.id];
    if (!previous || OUTCOMES.indexOf(record.status) < OUTCOMES.indexOf(previous))
      entries[record.id] = record.status;
  }
  return { entries, malformed };
}

export function reconcile(ledger, storedIds) {
  const stored = new Set(storedIds);
  let accepted = 0,
    acceptedMissing = 0,
    ambiguousStored = 0;
  for (const [id, status] of Object.entries(ledger)) {
    if (status === 'accepted') {
      accepted++;
      if (!stored.has(id)) acceptedMissing++;
    } else if (stored.has(id)) ambiguousStored++;
  }
  const storedUnknown = [...stored].filter((id) => !(id in ledger)).length;
  return { accepted, acceptedMissing, ambiguousStored, storedUnknown, stored: stored.size };
}

/**
 * Failure means a client-visible problem or lost data. Running above a burstable
 * baseline is not a failure; it marks the end of the sustainable range.
 */
export function assessStage(stage, { baselinePercent, maxP95Ms = 500, maxP99Ms = 2000 }) {
  const reasons = [];
  const { k6, reconcile: totals } = stage;
  if (totals.acceptedMissing)
    reasons.push(`Accepted events missing from storage: ${totals.acceptedMissing}`);
  if (totals.storedUnknown)
    reasons.push(`Stored events without a client outcome: ${totals.storedUnknown}`);
  if (k6.dropped) reasons.push(`Generator dropped iterations: ${k6.dropped}`);
  if (k6.retry) reasons.push(`Retry responses: ${k6.retry}`);
  if (k6.rejected) reasons.push(`Rejected events: ${k6.rejected}`);
  if (!(k6.accepted > 0)) reasons.push('No accepted events');
  if (!(k6.p95 <= maxP95Ms)) reasons.push(`HTTP p95 ${k6.p95} ms exceeds ${maxP95Ms} ms`);
  if (!(k6.p99 <= maxP99Ms)) reasons.push(`HTTP p99 ${k6.p99} ms exceeds ${maxP99Ms} ms`);
  if (!stage.drained) reasons.push('Storage did not drain after traffic');
  return {
    passed: reasons.length === 0,
    withinBaseline: stage.cpu.busyPercent <= baselinePercent,
    reasons,
  };
}

/**
 * Ramp stages in increasing rate order. Sustained: every stage up to it passed within
 * the baseline. Burst: every stage up to it passed. Stops at the first failure.
 */
export function findLimits(stages) {
  let sustained = 0,
    burst = 0,
    firstFailure,
    stillSustained = true;
  for (const stage of stages) {
    if (!stage.passed) {
      firstFailure = stage.rate;
      break;
    }
    burst = stage.rate;
    stillSustained &&= stage.withinBaseline;
    if (stillSustained) sustained = stage.rate;
  }
  return {
    sustainedEventsPerSecond: sustained,
    burstEventsPerSecond: burst,
    firstFailureEventsPerSecond: firstFailure,
  };
}

/** infra/host/probe.sh output reduced to the numbers that size the host. */
export function summarizeProbe(probe) {
  const job = (name) => probe.fio[name].jobs[0];
  const ms = (ns) => Math.round(ns / 1e4) / 100;
  return {
    instanceType: probe.instanceType,
    dataFilesystem: probe.dataFilesystem,
    fsyncWritesPerSecond: Math.round(job('fsync').write.iops),
    fsyncP99Ms: ms(job('fsync').sync.lat_ns.percentile['99.000000']),
    randomReadIops: Math.round(job('randread').read.iops),
    randomReadP99Ms: ms(job('randread').read.clat_ns.percentile['99.000000']),
    sequentialWriteMBps: Math.round(job('seqwrite').write.bw / 1024),
  };
}
