# Query failure recovery and ClickHouse memory investigation

November 9 follow-up (artifacts use November 10 UTC).

## Telemetry recovery

Resource sampling, interval export and analytical queries use independent serial
loops. Each waits two seconds after its own attempt; a slow/failed analytical
request no longer blocks either telemetry loop. Failures append immediately to
`observation-errors.jsonl` and print to stderr. Attempts continue, but every error
still makes the run fail. Artifact-write errors propagate rather than disappearing.
Analytical cadence differs from the historical combined loop (roughly two seconds
plus SQL time now, versus resource sampling plus SQL plus two seconds previously).
Future comparisons must use the corrected harness on both sides.

TDD verified retry/report ordering, telemetry progressing while a query is pending,
and propagation of persistence failures. All 65 load-harness tests pass.

Real fault probe: `load capacity-4gb-telemetry-failure`, report
`test-results/load/2026-11-10T00-59-00.070Z-capacity-4gb-telemetry-failure/result.json`.
The first analytical request alone uses `max_memory_usage=1`, causing real
ClickHouse HTTP 500/code 241. Expected process exit 1 / failed capacity report.
Artifact assertions verify exactly one analytical error, 16 analytical attempts,
3001 accepted/unique stored, seven resource samples extending past the error,
36 contiguous interval records through export and no cleanup error. The original
error is retained. Resources removed, targets withdrawn and lock released.
This verifies recovery/observation behavior, not passing capacity.

## Memory probe

`load capacity-4gb-query-memory` retains the revised four-GiB allocation, target
CPUs 0,1 / generator 2,3, gates HTTP128/pool8/outstanding24, one million seed rows
and full analytical traffic. It runs 120 seconds at offered 100 EPS. Before and
after traffic, three rounds of five serial query controls record response timing
and actual query-log memory/read/spill data. Distinct phase/query IDs are checked
for exactly one QueryFinish with positive measured memory. Reports are
`query-memory-before.json` and `query-memory-after.json`.

Authoritative corrected baseline report:
`test-results/load/2026-11-10T01-04-13.968Z-capacity-4gb-query-memory/result.json`.
Passes 12001 accepted/unique stored, zero refusals, retries or generator drops,
final source lag zero; HTTP p99 58.54 ms, 59 analytical attempts. All 30 phase
controls succeed; 129 interval records are contiguous through export. No OOM or
restart. Owned cleanup succeeds. This is a short diagnostic pass, not endurance.

An earlier exploratory report at `2026-11-10T01-00-49.373Z` also passed, but reused
query IDs before/after and mixed 30 log rows in the final lookup. It is not used
for the phase comparisons below. IDs/files were corrected and a fresh run verified.

| Query control | Before traffic memory, MiB | After traffic memory, MiB |
| --- | --- | --- |
| Original FINAL + count + uniqExact | 14.87–14.88 | 14.42 |
| Same query, max_threads=1 | 14.87 | 14.42 |
| Same query, external group-by threshold 16 MiB | 14.87 | 14.42 |
| FINAL + count only | 11.08–11.97 | 10.83 |
| No-FINAL diagnostic control | 9.85–10.33 | 10.39 |

All spill-part counters are zero; the spill setting did not exercise spilling.
Post-traffic client timing ranges are baseline 40.27–97.11 ms, one thread
49.37–77.67 ms, spill 43.03–53.77 ms, count-only 18.00–19.62 ms and no-FINAL
27.79–28.75 ms. Three ordered repetitions do not establish performance superiority.
Removing FINAL changes replacement/deduplication semantics and is not adopted.
Count-only also drops the distinct-visitor result. No product query was changed.

Pinned server reports effective `max_server_memory_usage=1435034419` bytes
(~1368.56 MiB/1.34 GiB), ratio 0.9, container cap 1536 MiB, `max_threads=auto(2)`,
per-query max_memory_usage=0 and external group-by byte threshold=0 with ratio=0.5.
These live values distinguish server-wide tracking, query tracking and the cgroup.
The earlier error's `(total)` limit was server-wide; it does **not** show one
aggregation required 1.33 GiB. This probe's query peaks are only about 14–15 MiB.
It does not measure the failed query from the old destroyed fixture.

Server `MemoryTracking` grows 285.53→446.37 MiB across the short baseline.
That measurement differs from process RSS, allocator/caches and cgroup current.
The last traffic cgroup sample is ~1497.5 MiB: anon ~438 MiB, file ~767 MiB,
kernel ~267 MiB. Reclaimable file/cache bytes are not equivalent to live query
memory. The cgroup is near its cap even though query peaks are small. No complete
accounting of retained memory has yet been established.

The fixture has 10000 seed distinct IDs and 1000 traffic distinct IDs. One million
rows therefore do not imply one million exact-distinct states. ClickHouse documents
that uniqExact memory grows with distinct cardinality, so higher-cardinality retained
data still needs qualification. See [uniqExact documentation](https://clickhouse.com/docs/reference/functions/aggregate-functions/uniqExact).
Query logs provide per-query memory, exception and profile data; see
[query-log documentation](https://clickhouse.com/docs/reference/system-tables/query_log).

## Single-variable internal text-log control

Baseline produces 334482 rows in system.text_log by its post-traffic part snapshot.
To test that specific suspect, `load capacity-4gb-query-memory-no-text-log` adds
only isolated `tests/load/compose.no-text-log.yaml`, mounting an XML removal of
internal text_log. Server file/stdout logs, query logs and other system logs remain.
No application/development/production configuration is changed.

Report:
`test-results/load/2026-11-10T01-08-06.550Z-capacity-4gb-query-memory-no-text-log/result.json`.
Passes 12001 accepted/unique stored, no refusals/retries/generator drops, source lag
zero, HTTP p99 32.70 ms, 59 analytical attempts. All 30 controls succeed with
validated distinct query-log rows, 128 contiguous intervals, no OOM/restart and
successful cleanup. Both phase snapshots have no text_log parts.

| Server tracking | Baseline | Text log disabled |
| --- | --- | --- |
| Before traffic, MiB | 285.53 | 292.93 |
| After traffic, MiB | 446.37 | 457.65 |
| Growth, MiB | 160.84 | 164.72 |
| Post-traffic baseline aggregation peak, MiB | 14.42 | 14.42 |

Disabling text_log does not reduce tracked-memory growth in this pair. It is not
supported as the dominant explanation or proposed as a fix. Ordered, shared-host
short trials cannot rule out every effect or prove the cause of the old long run.
Do not infer a latency improvement from one p99 comparison. Other system logs,
background/insert buffers, allocator retention and sustained memory evolution
remain candidates requiring attribution rather than assumption.

Alloy forwarding increases in both probes; aggregate retry counters also rise.
No retry-free cloud delivery or Grafana cloud query/render verification is claimed.

## Conclusion and exact next step

Telemetry now survives analytical failures, demonstrated against real ClickHouse.
Neither higher database/HTTP gates, one analytical thread, the tested spill setting,
removing FINAL nor disabling text_log is justified as the fix by these measurements.
No default limit or semantics changed. The concrete open issue is sustained broader
ClickHouse memory pressure plus the separately observed late scheduling stalls.

Next: capture ClickHouse server memory categories, jemalloc allocated/resident/retained,
insert/background activity and system-log buffering continuously during a bounded
12–15-minute reproduction, retaining both successful and failed query-log memory
by ID. Use the repaired loops so the first rejection cannot stop observation. Then
choose one evidenced memory control and compare it under unchanged application
limits; do not repeat another 30 minutes blind or declare 100 EPS stable. Actual-host
CPU-credit/disk/OS/retention/maintenance qualification still remains.
