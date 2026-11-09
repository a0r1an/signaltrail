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

| Job | Target from Alloy | Data |
| --- | --- | --- |
| `signaltrail-capacity` | `host.docker.internal:34105/metrics` | HTTP/publication metrics; Node CPU/GC; DB occupancy, refusals and acquisition/execution histograms; interval scheduling and pressure |
| `signaltrail-capacity-host` | `host.docker.internal:34107/metrics` | Run/configuration, Docker service/generator CPU and displayed memory, hard caps, ClickHouse cgroup pressure/events, source lag and completed-stage reconciliation |
| `signaltrail-capacity-processor` | `host.docker.internal:34105/processor-metrics` | Proxy to fixture worker's loopback metrics; storage attempts, retries, duration, Node CPU/GC |
| `signaltrail-capacity-redpanda` | `host.docker.internal:34105/broker-metrics` | Proxy to isolated broker's public metrics |

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
not been verified. No signed-in Grafana tab or instance URL is currently available;
provide the instance/dashboard URL to complete that read/import verification using
existing access. Do not send tokens in chat or assume the write token grants reads.
