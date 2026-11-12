# Capacity-test telemetry and Grafana

## What is wired

Capacity profiles now advertise temporary Prometheus targets through the same
`test-results/load-targets.json` file used by Alloy's existing load discovery.
No collector restart or global scrape-interval change is required. Existing
scraping remains at five seconds; interval diagnostics remain nominally one second.
Counters and timing histograms preserve observations between scrapes.

Every capacity target has `environment="test"`, `profile` and `run_id` labels.
These describe bounded test executions, not projects, sessions or event IDs. Each
new run creates a new set of series; consider retention/active-series usage when
running many tests. No customer payloads, keys, SQL text or credentials are exported.

| Job                              | Target from Alloy                              | Data                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signaltrail-capacity`           | `host.docker.internal:34105/metrics`           | HTTP/publication metrics; Node CPU/GC; DB occupancy, refusals and acquisition/execution histograms; interval scheduling and pressure                              |
| `signaltrail-capacity-host`      | `host.docker.internal:34107/metrics`           | Run/configuration, Docker service/generator CPU and displayed memory, hard caps, ClickHouse cgroup pressure/events, source lag and completed-stage reconciliation |
| `signaltrail-capacity-processor` | `host.docker.internal:34105/processor-metrics` | Proxy to fixture worker's loopback metrics; storage attempts, retries, duration, Node CPU/GC                                                                      |
| `signaltrail-capacity-redpanda`  | `host.docker.internal:34105/broker-metrics`    | Proxy to isolated broker's public metrics                                                                                                                         |

The host exporter binds to loopback. Container listener ports are published on
host loopback by the isolated Compose fixture; proxy URLs are fixed. Fixture
endpoints are read-only and do not access development credentials or services.
The worker metrics port remains fixture-specific. Application request/publisher
limits and production defaults are unchanged.

## Dashboard

Import [capacity-dashboard.json](../../infra/monitoring/capacity-dashboard.json)
into Grafana, selecting the Prometheus datasource that Alloy writes to. The
28-panel dashboard has profile, run and CPU filters. Select the test time window;
start/end timestamps, run activity and a completion annotation help align panels.
Completion annotation time is scrape-derived and may be absent if collection fails.
Run start includes fixture setup, not just traffic. No annotation API writes occur.

The views include:

- Configured HTTP/connection/query limits and offered/completed event rates.
- HTTP vs metadata gate refusals; HTTP and DB timing histograms; queue/peak occupancy.
- Per-core CPU accounting, container/generator CPU, CPU pressure and app throttling.
- Ingestion/processor CPU and GC; event-loop delay and interval-max histogram.
- Displayed memory versus caps, ClickHouse charged memory/breakdown/reclaim/OOM events.
- PostgreSQL observed waits, broker lag and processor throughput/storage durations.
- Completed-stage accepted/stored/drop counts, scrape availability and telemetry age.

The existing ingestion dashboard stays separate and can continue to show
development ingestion/broker targets. Do not substitute those graphs for a capacity
run. Historical capacity runs before this wiring have local artifacts only; cloud
metrics cannot be backfilled from data that was never collected.

## Verification command

```sh
./scripts/signaltrail-ops.mjs load capacity-4gb-telemetry
```

This is a 30-second 100-EPS monitoring check using the revised four-GiB allocation
and isolated generator. It is not endurance/capacity qualification. Required
images/Node runtime/dependencies follow the normal load-runner setup.

The runner checks local ingestion/host/processor/broker Prometheus endpoints and
saves initial/final `.prom` files. The smoke profile verifies every dashboard metric
reference against the final real exporter output. `result.json` records:

- `localEndpoints`: local endpoint/format checks succeeded.
- `dashboardMetricContract`: all dashboard metric names exist in real output.
- `alloyLoadForwardingObserved`: Alloy's load-forwarding counter increased while
  this locked run exclusively advertised its capacity targets, if Alloy is available.
- `cloudQueryVerified`: false until an authenticated cloud query is independently
  verified. Remote-write aggregate counters do not prove per-run cloud query results.

`collector-delivery.json` preserves only selected counters and timestamps, not URL,
account or credential labels. An unavailable collector is explicitly reported;
local correctness does not depend on having a configured cloud account.

Final run markers are held for six seconds to allow a five-second scrape; collector
failures/scheduling can still miss them. Targets are then atomically withdrawn and
the host exporter/owned test stack removed. Failure to save metrics or withdraw
scrape targets fails cleanup while remaining teardown steps are still attempted.
Never remove another run's lock or edit discovery files during an active run.

## Measurement semantics

- Acquisition time includes pool wait/setup; execution time is client round trip,
  including scheduling/failures, not server-only SQL execution.
- `waiting` is a subset of `acquiring`; total outstanding includes execution and
  acquisition. Lifetime peak occupancy survives polling gaps.
- GC histograms record actual runtime observations. The interval loop histogram
  instead records each one-second interval's maximum; its quantiles are not a
  request-latency distribution. In-process observations cannot execute during stalls.
- Linux CPU-time ratios describe VM logical CPUs. Pressure is different from quota
  throttling. App cgroup covers ingestion and processor together; per-process metrics
  separate their own CPU/GC. Other VM/host activity can still interfere.
- Docker displayed memory excludes some cache; ClickHouse cgroup current includes
  charged cache/kernel memory. Kernel and slab components overlap. A memory `max`
  event is a boundary/reclaim event, not an OOM kill or lost event.
- Docker resource samples and broker lag are periodic, not atomic. Collection times,
  observation age and availability expose gaps. Short PostgreSQL waits may be missed.
- Publisher/processor completions count attempts, not necessarily unique events.
  Accepted/stored/drop gauges describe the latest completed stage, not live totals.
- Raw broker metrics can create multiple series per fixture topic/partition. All
  fixture topics and label dimensions are bounded; no event/session IDs are labels.

## Verified evidence — November 9

The second smoke report passes at
`test-results/load/2026-11-09T23-41-10.327Z-capacity-4gb-telemetry/result.json`:
3001 accepted/unique stored; all four endpoints and dashboard metric contract pass.
Alloy load-forwarded samples increased from 768765 to 793045 during the observed
window. Aggregate remote-written samples increased, with unchanged failure/retry
counters. These are local collector observations, not a Grafana Cloud query result.
Targets were withdrawn to `[]`, exporter/test resources removed and lock released.
An earlier smoke run also passed at `2026-11-09T23-36-25.883Z-capacity-4gb-telemetry`.

Access-package lint/81 tests/types/build, all 54 harness unit tests and Alloy
configuration validation pass. New behavior tests were observed failing before
implementation, including asynchronous observer failure containment. The dashboard
JSON and metric contract are verified; cloud import/render/PromQL execution have
not been verified. The user supplied the instance URL on November 9:
`https://dashingjackal3083.grafana.net`, with the existing `signaltrail-ingestion`
dashboard. Chrome tab discovery finds that page, but DOM, screenshot, accessibility
and fresh-tab control fail with `Cannot read properties of undefined (reading
'timeoutMs')`. Explicit execution timeout and documented recovery alternatives do
not resolve it. Chrome is the only available browser session; Grafana plugin search
returns no available integration. Authentication/permissions were not inferred from
the tab title. No cloud dashboard changes have occurred.

