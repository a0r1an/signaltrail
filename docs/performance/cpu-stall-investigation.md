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

## Concurrent-analytics control

Ran `load capacity-4gb-db8-q24-noqueries`: same limits, seed data, fixed session
pool, singleton 100 EPS for 300 seconds and interval instrumentation. Suppressed
only the repeated analytical SQL during traffic. Metadata lookup/diagnostics,
ClickHouse writes and final reconciliation remain. Docker sample cadence shifts
slightly because the sequential query time is absent; background ClickHouse
merges and other host workloads remain, so this is not an idle-storage control.

Report: `test-results/load/2026-11-09T20-52-16.741Z-capacity-4gb-db8-q24-noqueries/result.json`.
The control fails with 14 metadata-gate HTTP 503s: 29987 accepted/unique stored,
no HTTP-gate refusals/retries/rejections/generator drops, final source lag zero.
HTTP p99 106.83 ms. Cleanup and lock release pass, no detected OOM/restart.

| Measurement | With analytical SQL | Without analytical SQL |
| --- | --- | --- |
| Metadata gate refusals | 1 | 14 |
| HTTP p99, ms | 105.79 | 106.83 |
| App CPU-pressure `some` fraction across observed span | 12.73% | 13.07% |
| Largest ingestion GC duration, ms | 39.74 | 41.81 |
| Total observed ingestion GC time, ms | 4071 | 4181 |
| App I/O-pressure `some` increase across observed span, ms | 7.81 | 3.45 |

Pressure fraction uses cumulative kernel `some total` deltas over elapsed time
between the first and last resource observations; collection is asynchronous,
so this is approximate. Histories contain 306 and 308 records, including startup
and final reporting, not identical traffic-only measurement windows. A one-pair
comparison does not establish statistical significance or a causal degradation.

The control's refusal burst is `20:53:55.189–20:53:55.288 UTC`. The enclosing
interval ending `20:53:56.098` has app CPU-pressure delta 242.98 ms, assigned CPU
busy about 82.1% / 82.8%, loop-delay maximum 139.72 ms and observed GC total
69.90 ms (largest 22.90 ms). PostgreSQL is idle by its later wait observation.
The initial refusal includes three executing / 21 acquiring (16 in pool wait);
`acquiring` includes setup/settling as well as waiting, so eight configured
connections must not be interpreted as eight queries always executing. Later
refusals show eight executing / 16 waiting. No database lock/storage wait was
captured in the 308 observations, which cannot exclude transient server waits.

This control does not support concurrent analytical SQL as a sufficient explanation.
The best measured lead remains runtime scheduling/CPU pressure with GC activity,
without a unique source identified. Next isolate generator placement from target
CPUs while keeping target CPU count, limits and workload fixed, and repeat under
controlled host conditions. Do not stop or reconfigure unrelated development
services to manufacture isolation. A separate generator/clean host may ultimately
be needed; no purchase or deployment is authorized. If pressure remains, obtain a
bounded ingestion CPU/GC profile and distinguish allocation/validation work from
other target processes. Historical 6.9-second stall is still not reproduced.

The control workload test was first observed failing before implementation; all
45 harness unit tests pass. Both named profiles remain reproducible. No production
defaults, credentials, collector configuration or external resources changed.

## Generator CPU isolation and ClickHouse headroom

User authorized the isolation experiment and a Lightsail price comparison. Added
`load capacity-4gb-db8-q24-generator`: target services remain on logical CPUs 0,1,
with the same four-GiB budget, HTTP 128 / eight connections / 24 queries, one million
rows, singleton 100 EPS for 300 seconds and full concurrent analytical SQL. Only the
generator is pinned to 2,3 through a dedicated Compose override. Docker needs at
least four logical CPUs; the test checks target constraints and generator affinity.
The generator affinity was verified in all 59 resource observations. This avoids
generator use of target logical CPUs, not all physical-host contention.

Report: `test-results/load/2026-11-09T21-16-03.915Z-capacity-4gb-db8-q24-generator/result.json`.
The run passes: 30001 accepted/unique stored, zero HTTP/metadata/publisher refusals,
retries, rejections or generator drops, final source lag zero. HTTP p95 8.92 ms /
p99 39.07 ms; analytical query maximum 332.11 ms. No detected OOM/restart; owned
teardown and load-lock release pass. Peak outstanding metadata work is still 23 of
24, leaving little instantaneous gate headroom. Ingestion loop-delay maximum
125.17 ms, largest observed GC 34.66 ms; app CPU-pressure fraction approximately
10.96% across the retained observation span (prior diagnostic full-query run 12.73%).
This single pass is encouraging, not repeatable qualification or proof the generator
caused prior failures. Additional Docker memory reads/affinity inspection also add
sampling overhead and slightly alter the cadence of sequential analytical queries.
Repeat with matched instrumentation before attributing causality.

### ClickHouse pressure is now measured separately

Capacity samples additionally retain ClickHouse `memory.events`, `memory.pressure`,
`memory.current`, `memory.max` and `memory.stat`, with collection start/end timestamps.
Reads are sequential, not atomic; raw fixed file order is recorded by the runner.
This covers ClickHouse's cgroup, unlike the earlier app-only memory observations.

- Peak sampled cgroup current: 1278.57 MiB against a 1280-MiB hard limit.
- `memory.events:max` reaches 14233; first observed nonzero at 21:17:38.777 UTC.
- No OOM or OOM-kill events; memory-pressure `some/full` totals reach 1.631/1.304
  seconds. Direct reclaim scan/steal counters grow substantially.
- Last observed current 1246.10 MiB, with anonymous, file-cache and kernel/slab
  charges all present. Peak summed Docker-displayed target memory 1671.56 MiB
  excludes some cache and guest overhead; it is not whole-host usage.

The kernel defines `max` as allocations about to exceed the cgroup limit, with
reclaim attempted before OOM; these are not 14233 process failures or lost events.
See [kernel cgroup-v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html).
The per-service cap is actively causing reclaim despite no OOM. This supports
reviewing ClickHouse's allocation within the four-GiB budget, not automatically
buying more total RAM. It does not prove memory pressure caused any earlier 503.
No memory cap was changed in this experiment.

All 46 harness unit tests pass; the new profile's workload test was observed failing
before implementation. No development/production defaults changed. Next repeat
matched generator controls, and plan a separately verified memory redistribution
within four GiB before stronger host-sizing claims. Current Lightsail price
research is recorded in [Lightsail options](lightsail-options.md).

## Follow-up memory redistribution

See [four-GiB memory redistribution](4gb-memory-rebalance.md): the isolated-generator
original allocation repeat fails with 13 metadata refusals, while two fresh revised
allocation trials pass. The changes preserve the four-GiB total and 640-MiB reserve,
with ClickHouse/app/PostgreSQL caps 1536/384/128 MiB. This improves local evidence
without proving a unique root cause or production capacity; ClickHouse still
performs reclaim and host/long-duration limitations remain.

## Capacity telemetry now registered with Alloy

The historical scrape-coverage gap above has been addressed for future runs. See
[capacity monitoring](../setup/capacity-monitoring.md): capacity targets now export
ingestion/DB/host/worker/broker metrics with explicit profile/run labels, and the
existing Alloy file discovery collects them. Local endpoints, actual load-forwarding
counter growth and dashboard metric-reference checks pass. Cloud query/render
verification still requires the user's Grafana URL/access; historical missing
metrics have not been backfilled or reclassified as captured.
