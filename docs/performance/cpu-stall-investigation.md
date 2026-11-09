# Local stall investigation — November 9

## Outcome

An unchanged HTTP-128 / eight-connection / 24-outstanding-query five-minute run
at 100 EPS reproduced one metadata-gate HTTP 503. It accepted and uniquely stored
30000 events, had no retries/rejections/generator drops, and finished with source
lag zero. It remains a failed zero-refusal measurement. HTTP p95 14.06 ms / p99
105.79 ms; maximum diagnostic SQL 724.33 ms. No detected OOM/restart. Cleanup and
load-lock release passed.

Report: `test-results/load/2026-11-09T20-42-57.585Z-capacity-4gb-db8-q24/result.json`.
Detailed telemetry: `stall-diagnostics.json` in that directory, 306 interval records.

## Correlated refusal interval

The gate refusal is timestamped `20:45:39.298 UTC`: 24 outstanding, eight executing
and 16 waiting. The interval ending `20:45:39.759 UTC` spans approximately 1002 ms.
Resources are read just after its timestamp, and collection takes 3.09 ms. These
are near-aligned observations rather than atomic measurements.

| Observation | Value |
| --- | --- |
| Ingestion event-loop delay maximum in interval | 195.04 ms |
| Ingestion process CPU time | 399.98 ms user + 20.76 ms system |
| Event-loop utilization | 0.679 (wall time, not CPU utilization) |
| Ingestion GC activity in interval | 25 events, 109.58 ms total, 39.74 ms largest |
| App cgroup CPU pressure `some` delta | 457.77 ms |
| App cgroup CPU pressure `full` delta | 235.24 ms |
| Assigned logical CPU 0 / CPU 1 busy from Linux CPU-time deltas | 91.9% / 90.9% |
| App cgroup I/O pressure `some` delta | 0 ms |
| Docker VM I/O pressure `some` delta | 6.51 ms |
| App cgroup CPU quota / throttled time | unlimited quota / zero throughout run |
| App cgroup memory high/max/OOM events | zero throughout run |

The cgroup covers ingestion and processor together; process CPU/GC/ELU cover only
ingestion. CPU pressure measures runnable work waiting for CPU, distinct from
quota throttling. Linux counters are cumulative and the table uses consecutive
resource snapshots. CPU busy uses `/proc/stat` deltas, excludes idle/iowait, and is
not the whole Mac's CPU usage. The fixture still shares two CPUs rather than
owning dedicated ones. GC durations are observed event durations, not additive
proof of all pause causes.

In adjacent intervals, cgroup CPU-pressure `some` was about 190 ms before and
148 ms after; event-loop maxima were 56.92 and 23.99 ms. PostgreSQL was available
for all 306 diagnostic queries. Snapshots predominantly showed idle `ClientRead`
backends; no lock/storage wait was captured. In the refusal interval all eight
were idle by the observation, consistent with delayed client consumption, but
short server waits between snapshots remain possible. Database temp bytes and
deadlocks stayed zero; block hits dominated block reads.

The overlapping Docker observation spans `20:45:37.664–20:45:40.454 UTC`, taking
2790.60 ms. Displayed CPU was ClickHouse 118.13%, app 52.05%, PostgreSQL 10.31%,
Redpanda 7.65%, generator 33.89%. These sequential Docker values are supporting
context, not synchronized CPU accounting or proof of what blocked ingestion.

## Interpretation and next control

The strongest measured lead is transient CPU/scheduling contention on the shared
fixture CPUs, with ingestion GC contributing in the same interval. This is stronger
evidence than attributing the refusal solely to the database pool or queue size.
No app quota throttling or app memory-limit events occurred. No app I/O pressure
rose during the interval; this does not exclude ClickHouse disk effects, other
cgroups, Docker Desktop or macOS host effects. One run did not reproduce the
previous 6.9-second stall, so its exact historical cause remains unresolved.

Do not raise safeguards again from this evidence. The next controlled comparison
should keep limits/data/rate/instrumentation unchanged and suppress only concurrent
analytical SQL, measuring whether CPU pressure and refusal frequency decline.
Repeat before attributing causality; removing queries changes workload and cannot
qualify capacity for the original workload. Subsequent attribution can examine
ClickHouse maintenance and ingestion GC with a bounded profile if needed.

## Telemetry coverage and access

Existing Alloy scrapes development ingestion/Redpanda plus targets advertised in
`test-results/load-targets.json`. The original `tests/load/run.mjs` registers its
load targets; `memory-run.mjs` / `memory-app.mjs` do not advertise a Prometheus
endpoint. Consequently the historical capacity tests are not established as
Grafana load telemetry. Development-service graphs cannot be substituted.

`monitoring delivery` on November 9 confirmed lifetime forwarded/delivered sample
counters, along with historical failure/retry counters. A single cumulative read
cannot establish ingestion success or scrape continuity at the stall timestamp.
No Grafana connector is available; Chrome discovery found no open Grafana tab or
recent Grafana history. A dashboard/instance URL has been requested asynchronously;
no cloud query or Grafana panel result is claimed. The local metrics token is
configured for remote writes; read permission was not assumed or changed.

## Implementation and validation

Fixture-only interval telemetry now captures ingestion CPU/ELU/GC, interval loop
delay, app cgroup CPU/memory/I/O counters, Docker VM CPU/pressure counters, and
PostgreSQL backend-wait groups/database counters through one separate diagnostic
connection (outside the eight-key-lookup pool). It logs no SQL text, keys or values.
Observations are nominally one second, non-overlapping, bounded to the latest 600;
collection times and scheduling overruns reveal delays rather than inventing
missing intervals. An in-process sampler cannot run while ingestion is stalled,
so kernel cumulative counters retain evidence across the gap but momentary DB
waits may be missed. Unavailable files/queries are explicit, not reported as zero.

The final history is saved before teardown; export failure is a cleanup failure
while remaining cleanup still runs. Existing five-second Docker sampling now records
start/end/collection duration. Instrumentation adds overhead, including the extra
SQL connection and sampling; cross-version results are not perfectly controlled.

All 44 load-harness unit tests pass, including intended-failure checks for resource
collection and a non-overlap/failure-handling observer test. The real unchanged
load run verified file availability, SQL query compatibility, interval output,
refusal capture and cleanup. The workload failure remains failed evidence.
