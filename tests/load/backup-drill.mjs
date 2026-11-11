const HOUR_S = 3600;

/** Recovery objectives from OPEN_QUESTIONS: four-hour RTO, best-effort one-hour RPO. */
export const RECOVERY_OBJECTIVES = { rtoSeconds: 4 * HOUR_S, rpoSeconds: HOUR_S };

/**
 * Compares the primary's state at the last backup with the replacement host after restore.
 * Writes made after the last backup are the RPO window: they must be absent, not partial.
 */
export function assessBackupDrill({
  expected,
  restored,
  afterBackupRestored,
  restoreSeconds,
  objectives = RECOVERY_OBJECTIVES,
}) {
  const reasons = [];
  for (const [name, value] of Object.entries(expected))
    if (JSON.stringify(restored[name]) !== JSON.stringify(value))
      reasons.push(`Restored ${name} differs from the backed-up state`);
  for (const name of Object.keys(restored))
    if (!(name in expected)) reasons.push(`Restored ${name} has no backed-up counterpart`);
  if (afterBackupRestored !== 0)
    reasons.push(`Writes after the last backup were restored: ${afterBackupRestored}`);
  if (!(restoreSeconds >= 0) || restoreSeconds > objectives.rtoSeconds)
    reasons.push(`Restore took ${restoreSeconds} s; objective is ${objectives.rtoSeconds} s`);
  return reasons;
}
