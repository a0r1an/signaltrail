# Bounded processor fetch batching — November 10

## Implementation and disposition

User authorized building/testing effective worker-side batching. The batch-capable
consumer can now ask Redpanda to collect fetches toward 64 KiB for up to 200 ms before
handing returned partition records to the existing bounded chunk processor. This
uses KafkaJS minBytes/maxWaitTimeInMs; it does not wait inside eachBatch for its
already-fetched array to grow or introduce a new application queue.

Existing byte/chunk ceilings, manual commits, storage-ack ordering, ownership checks,
heartbeats, DLQ/retry logic and cancellation remain. The fetch wait is bounded,
not total end-to-end storage latency. Partition distribution and arrival patterns
still determine actual chunk sizes. No minimum batch size is promised.

**Final default is zero/opt-in.** Set SIGNALTRAIL_PROCESSOR_BATCH_WAIT_MS=200, or
batchWaitMs:200 for a batch-capable API caller, to enable the tested candidate.
Allowed integer range 0–1000; invalid/empty settings fail closed. Positive collection
requires writeEvents. Zero retains minBytes 1/maxWait 5000, the previous immediate
return once data is available. Historical memory profiles explicitly pass 0 and
new batched profiles 200; actual fixture settings are saved and inspected.

The first implementation provisionally defaulted to 200, but after the failed long
candidate the default was restored to 0 with failing-then-passing regression tests.
This keeps a functional experiment available without adopting an unqualified
reliability change. No deployment/restart of development services or production
configuration occurred. Details: [configuration](../setup/processor-batching.md).

## Correctness verification

- Intended configuration/consumer tests failed before implementation. Final check:
  processor lint, 121 unit tests, types and build pass. Existing ack-before-commit,
  heartbeat, stale-batch, retry, DLQ, byte/chunk bounds and shutdown cases pass.
- 71 load-harness tests pass, including matched profile durations.
- Real isolated pipeline recovery passes, including paused storage, worker restart
  and ambiguous acknowledged-insert replay windows. Entry-point collection was
  provisionally200ms during this check; final default restoration does not alter
  explicitly configured200ms behavior. Artifact:
  `test-results/load/2026-11-10T19-02-01.953Z-pipeline/result.json`.
- Batched 30-second probe passes 3001 accepted/unique stored, 411 confirmed chunks/
  writes (~7.30 records/write), no refusals/drops, all three heap profiles and clean
  teardown. Artifact:
  `test-results/load/2026-11-10T19-04-24.065Z-capacity-4gb-memory-trace-heap-batched-smoke/result.json`.

## Fresh matched long trials

Both trials offer 100 singleton EPS for 900 seconds, one million seed rows, full
analytical SQL, sparse heap profiles plus 180-second idle, revised four-GiB memory
caps, target CPUs 0,1/generator 2,3 and HTTP 128/pool 8/outstanding 24. Same instrumentation
and checkout; only collection config changes 0→200. Trials are sequential on a shared
host, not randomized/repeated or exclusive-host qualification. Both fail capacity.

Baseline:
`test-results/load/2026-11-10T19-06-26.786Z-capacity-4gb-memory-trace-heap/result.json`.
Candidate:
`test-results/load/2026-11-10T19-25-45.206Z-capacity-4gb-memory-trace-heap-batched/result.json`.

| Measurement                                         | Baseline0ms   | Candidate200ms    |
| --------------------------------------------------- | ------------- | ----------------- |
| HTTP accepted / unique stored                       | 89970 /89970  | 58638 /62937      |
| Metadata / HTTP admission refusals                  | 31 /0         | 3901 /11511       |
| Per-event retry outcomes                            | 0             | 2582              |
| Invalid/incomplete responses                        | 31            | 18070             |
| Generator dropped iterations                        | 0             | 10711             |
| HTTP failure rate                                   | ~0.034%       | 22.79%            |
| HTTP p95 / p99, ms                                  | 19.24 /118.13 | 8729.96 /10266.66 |
| Selected source records / confirmed writes          | 89970 /81956  | 62944 /8607       |
| Source records per confirmed write                  | 1.098         | 7.313             |
| Worker CPU seconds, initial→final metric delta      | 126.59        | 86.14             |
| Worker CPU milliseconds per selected source record  | 1.407         | 1.369             |
| Worker RSS at final scrape, MiB                     | 113.91        | 120.20            |
| Maximum observed ClickHouse allocated, MiB          | 1046.04       | 540.04            |
| Maximum observed ClickHouse allocator resident, MiB | 1250.81       | 655.50            |
| Maximum observed ClickHouse process RSS, MiB        | 1577.73       | 941.20            |
| Maximum observed inactive analytics parts           | 56222         | 6625              |
| Sampled source lag mean / maximum                   | 2.85 /90      | 13.78 /120        |
| Analytical attempts / failed attempts               | 411 /1        | 324 /4            |
| Detected container OOM kills / restarts             | 0 /0          | 0 /0              |

