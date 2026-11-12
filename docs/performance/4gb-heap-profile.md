# Heap attribution and idle recovery — November 10

## Finding

Heap profiling changes the leading explanation for sustained memory growth:
**retained MergeTree part objects/metadata from very small inserts**, rather than
large analytical query state or internal query logging alone. This is allocation
stack attribution plus observed inactive-part counts and partial idle recovery;
it is not a proof that every byte or every historical refusal has the same cause.

User selected profiling before the previously proposed logging control. No
application gate, memory allocation, query semantics, cleanup lifetime or logging
volume was changed in the main experiment. The only added server configuration
is sparse global jemalloc allocation sampling (`jemalloc_enable_global_profiler=1`,
`jemalloc_profiler_sampling_rate=22`, roughly a 4-MiB sampling interval), without
exhaustive JemallocSample collection in trace_log. Effective server settings saved.
Profiling changes overhead, allocation placement and timing, so this is diagnostic
evidence, not an equivalent capacity comparison with earlier unprofiled trials.

## Run and verification

`load capacity-4gb-memory-trace-heap`: 900 seconds at offered 100 singleton EPS,
one million seed rows, revised four-GiB budget, target CPUs0,1/generator2,3,
HTTP128/pool8/outstanding24; followed by 180 seconds without generator or analytical
traffic. Light diagnostic reads, worker health and background work continue in idle.

Report:
`test-results/load/2026-11-10T18-21-14.140Z-capacity-4gb-memory-trace-heap/result.json`.

- 90001 accepted / 90001 unique stored, final source lag zero, no HTTP/metadata
  refusals, generator drops, event retry/reject outcomes or malformed responses.
- HTTP p95/p99 27.78/143.95 ms. All 404 analytical attempts complete and match
  terminal query-log records; no analytical memory rejection in this particular run.
- **Overall result remains failed:** one successful analytical request takes
  5959.75 ms, exceeding the two-second diagnostic-query limit. It is not reported
  as a passing capacity trial. Worker metrics also record one failed storage write
  and a scheduled retry, followed by complete reconciliation; its error cause was
  not retained in the selected analytical-only query log, so do not assume why.
- Five nonempty symbolized heap profiles, 73 memory snapshots with no unavailable
  categories and 1086 contiguous interval records through final export.
- No detected container OOM/restart; owned stack/volumes removed, discovery [] and
  load lock released. Cloud query/render remains unverified.

TDD heap parsing/delta/empty-profile validation and workload tests pass; all 70
harness units pass. Real 30-second capability probe also passes: 3000 accepted/
stored, startup/load/10-second idle profiles and successful cleanup. Artifact:
`2026-11-10T18-19-02.695Z-capacity-4gb-memory-trace-heap-smoke`.

Pinned 26.8 supports the SQL heap-profile interface; 26.9-only fragmentation
allocation tables are not used. Heap SQL requests use a 128-MiB query cap, one
thread and a 120-second request deadline; raw JSONEachRow stacks are saved before
parsing. Profile requests are excluded from diagnostic-query latency statistics.
Actual profile reads took milliseconds to ~0.2 seconds in this run. The profiler
itself still affects the workload, including memory overhead.

## What the heap owns

`system.jemalloc_profile_text` with collapsed, byte-weighted stacks records sampled
live allocations. These numbers are **sampling-derived estimates**, not an exact
census of process RSS or jemalloc allocations. Sparse samples can miss small
consumers; allocation stacks show origins, not necessarily their current owner.
Root/caller frames must not be summed repeatedly.

For a reproducible, disjoint grouping, assign each full collapsed stack once:
part-related if it contains any of `IMergeTreeDataPart`, `MergeTreeDataPartBuilder`,
`SerializationInfoByName`, `MergeTreeDataPartChecksum`, `SharedPartColumns`;
otherwise log queues if it contains `SystemLogQueue<`; otherwise other. Sum the
provided byte weights and compare the same full stack strings between snapshots.
This grouping is an analysis rule, not a ClickHouse memory-category counter.

| Snapshot                 | Profile total, MiB | Part-related, MiB | Log queues, MiB | Other, MiB |
| ------------------------ | ------------------ | ----------------- | --------------- | ---------- |
| Startup                  | 160.42             | 0 sampled         | 72.48           | 87.95      |
| Five minutes             | 613.81             | 368.03            | 85.50           | 160.28     |
| Eleven minutes           | 926.07             | 700.07            | 82.76           | 143.24     |
| After load               | 868.90             | 672.11            | 66.87           | 129.92     |
| After three idle minutes | 567.26             | 400.07            | 63.22           | 103.96     |