Remaining dependency: restore working browser page control, then import the JSON,
select the account datasource and verify actual PromQL/rendering for the saved test
window. The URL is resolved; it must not be requested again. Do not send tokens in
chat, extract browser credentials, or assume the telemetry write token grants reads.

## Endurance interval retention

`load capacity-4gb-db8-q24-endurance` holds the revised allocation at 100 EPS
for 1800 seconds, retaining full analytical SQL and generator CPU separation.
The runner polls cursor-based diagnostics and appends contiguous records to
`stall-intervals.jsonl`; it fails collection on overwritten/gapped history.
`stall-history.json` records the final exported sequence. This covers traffic
and drain through export; the later scrape-hold shutdown window is excluded.
`stall-diagnostics.json` still contains only the final 600 intervals. Use the
NDJSON file for whole-run analysis. `capacity-progress.json` is a minute checkpoint;
its broker-acknowledged count is not the final HTTP accepted/stored reconciliation.

## Observation failure recovery

Resource sampling, interval export and analytical requests now run in separate
serial loops. Each loop waits two seconds after its own attempt; requests within
a loop never overlap. A slow/failed analytical request cannot stop interval
export. Errors append immediately to `observation-errors.jsonl` with kind and
timestamp and print to stderr. Attempts continue, but any observed error still
fails the run; artifact-write failures also surface. The separate loops change
analytical cadence relative to historical combined-loop runs, so throughput
comparisons must account for that instrumentation/workload change.

