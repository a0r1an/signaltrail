import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAcceptanceLedger, reconcileAcceptance } from './acceptance-ledger.mjs';

test('records the strongest server outcome per event ID', () => {
  const ledger = createAcceptanceLedger();
  ledger.record('a', 'failed');
  ledger.record('a', 'accepted');
  ledger.record('a', 'late');
  ledger.record('b', 'late');
  ledger.record('c', 'failed');
  assert.deepEqual(ledger.snapshot(), { accepted: ['a'], late: ['b'], failed: ['c'] });
  assert.throws(() => ledger.record('d', 'unknown'), /Unknown acceptance outcome/);
});

test('every accepted ID must be stored; ambiguous outcomes may or may not be', () => {
  const result = reconcileAcceptance(
    { accepted: ['a', 'b'], late: ['c', 'd'], failed: ['e', 'f'] },
    ['a', 'b', 'c', 'e'],
  );
  assert.deepEqual(result, {
    accepted: 2,
    acceptedStored: 2,
    acceptedMissing: 0,
    lateStored: 1,
    lateMissing: 1,
    failedStored: 1,
    failedMissing: 1,
    stored: 4,
    storedUnrecorded: 0,
    missingExamples: [],
    unrecordedExamples: [],
    reasons: [],
  });
});

test('reports accepted loss and stored events without an ingestion outcome', () => {
  const result = reconcileAcceptance({ accepted: ['a', 'b'], late: [], failed: [] }, ['a', 'z']);
  assert.equal(result.acceptedMissing, 1);
  assert.equal(result.storedUnrecorded, 1);
  assert.deepEqual(result.missingExamples, ['b']);
  assert.deepEqual(result.unrecordedExamples, ['z']);
  assert.deepEqual(result.reasons, [
    'Accepted events missing from storage: 1',
    'Stored events without an ingestion outcome: 1',
  ]);
});