At eleven minutes, part-related stacks account for about 700 MiB of the 766-MiB
net estimated growth. Representative paths include part construction, per-part
estimate hash maps, serialization information and checksum metadata. Part-related
origins at that snapshot: HTTP insert path ~480 MiB, merge paths ~160 MiB, system
log saving threads ~56 MiB and other ~4 MiB. Stack context supports application
insert/merge churn as the larger contributor, not only system-log part creation.

During idle, total profile weight falls ~301.64 MiB, of which ~272.04 MiB is the
part-related group. Actual jemalloc allocated bytes independently fall from
944.31 MiB in the first idle snapshot to 683.64 MiB at the final snapshot; allocator
resident falls 1189.44→1005.62 MiB and process RSS 1535.39→1373.09 MiB. These
asynchronous values are not atomic or additive. Physical footprint recovers less
than live allocated bytes; remaining allocator overhead/fragmentation matters.
No blanket leak diagnosis or full recovery is established by three idle minutes.

Artifacts: `heap-{startup,five-minutes,eleven-minutes,after-load,after-idle}.jsonl`,
`heap-snapshots.json`, baseline stack deltas `heap-growth-*.json` and
`heap-idle-delta.json`. Intermediate sampling timings are retained exactly.

## Why many parts exist despite few active parts

Heap stacks prompted a new read-only `load part-memory` operation. It verifies an
active isolated capacity run, reads all part states plus relevant MergeTree
settings and saves a timestamped `part-memory-*.json` in that run's directory.
It performs no writes to ClickHouse or infrastructure. Four point samples:

| UTC observation              | Inactive analytics parts | Active analytics parts |
| ---------------------------- | ------------------------ | ---------------------- |
| 18:27:24, during load        | 40584                    | 10                     |
| 18:32:00, during load        | 54907                    | 8                      |
| 18:36:45, shortly after load | 48132                    | 4                      |
| 18:38:50, during idle        | 34288                    | 4                      |

Effective `old_parts_lifetime=480` seconds, cleanup delay30 plus random addition10.
Obsolete merged parts are retained before cleanup. Inactive rows/bytes overlap
successive merged versions; they are not extra logical tenant events. At the final
point sample, active analytics data is still 1090001 rows, including seed data.
Part counts are point observations, not synchronized with heap snapshot instants.
The three-minute idle period is shorter than the eight-minute retention window,
so remaining obsolete parts and memory are expected; it does not test complete
cleanup of the last generated parts. No retention setting was shortened.

Earlier continuous snapshots filtered `system.parts WHERE active`, hiding this
population. Future memory-trace snapshots now group both active states. This run's
original running loop still used the earlier active-only query; the separate
point samples supply inactive evidence without rewriting historical artifacts.

## Effective insert size connects the evidence

Final worker counters show 90001 records in 79922 chunks and 79922 confirmed storage
writes: **~1.13 records per confirmed write**, plus one failed write/retry. Existing
worker chunking supports up to 100 records/1 MiB but does not guarantee a minimum
batch size or a coalescing window; already fetched batches can be tiny at this
arrival rate. A chunk-size ceiling alone does not prevent many tiny inserts.
Each insert can also create multiple parts if events span partitions.

Many tiny writes create part objects; merges create more versions; obsolete parts
remain loaded until cleanup. That mechanism fits the named stacks, the tens of
thousands of inactive parts and the measured post-load release. It provides a
stronger sustained-growth lead than the earlier large transient query-log merge.
It does not rule out query-log maintenance spikes or independent scheduling stalls.

Official context:
[allocation profiling](https://clickhouse.com/docs/concepts/features/performance/allocation-profiling),
[data parts](https://clickhouse.com/docs/concepts/core-concepts/parts),
[part merges](https://clickhouse.com/docs/concepts/core-concepts/merges).
The docs describe delaying removal of merged parts and using larger/buffered
inserts to reduce initial part creation. Our measured part lifetime and effective
write sizes are local evidence, not defaults inferred only from documentation.

## Next action

Prioritize a controlled effective-batching comparison, preserving acknowledged
ClickHouse writes, partition ownership, retry IDs, memory bounds and source-offset
safety. Inspect the existing consumer's small-batch behavior before deciding
between bounded worker coalescing and acknowledged ClickHouse asynchronous inserts.
Keep the same offered events, memory/CPU/gates and heap/part measurements; compare
writes/sec, records/write, inactive parts, memory growth, lag and tail latency.
Do not simply lower old_parts_lifetime or raise HTTP/DB limits to mask the symptom.
Do not adopt the illustrative 100-record ceiling as a new proven optimum.

The previously proposed query-log-volume control is deferred behind this better-
attributed lead; no default batching or logging policy was changed here. A full
post-load cleanup qualification would need an idle window exceeding the effective
obsolete-part retention plus cleanup delay, not three minutes.
