# Fifteen-minute ClickHouse memory trace — November 10

## Outcome

User authorized tracing sustained ClickHouse memory under unchanged application
limits. `load capacity-4gb-memory-trace` ran 900 seconds at offered 100 singleton
EPS, one million historical rows, revised four-GiB allocation (1536 MiB ClickHouse,
384 app, 128 PostgreSQL, 1280 Redpanda, 128 Valkey, 640 host allowance), targets
on CPUs 0,1 and generator on 2,3. HTTP128 / metadata pool8 / outstanding24.
Internal text logging remains enabled; no memory control or default was changed.

Report:
`test-results/load/2026-11-10T17-51-52.377Z-capacity-4gb-memory-trace/result.json`.

**Failed capacity; diagnostic evidence retained completely through export.**

| Measurement | Result |
| --- | --- |
| HTTP accepted / unique stored | 88272 / 88272 |
| Metadata / HTTP admission refusals | 1285 / 82 |
| Invalid/incomplete response outcomes | 1367 |
| Generator dropped iterations | 361 |
| HTTP failure rate | 1.525% |
| HTTP p95 / p99 | 211.01 / 1210.17 ms |
| Analytical attempts / memory-limit exceptions | 387 / 2 |
| Successful analytical maximum client time | 5192.79 ms |
| Final source lag / drain time | 0 / 0.05 seconds |
| Publication retries, cancellations, late completions | 0 |
| Detected container OOM kills / restarts | 0 / 0 |

All 387 analytical IDs have a matching terminal query-log record, including the two
exceptions. Analytical requests continued after rejection. There are 61 memory
snapshots with zero unavailable categories, 171 Docker/resource samples and 895
contiguous interval records through final export. Interval ticks are nominally one
second; stalls mean record count is not elapsed seconds. Capacity failure remains
reported as failure; no diagnostics or resource-cleanup error occurred. All five
services were running at lifecycle capture; owned stack/volumes subsequently
removed, discovery withdrawn to [] and load lock released.

## Observation and verification

Three bounded diagnostic SQL statements every 15 seconds collect:

- Async memory/cache/cgroup/jemalloc metrics and current memory/merge/query/insert/
  profiler counters, with source labels preserved.
- Actual active merges by database/table, their part count and memory usage.
- Active-part row/byte totals by database/table, including internal system logs.

Each statement uses one thread and a 64-MiB query cap. Partial snapshots preserve
successful categories and explicitly report missing ones; failures do not stop the
other observation loops. This adds observer load relative to historical trials.
Snapshots are sequential, not an atomic view; async allocator metrics can be stale
relative to current metrics and merge-table reads. Do not sum them as disjoint
contemporaneous allocations. Fifteen-second samples miss short peaks.

Every analytical attempt is written immediately with ID/start/end/duration/outcome
in `analytical-attempts.jsonl`. Cleanup flushes query logs and saves matching
terminal memory/exception records in `analytical-query-log.jsonl`, even after a
failed stage. Memory history is `clickhouse-memory.jsonl`; original interval and
Docker artifacts remain separate. No tenant data or external credentials involved.

TDD observed partial-evidence and workload/profile failures before implementation;
all 67 harness unit tests pass. Initial 30-second real instrument check:
`2026-11-10T17-49-28.181Z-capacity-4gb-memory-trace-smoke`. Four error-free memory
snapshots, 14/14 analytical ID matches, complete interval export and cleanup pass.
Its traffic fails with 120 metadata refusals, 137 generator drops, 2744 accepted/
stored and p95 873.37 ms. It is not described as a passing capacity smoke.

## The failed queries were small

First failed attempt 308 starts at 18:03:54.260 UTC, about 11 minutes 47 seconds
into traffic. Query log: code 241, memory 15833185 bytes (**15.10 MiB**), duration
3832 ms. Attempt 321 also fails, recording 18042061 bytes (**17.21 MiB**), 851 ms.
Both are `(total)` server-memory rejections selected by OvercommitTracker while
executing AggregatingTransform; error messages report total limits around 1.32 GiB.

Successful analytical query memory spans 12.49–17.80 MiB, median 15.61 MiB.
Failed-query memory is within this successful range. This directly supports a
server-wide headroom problem rather than a query suddenly needing a GiB. It does
not identify the allocation that exhausted headroom or prove the best control.

