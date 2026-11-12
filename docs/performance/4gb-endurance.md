# Four-GiB endurance — November 9

## Configuration and outcome

User-authorized `load capacity-4gb-db8-q24-endurance` ran 1800 seconds at an
offered 100 singleton EPS, one million historical rows, revised allocation
(ClickHouse 1536 / app 384 / PostgreSQL 128 / Redpanda 1280 / Valkey 128 MiB,
640 MiB host allowance), HTTP 128 / pool 8 / outstanding gate 24. Targets share
CPUs 0,1; generator uses 2,3. No application defaults changed.

**Failed.** Report:
`test-results/load/2026-11-10T00-06-19.248Z-capacity-4gb-db8-q24-endurance/result.json`.

| Measurement                                  | Result             |
| -------------------------------------------- | ------------------ |
| HTTP accepted events                         | 168505             |
| Unique stored fixture events                 | 169217             |
| Broker completed publications                | 169221             |
| HTTP requests / generator drops              | 173919 / 6081      |
| HTTP failure rate                            | 3.11%              |
| HTTP p95 / p99                               | 42.24 / 5191.51 ms |
| Metadata / HTTP admission refusals           | 824 / 2038         |
| Metadata failed queries                      | 849                |
| Event retry outcomes / rejected              | 5 / 0              |
| Invalid/incomplete response outcomes         | 5409               |
| Publication cancellations / late completions | 537 / 537          |
| Final broker source lag                      | 0                  |
| Detected container OOM kills / restarts      | 0 / 0              |

Counts are different populations, not additive. `responses_malformed` also covers
HTTP errors/timeouts without complete event outcomes; it does not mean 5409 corrupt
JSON responses. Successful HTTP checks (168510) include five retry outcomes.
The generator did not sustain all offered iterations. Storage equality was not
achieved within the 60-second drain check (61.05 seconds measured). Source offsets
drained, but stored events exceeded acknowledged acceptances amid ambiguous/late
responses. This does not prove accepted-event loss or complete per-event delivery.
No ID-set reconciliation was performed. Lifecycle captured before teardown has
all five services running with zero OOM/restarts; owned stack/volumes were then
removed, scrape discovery withdrawn to [], and the load lock released.

## Concrete failure and evidence limits

At approximately 11 minutes, ClickHouse rejected the concurrent analytical
aggregation with HTTP 500 / code 241 `MEMORY_LIMIT_EXCEEDED`. OvercommitTracker
selected the query to stop: reported total limit about 1.33 GiB, current RSS
1.26 GiB, attempted total 1.33 GiB. This is an internal ClickHouse memory rejection,
not a container OOM kill. The internal limit is distinct from its 1536-MiB cgroup.

The runner's existing sampling loop stopped on that query error. Consequently,
continuous analytical SQL and Docker/ClickHouse samples cover only roughly the
first 11 minutes; this is **not** a valid clean 30-minute full-query qualification.
Traffic itself ran the complete 1800.08 seconds. The report retains the sampling
error and failed capacity result. Successful diagnostic-query maximum 1042.11 ms
excludes the failed analytical query and is not a successful whole-run SQL bound.

Automatic NDJSON collection stopped at sequence 679; final export correctly failed
on the overwritten ring instead of claiming complete history. Read-only recovery
captured subsequent batches without gaps and combined sequences 1–1760 in
`recovered-history.jsonl`, through 00:37:18 UTC (traffic ended around 00:36:34 UTC).
This covers traffic and part of drain, not the final cleanup/export tail. Recovery
artifacts were not substituted into the original runner result. Automatic export
failure remains recorded as a diagnostics cleanup failure, despite resource cleanup
succeeding. Endpoint timeouts during the late stall are also retained in recovery
process output.

## What the intervals show

The first metadata refusals occurred at 00:29:41 UTC (about 23.1 minutes after
traffic began): eight queries executing, 16 waiting, gate full at 24. The following
interval had 212.73 ms maximum event-loop delay, 91.89 ms aggregate GC and a
24.91 ms longest GC observation. These are correlations, not proof of GC causality.
Later intervals showed much larger scheduling stalls, up to 20.82 seconds between
observer ticks. Final cumulative event-loop maximum was 18.91 seconds; recovered
interval GC maximum reached 3.51 seconds. PostgreSQL acquisition/execution maxima
reached 9.84 / 12.64 seconds. These timing measurements include scheduling effects.

Per-core busy time from VM CPU tick deltas (idle and iowait excluded): first ten
minutes CPU0/1 about 65.6/67.1%, middle interval about 69.6/69.2%, late interval
76.6/75.1%. Application CPU-pressure duration rose from about 13% of early elapsed
time to 34% in the late interval group. VM load reached approximately 47. This
supports substantial scheduling contention, but average CPU busy time is not proof
of continuous CPU saturation. Shared-host activity remains a confounder. Application
CPU quota throttling and memory-limit events remained zero in recovered intervals.
The app can wait for CPU without hitting a cgroup CPU quota or its RAM cap.

ClickHouse's last sample before the query failure recorded 38676 max-limit events,
8.85 seconds memory-pressure `some` and 7.00 seconds `full`; cgroup current was
1495.38 MiB of 1536. Docker-displayed peaks in this **partial sampling window**:
ClickHouse 1530.88 MiB, app 174.6 MiB, PostgreSQL 40.34 MiB, Redpanda 288.3 MiB,
Valkey 12.4 MiB. These are not whole-run or whole-guest RAM peaks. No later memory
headroom claim can be made from them. Internal query rejection and reclaim are
concrete memory constraints even without an OOM kill.

Alloy load-forwarded counters increased 820769→1837231. Aggregate remote-written
samples increased, failures were unchanged, and retried samples increased
4145828→4581870; do not claim retry-free remote delivery. Grafana cloud querying
and dashboard rendering remain unverified because browser page control is blocked.

## Verification and next action

Profile/timeout/cursor/history tests were observed failing before implementation;
all 58 harness tests pass. A fresh 30-second integration run passed with 3001
accepted/unique stored and contiguous 40-record export before this endurance run.
Those checks verify harness paths, not endurance capacity.

The five-minute revised-allocation passes did not establish stable 100-EPS capacity.
Do not raise DB/HTTP limits or adopt production defaults from this run. Next:
separate interval collection from analytical-query failures, retain/report errors
immediately while continuing telemetry and query attempts, and verify that failure
path with a bounded integration test. Then investigate the rejected aggregation's
memory behavior (including FINAL/exact distinct, concurrency and memory spill
settings) under the same budget before another controlled endurance comparison.
Actual-host CPU-credit/disk/OS qualification remains necessary; no spending,
provider purchase, deployment or remote push is authorized.