`load capacity-4gb-telemetry-failure` is a 30-second real-database fault probe:
only its first analytical request gets `max_memory_usage=1`. Its expected process
exit is 1 and capacity report is failed. Verify the report has only the injected
analytical error, later successful attempts, exact accepted/stored counts, resource
samples after the error, contiguous complete interval export and successful resource
cleanup. This is failure-path evidence, never a passing capacity trial.

`load capacity-4gb-query-memory` runs the same revised budget for 120 seconds,
collecting server/query memory settings, system memory/part snapshots and
three rounds of five query controls before and after traffic into
`query-memory-before.json` / `query-memory-after.json`. It records real
query IDs and matching query-log memory/duration/read/spill evidence. Controls
are baseline, one thread, a 16-MiB external-aggregation threshold, count-only and
a no-FINAL diagnostic control. The latter changes semantics and is not a product
optimization. No measured settings are adopted into application defaults.

`load capacity-4gb-query-memory-no-text-log` repeats that diagnostic with only
internal ClickHouse text_log removed via an isolated XML mount. It is a control,
not an operational default. Both phases retain query logging and validate one
QueryFinish/memory measurement per query ID. Results and limits are in
[query-memory evidence](../performance/4gb-query-memory.md).

## Continuous server/allocator trace

`load capacity-4gb-memory-trace-smoke` runs 30 seconds; `load capacity-4gb-memory-trace`
runs 900 seconds at the unchanged revised four-GiB budget and 100 EPS. Independent
15-second, one-thread/64-MiB-bounded SQL snapshots append server/allocator/cache,
merge and part evidence to `clickhouse-memory.jsonl`. Each category has a timestamp;
partial failures remain explicit. This observer adds SQL and has non-atomic reads.
Tagged attempts append immediately to `analytical-attempts.jsonl`; cleanup flushes
and exports matching terminal records to `analytical-query-log.jsonl`, even after
stage failure. Neither loop changes limits or masks failure. See
[memory-trace evidence](../performance/4gb-memory-trace.md) for verified outcomes,
metric semantics, shared-host limits and the next controlled comparison.

## Sparse heap attribution and idle recovery

`load capacity-4gb-memory-trace-heap-smoke` checks 30-second traffic/10-second idle;
`load capacity-4gb-memory-trace-heap` runs 900-second traffic/180-second idle. Isolated
XML enables global lg_sample 22 sampling without exhaustive trace-log sample writes.
Five phase profiles use the 26.8 SQL collapsed-stack interface; raw rows and weighted
stack differences are saved. Sampling is statistical and affects timing/placement.

`load part-memory` performs read-only all-state part/retention inspection of the
currently advertised isolated capacity fixture (requires its live load lock).
Future continuous traces include inactive as well as active parts. Previous
active-only artifacts remain unchanged. Evidence and semantics:
[heap attribution](../performance/4gb-heap-profile.md).
