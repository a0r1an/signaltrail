import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessStage,
  cpuBetween,
  findLimits,
  parseLedger,
  parseProcStat,
  reconcile,
  summarizeProbe,
} from './remote-assess.mjs';

test('parses the aggregate cpu line of /proc/stat, including steal', () => {
  assert.deepEqual(parseProcStat('cpu  100 5 50 800 10 0 5 30 0 0\ncpu0 1 2 3 4\nintr 1'), {
    busy: 160,
    steal: 30,
    total: 1000,
  });
});

test('CPU utilisation between samples counts steal separately from busy time', () => {
  const a = { busy: 100, steal: 10, total: 1000 };
  const b = { busy: 300, steal: 60, total: 2000 };
  assert.deepEqual(cpuBetween(a, b), { busyPercent: 20, stealPercent: 5 });
});

test('the k6 ledger keeps the strongest outcome per event', () => {
  const lines = [
    '{"id":"a","status":"retry"}',
    '{"id":"a","status":"accepted"}',
    '{"id":"b","status":"rejected"}',
    'not json',
    '{"id":"c","status":"transport_error"}',
  ].join('\n');
  assert.deepEqual(parseLedger(lines), {
    entries: { a: 'accepted', b: 'rejected', c: 'transport_error' },
    malformed: 1,
  });
});

test('reconciles accepted IDs with storage; ambiguous outcomes may be stored', () => {
  const ledger = { a: 'accepted', b: 'accepted', c: 'retry', d: 'transport_error' };
  assert.deepEqual(reconcile(ledger, ['a', 'c', 'z']), {
    accepted: 2,
    acceptedMissing: 1,
    ambiguousStored: 1,
    storedUnknown: 1,
    stored: 3,
  });
});

const stage = {
  rate: 10,
  k6: { accepted: 600, retry: 0, rejected: 0, dropped: 0, p95: 20, p99: 80 },
  reconcile: { accepted: 600, acceptedMissing: 0, storedUnknown: 0 },
  cpu: { busyPercent: 12, stealPercent: 0 },
  drained: true,
};

test('a stage passes when nothing is lost, latency holds and storage drained', () => {
  assert.deepEqual(assessStage(stage, { baselinePercent: 20 }), {
    passed: true,
    withinBaseline: true,
    reasons: [],
  });
});

test('CPU above the burstable baseline is reported separately from failure', () => {
  const result = assessStage(
    { ...stage, cpu: { busyPercent: 35, stealPercent: 2 } },
    { baselinePercent: 20 },
  );
  assert.equal(result.passed, true);
  assert.equal(result.withinBaseline, false);
});

test('loss, latency, drops, retries and an undrained pipeline fail a stage', () => {
  const result = assessStage(
    {
      ...stage,
      k6: { accepted: 590, retry: 3, rejected: 0, dropped: 4, p95: 700, p99: 2500 },
      reconcile: { accepted: 590, acceptedMissing: 1, storedUnknown: 2 },
      drained: false,
    },
    { baselinePercent: 20 },
  );
  assert.equal(result.passed, false);
  assert.deepEqual(result.reasons, [
    'Accepted events missing from storage: 1',
    'Stored events without a client outcome: 2',
    'Generator dropped iterations: 4',
    'Retry responses: 3',
    'HTTP p95 700 ms exceeds 500 ms',
    'HTTP p99 2500 ms exceeds 2000 ms',
    'Storage did not drain after traffic',
  ]);
});

test('limits: highest rate within baseline and highest passing rate before first failure', () => {
  const stages = [
    { rate: 1, passed: true, withinBaseline: true },
    { rate: 10, passed: true, withinBaseline: true },
    { rate: 25, passed: true, withinBaseline: false },
    { rate: 50, passed: false, withinBaseline: false },
    { rate: 100, passed: true, withinBaseline: false },
  ];
  assert.deepEqual(findLimits(stages), {
    sustainedEventsPerSecond: 10,
    burstEventsPerSecond: 25,
    firstFailureEventsPerSecond: 50,
  });
});

test('summarizes the disk probe: fsync, random read and sequential write', () => {
  const job = (fields) => ({ jobs: [fields] });
  assert.deepEqual(
    summarizeProbe({
      instanceType: 't4g.medium',
      dataFilesystem: 'ext4',
      fio: {
        fsync: job({
          write: { iops: 812.4 },
          sync: { lat_ns: { percentile: { '99.000000': 2500000 } } },
        }),
        randread: job({
          read: { iops: 3001.7, clat_ns: { percentile: { '99.000000': 1200000 } } },
        }),
        seqwrite: job({ write: { bw: 128000 } }),
      },
    }),
    {
      instanceType: 't4g.medium',
      dataFilesystem: 'ext4',
      fsyncWritesPerSecond: 812,
      fsyncP99Ms: 2.5,
      randomReadIops: 3002,
      randomReadP99Ms: 1.2,
      sequentialWriteMBps: 125,
    },
  );
});