## Broader memory growth and allocator contribution

All values below are MiB from the first/last snapshots and observed maxima; these
are different accounting views, not additive components of guest memory.

| Counter | First | Last | Sampled maximum |
| --- | --- | --- | --- |
| ClickHouse MemoryTracking | 319.24 | 922.55 | 1085.48 |
| jemalloc allocated | 288.80 | 899.98 | 1030.14 |
| jemalloc active | 349.88 | 1090.56 | 1222.25 |
| jemalloc resident | 355.19 | 1106.31 | 1240.19 |
| jemalloc fragmentation | 61.08 | 190.58 | 200.86 |
| Process MemoryResident | 737.05 | 1512.89 | 1577.02 |
| Merge/mutation tracking | 0 | 0 | 247.83 |
| Mark cache bytes | 0.01 | 0.05 | 0.07 |
| Uncompressed/query cache bytes | 0 | 0 | 0 |

Live allocator allocations increase about **611 MiB**; reported fragmentation grows
about **130 MiB**. The rise is not just unused virtual mappings or the named read
caches. RSS includes more than allocator allocations; this trace does not fully
attribute that difference. RSS and cgroup charging are different views, and stale/
shared-page accounting means neither should be substituted for the other.

Jemalloc retained reaches roughly 2.4 GiB, but this is virtual address space retained
for reuse, not 2.4 GiB of physical RAM. Its resident statistic is also an allocator
accounting bound rather than an exact process-RSS reading. Definitions:
[jemalloc manual](https://jemalloc.net/jemalloc.3.html#stats.retained).

Last traffic cgroup sample: current ~1448.4 MiB of 1536; anon ~1013.2 MiB, file
~297.2 MiB, kernel ~137.9 MiB. Max-limit events reach 47318, pressure totals
some/full 18.81/11.69 seconds; no OOM event/kill. Cache reclaim/cap pressure is
real without an OOM kill. No claim of whole-guest four-GiB qualification is made.

## Background work is now a measured suspect

An actual merge of **system.query_log** was sampled using 421110618 bytes
(**401.60 MiB**). Other captured merges include analytics_events up to 89.02 MiB
and system.metric_log up to 85.73 MiB. The query-log peak is larger than any single
analytical query by more than an order of magnitude.

That large query-log merge was sampled earlier than the two exceptions, so it is
**not** proof that the same merge caused those failures. Current merge/mutation
counter and system.merges values also differ because their reads occur at separate
instants. The evidence supports investigating internal-log merge/buffer overhead;
it does not attribute all 611 MiB of allocation growth to it. The earlier text_log
removal control did not reduce broader memory growth and should not be conflated
with query_log maintenance.

Final active-part snapshot: analytics 1,088,272 rows / ~18.75 MiB compressed;
query_log 149,456 rows / ~18.79 MiB; text_log 2,211,948 rows / ~73.15 MiB;
processors_profile_log 756,418 rows / ~18.67 MiB; trace_log 507,170 rows /
~15.87 MiB. Disk sizes are not live RAM or merge working-set estimates. This
write-heavy singleton fixture produces many internal logged statements.

## Interpretation and next experiment

The rejection reproduced, and the repaired collector retained the evidence through
it. Do not raise HTTP/DB gates or describe the small aggregation as the primary
memory consumer. There are substantial live allocations, allocator overhead and
large measured internal-log maintenance bursts within the same small cgroup.

Next controlled comparison: reduce internal query-log volume for routine fixture
inserts while retaining 100% logging of the tagged analytical/diagnostic requests,
with the same 15-minute workload and memory budget. Record effective settings and
verify all analytical IDs still have query-log records. Treat this as a diagnostic
control, not a production logging policy. If allocation growth persists, collect
allocation-stack/heap evidence to separate long-lived buffers from allocator and
other background consumers. The current trace does not establish a leak or a
single proven culprit. No production setting, provider, deployment or spending
change is authorized by these local findings.

Alloy load forwarding rises 2116874→2622347; aggregate remote retries rise
4835028→5032071, failures unchanged. Cloud query/render verification remains false.
Source lag and accepted/stored reconciliation pass locally, not a production
capacity or durability guarantee. Shared-host scheduling remains a confounder for
refusals; app interval event-loop maximum reaches 2380 ms. Memory attribution and
scheduling diagnosis remain separate concerns.