Per-event retry outcomes are not worker storage retries. Malformed-response metrics
also count absent/incomplete outcomes after HTTP errors/timeouts, not just bad JSON.
Selected source records may include replayed/duplicate IDs and differ from logical
unique rows. Counts represent different populations and must not be added.

The candidate makes about 6.66 times as many source records per confirmed write,
roughly 85% fewer writes per source record. Raw 89% fewer writes also reflects fewer
delivered events, so it is not the correct standalone throughput claim. Worker CPU
per processed source record is nearly unchanged (~2.7% lower in this pair); heavy
stalls/retries and sequential shared-host runs prevent a meaningful CPU-win claim.
Final RSS is not worker peak RAM. No end-to-end event-latency percentile was measured;
source-offset lag is only a sampled backlog view, not a substitute for latency.

## Candidate stall and evidence limits

At about minute 4, resource, interval and analytical requests time out together.
One nominal one-second observer interval lasts 28.29 seconds, event-loop maximum
~21.09 seconds. Application CPU-pressure ten-second avg is 82.94% (full 62.17%); VM
load is 37.25. This is evidence of severe scheduling contention while measured
ClickHouse allocated memory remains below ~400 MiB. It is not proof that the host,
Redpanda, batching or any specific component caused it. Later candidate throughput
recovers near 100 EPS and refusal counters plateau, but the bad period remains part
of the result. A timeout is not a recorded ClickHouse memory-limit exception.

Baseline records one analytical code241 total-memory rejection. Candidate analytical
failures are four client timeouts, not code241. All 411/324 analytical IDs still have
matching terminal query logs; client timeout need not mean the server query failed.

Candidate records 4167 cancelled publications with 4167 late completions and 46 publisher
capacity refusals. Final broker completed publications 62944, unique stored 62937,
HTTP accepted 58638; final source lag 0. Equality fails after the 60-second check.
Ambiguous outcomes, replay and duplicates mean count differences alone do not prove
accepted-event loss or full delivery; no per-ID acceptance ledger reconciliation was
performed. Preserve the failed result rather than treating extra stored rows as pass.

Baseline has 73 complete memory snapshots; candidate 69 with one unavailable memory
category plus transport errors in resource/interval loops. Interval export eventually
recovers all contiguous records (baseline 1093/candidate 1004) through export. Snapshots
miss some peak intervals, so lower observed maxima are not guaranteed absolute
memory bounds. Different delivered event counts and errors also confound long-run
memory comparisons. The successful short probe separately confirms larger batches
at the full offered rate, and early pre-stall candidate memory/part samples are lower.

| Heap profile estimated live bytes, MiB | Baseline | Candidate |
| -------------------------------------- | -------- | --------- |
| Startup                                | 147.16   | 172.91    |
| Five minutes                           | 628.60   | 244.38    |
| Eleven minutes                         | 892.68   | 234.57    |
| After load                             | 815.21   | 291.46    |
| After idle                             | 649.65   | 302.35    |

Heap values are sampling estimates, not an exact memory census. Candidate idle
profile increases slightly; do not claim every idle footprint drops. Profiling
changes allocation behavior and overhead. Three idle minutes do not qualify full
obsolete-part cleanup against the effective 480-second lifetime.

All five services survive both trials without detected OOM/restart. Owned stack/
volumes removed, targets [] and lock released; no cleanup errors. Alloy forwarding
increases, aggregate remote retries rise 92000/71394; no retry-free cloud delivery
or Grafana cloud-query/render verification is claimed.

## Decision and next step

The implementation demonstrably increases batch size and lowers part creation per
processed record. The short probe passes; the long candidate is substantially worse
on reliability during a severe scheduling stall. This does **not** establish stable
100-EPS capacity or justify default enablement. Preserve opt-in 200ms and default 0.

Next isolate the CPU/scheduling stall with component CPU and fetch/heartbeat timing
on a quiet or CPU-isolated repeat before promoting batching. If necessary compare
a smaller collection window with the same evidence and bounds; do not sweep limits
blindly or blame shared-host activity without proof. Preserve ack/offset/retry safety
and measure actual stored IDs, source lag, records/write and tail latency. No memory
cap, database/HTTP gate, part-retention policy, paid host or deployment is changed.

References:
[KafkaJS fetch options](https://kafka.js.org/docs/consuming#options),
[ClickHouse insert strategy](https://clickhouse.com/docs/concepts/best-practices/selecting-an-insert-strategy).
