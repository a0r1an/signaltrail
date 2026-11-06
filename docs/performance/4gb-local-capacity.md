# Local four-GiB capacity search

```sh
./scripts/signaltrail-ops.mjs load capacity-4gb
./scripts/signaltrail-ops.mjs load capacity-4gb-boundary
./scripts/signaltrail-ops.mjs load capacity-4gb-confirm
```

This is an isolated local offered-load frontier search, not an AWS instance
benchmark. It preserves development services and uses the shared load lock and
owned teardown from the [memory screen](4gb-local-feasibility.md).

## Measured ramp and repeat — 2026-11-06

Initial ramp:
`test-results/load/2026-11-06T23-21-46.541Z-capacity-4gb/result.json`.

| EPS offered | Seconds | Accepted / unique stored | HTTP p95, ms | Result                                      |
| ----------- | ------: | -----------------------: | -----------: | ------------------------------------------- |
| 10          |      60 |                601 / 601 |        38.54 | Pass                                        |
| 25          |      60 |              1500 / 1500 |        10.75 | Pass                                        |
| 50          |      60 |              3000 / 3000 |         8.94 | Pass                                        |
| 100         |      60 |              6001 / 6001 |        17.80 | Pass                                        |
| 200         |      60 |            11746 / 11746 |        73.66 | Fail: 253 HTTP 503s and two generator drops |

At 200 EPS, the fixture recorded 226 request-admission refusals. The remaining
27 HTTP 503s were not attributed by the original observer; do not claim they were
proven metadata refusals. The generator calls missing per-event outcomes
`responses_malformed`, which includes valid request-level HTTP 503 error bodies;
this is not evidence of corrupted JSON or invalid submitted events.

All stages ended with committed source lag zero and matching accepted/stored
counts. No publisher failures, publication-budget refusals, detected OOM
termination or restart occurred. The overall ramp is deliberately **failed**
because its 200-EPS target was not sustained. Its maximum passing rate is not a
production ceiling.

Sampled target CPU averaged approximately 0.96 cores at 100 EPS and 1.78 at 200
EPS. The maximum simultaneous Docker-displayed target memory at 200 EPS was
1494.92 MiB; ClickHouse individually reached 1093.63 MiB against a 1280-MiB cap.
These are approximate sampled displays, not synchronized whole-host CPU or memory
measurements. The source lag maximum sampled at 200 EPS was 38 records.

A fresh-stack, two-minute repeat at 100 EPS:
`test-results/load/2026-11-06T23-30-08.723Z-capacity-4gb-boundary/result.json`.
It accepted and stored 11950 events, but returned 51 HTTP 503s: 16 request-admission
refusals and **35 instrumented metadata queries attempted at the 16-query gate**.
The metadata adapter uses four connections by default. Refusals first appeared
around 80 seconds into the sampled run, rather than being confined to startup.
HTTP p95 was 18.67 ms and p99 91.54 ms; no generator drops, publisher failures,
OOM termination, restart or final backlog occurred. The planned 150/175/200-EPS
refinement stages were correctly skipped after this first failure.

Consequently, **100 EPS is not a repeatably demonstrated zero-refusal capacity**.
The evidence identifies admission/metadata guards under CPU contention, not a
four-GiB hardware RAM ceiling. Increasing RAM alone is not established as a fix.
The three-minute 50-EPS confirmation is a separate profile, not a retry that
overwrites either failed report:
`test-results/load/2026-11-06T23-34-41.658Z-capacity-4gb-confirm/result.json`.
It **passed**: 9001 accepted and uniquely stored events, no HTTP failures,
request/metadata refusals, retries, rejections, malformed outcomes or generator
drops, and zero final source lag. HTTP p95 was 9.56 ms, p99 34.95 ms; the largest
diagnostic SQL duration was 436.43 ms. All target services remained running
without detected OOM or restart, and cleanup passed.

In 37 samples, the largest simultaneous Docker-displayed target memory was
1073.15 MiB; ClickHouse individually reached 677.9 MiB. Approximate sampled target
CPU averaged 0.612 cores, and sampled source lag reached four records. These
numbers exclude guest OS/collector overhead and some cache.

