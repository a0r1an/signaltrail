// Strongest first: a published-in-time event stays accepted whatever else is recorded.
const OUTCOMES = ['accepted', 'late', 'failed'];
const EXAMPLES = 10;

/**
 * Server-side per-ID record of what ingestion told clients. `accepted`: published before the
 * response deadline. `late`: published after the client was told to retry. `failed`: the
 * publication rejected or was cancelled; it may still have reached the broker.
 */
export function createAcceptanceLedger() {
  const outcomes = new Map();
  return {
    record(eventId, outcome) {
      const rank = OUTCOMES.indexOf(outcome);
      if (rank < 0) throw new TypeError(`Unknown acceptance outcome: ${outcome}`);
      const previous = outcomes.get(eventId);
      if (previous === undefined || rank < OUTCOMES.indexOf(previous))
        outcomes.set(eventId, outcome);
    },
    snapshot() {
      const result = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, []]));
      for (const [eventId, outcome] of outcomes) result[outcome].push(eventId);
      return result;
    },
  };
}

export function reconcileAcceptance(ledger, storedIds) {
  const stored = new Set(storedIds);
  const recorded = new Set();
  const split = (ids) => {
    let present = 0;
    const missing = [];
    for (const id of ids) {
      recorded.add(id);
      if (stored.has(id)) present++;
      else missing.push(id);
    }
    return [present, missing];
  };
  const [acceptedStored, missing] = split(ledger.accepted);
  const [lateStored, lateMissing] = split(ledger.late);
  const [failedStored, failedMissing] = split(ledger.failed);
  const unrecorded = [...stored].filter((id) => !recorded.has(id));
  const reasons = [];
  if (missing.length) reasons.push(`Accepted events missing from storage: ${missing.length}`);
  if (unrecorded.length)
    reasons.push(`Stored events without an ingestion outcome: ${unrecorded.length}`);
  return {
    accepted: ledger.accepted.length,
    acceptedStored,
    acceptedMissing: missing.length,
    lateStored,
    lateMissing: lateMissing.length,
    failedStored,
    failedMissing: failedMissing.length,
    stored: stored.size,
    storedUnrecorded: unrecorded.length,
    missingExamples: missing.slice(0, EXAMPLES),
    unrecordedExamples: unrecorded.slice(0, EXAMPLES),
    reasons,
  };
}