**Working conclusion:** 50 EPS is the strongest repeated local zero-refusal
baseline here, not a certified operating ceiling. The 100-EPS short pass did not
survive the longer repeat; 200 EPS also failed. Initial 1–5-EPS planning traffic
is below the tested range, but cloud hardware, credits, retained volume, backups
and endurance still need qualification. Do not describe this as finding an exact
four-GiB instance limit or recommend more RAM solely from these results.

All 37 harness unit tests pass. Both higher-load reports remain failed evidence;
the confirmation's passing result does not replace them. Next investigate
admission/pool settings and transient contention using these diagnostics, then
repeat on the selected host with longer runs and background maintenance.

## Configuration

- Same 3456-MiB service caps and 640-MiB host allowance as the four-GiB screen.
- All five target services use CPU affinity `0,1`, verified through Docker
  inspection. They share those two logical CPUs; the CPUs are not exclusive and
  do not reproduce Lightsail processors, baseline entitlement or burst credits.
- One million synthetic historical rows and 10000 historical visitor IDs. New
  traffic uses a fixed pool of 1000 sessions and one event per HTTP request.
- Each event includes 512 repeated padding bytes. This compresses well and does
  not qualify arbitrary payload sizes, replay or incompressible byte throughput.
- Sequential 60-second stages at 10, 25, 50, 100, 200, 400, 800 and 1600 EPS,
  stopping at the first stage that does not meet the provisional criteria.
- The boundary profile starts with 100 EPS for 120 seconds, followed by 150/175/
  200 EPS for 60 seconds each if every preceding stage passes. The confirmation
  profile runs only 50 EPS for 180 seconds. All use the same resource limits.
- Ingestion admits 32 concurrent requests. Publisher budgets remain 1000 events
  and 8 MiB. These application limits can bind before RAM is exhausted.
- Concurrent direct `FINAL` count/unique-visitor queries group by event name.
  These are not the authenticated dashboard's complete query workload.

## Provisional criteria and evidence

A stage must have accepted events, no HTTP failures, malformed outcomes,
rejections, retries or generator drops, HTTP p95 at most 500 ms and p99 at most
2000 ms. Every accepted event must match a unique stored row and committed source
offsets must drain to zero within 60 seconds after traffic stops. Diagnostic SQL
must finish within two seconds. Missing measurements cannot establish a pass.
All target containers must remain running without restart or detected OOM, with
the configured memory, swap and CPU-affinity settings actually enforced.

The fixture-only observer samples committed source lag, publisher reservations,
admission refusals and response status counts. Later repeat profiles also expose
metadata adapter occupancy, failed queries and attempts at its configured gate.
This endpoint contains only
synthetic fixture state and is exposed on loopback port 34105; it is not a product
API. Docker stats, query timings, raw k6 JSON and lifecycle diagnostics are retained
when available. Docker-displayed memory excludes some cache and can miss peaks.

Results go to `test-results/load/<timestamp>-<profile>/`. `progress.json` is an
incomplete checkpoint. `result.json` is written after cleanup and is authoritative.
If the search finds an unsustained target, the command deliberately exits nonzero
and `passed` stays false: finding a ceiling does not make that workload pass.
Inspect `highestPassingEventsPerSecond`, `firstUnsustainedEventsPerSecond`, the
individual stages, errors and teardown evidence. If all planned stages pass,
`ceilingNotReached` is true and no upper capacity limit has been established.

Failed-stage accepted/stored count differences after ambiguous responses do not
by themselves prove accepted-event loss. The earlier successful stages require
zero ambiguity and exact count/offset reconciliation. Event-level receipt proof
for ambiguous outcomes is outside this load generator.

## Interpretation

Each passing stage establishes only that short offered-load measurement and drain
behavior. Longer runs must establish that lag remains bounded during traffic,
not just that it drains afterward. A first failure can arise from request admission,
generator capacity, CPU, query latency, broker work, memory or storage: inspect the
evidence before attributing it to a machine resource.

No whole-guest memory restriction, realistic retained data distribution, parallel
dashboard users, backups, monitoring collector, failure/restart drill or production
disk is included. A local frontier is not a safe production operating ceiling.
Repeat the relevant boundary and run endurance/maintenance tests on the actual
candidate host before setting scaling thresholds or a supported user count.
