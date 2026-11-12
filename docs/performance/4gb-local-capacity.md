# Local four-GiB capacity search

```sh
./scripts/signaltrail-ops.mjs load capacity-4gb
./scripts/signaltrail-ops.mjs load capacity-4gb-boundary
./scripts/signaltrail-ops.mjs load capacity-4gb-confirm
```

This is an isolated local offered-load frontier search, not an AWS instance
benchmark. It preserves development services and uses the shared load lock and
owned teardown from the [memory screen](4gb-local-feasibility.md).

## Follow-up interval telemetry

See [CPU stall investigation](cpu-stall-investigation.md) for the unchanged
128/8/24 diagnostic run, correlated pressure/GC observations and the discovered
Grafana scrape-coverage gap. It supports a scheduling-contention lead, without
claiming a unique cause or reconstructing telemetry that was never captured.

## 24-query gate experiment — November 9

User authorized increasing the total metadata gate from 16 to 24 at eight
connections. Added `load capacity-4gb-db8-q24`, leaving the HTTP cap at 128 and
all baseline profiles/application defaults unchanged. Two fresh five-minute
100-EPS trials use the same memory/CPU allocation, seed rows and concurrent SQL.
The live adapter is asserted to have eight connections / 24 outstanding slots.
All 42 harness units pass; the workload test first failed before implementation.

| Trial | Metadata gate refusals | Other metadata failures | HTTP gate refusals | Total HTTP 503s | Generator drops | HTTP p95 / p99, ms | Accepted / unique stored | Result |
| ----- | ---------------------- | ----------------------- | ------------------ | --------------- | --------------- | ------------------ | ------------------------ | ------ |
| 1     | 158                    | 0                       | 117                | 275             | 152             | 19.10 / 1032.42    | 29574 / 29574            | Fail   |
| 2     | 637                    | 24                      | 82                 | 743             | 604             | 377.68 / 1738.00   | 28602 / 28635            | Fail   |

Reports:

- `test-results/load/2026-11-09T20-17-25.957Z-capacity-4gb-db8-q24/result.json`
- `test-results/load/2026-11-09T20-23-28.552Z-capacity-4gb-db8-q24/result.json`

Both fill the 24-query gate; retained refusal events show eight executing /
16 waiting. Both also fill the 128-request HTTP gate. First run has zero event
retries; second has 34 retry outcomes and 34 late publication completions.
Second-run stored count exceeds explicit acceptance by 33; ambiguous outcomes
prevent exact reconciliation and do not establish accepted-event loss. Both
finish with source lag zero. Neither report passes.

Acquisition maxima: 1503.58 / 6386.78 ms. Query round-trip maxima: 1278.65 /
6241.03 ms. Ingestion event-loop histogram maxima: 1224.74 / 6903.82 ms; this is
client-process scheduling delay, not proof that PostgreSQL spent that long
executing SQL. Diagnostic analytical query maxima 3437.75 / 3754.31 ms also
exceed the two-second criterion. These cumulative extrema do not prove exact
simultaneity. No detected OOM/restart; both owned stacks cleaned up and released
the lock. No production settings changed.

Compared with prior eight-connection / 16-query trials (64 and three metadata
refusals), these outcomes do not support adopting 24 as a fix. They also do not
prove the gate increase caused worse results: shared-host conditions and broad
scheduling stalls remain confounders. Stop blind limit increases. Next inspect
intervals around refusal timestamps, host/container scheduling and generator
pressure; establish a stable comparable environment before further tuning or
VPS capacity claims. Keep the 24-query profile as experimental evidence only.

## Alternating five-minute pool trials — November 9

User authorized four fresh trials at 100 EPS for 300 seconds, in order 4 → 8 → 4 → 8
connections. HTTP admission stayed 128; total outstanding-query gate stayed 16.
Named runner operations: `load capacity-4gb-db4-long` / `capacity-4gb-db8-long`.
Same two shared logical CPUs, four-GiB allocation, one million seeded rows,
singleton requests, fixed session pool and concurrent analytical SQL throughout.

| Trial | Connections | Accepted / unique stored | Metadata HTTP 503s | HTTP p95 / p99, ms | Generator drops | Result |
| ----- | ----------- | ------------------------ | ------------------ | ------------------ | --------------- | ------ |
| 1     | 4           | 30001 / 30001            | 0                  | 9.06 / 26.52       | 0               | Pass   |
| 2     | 8           | 29870 / 29870            | 64                 | 15.38 / 513.39     | 67              | Fail   |
| 3     | 4           | 29991 / 29991            | 10                 | 9.83 / 52.50       | 0               | Fail   |
| 4     | 8           | 29997 / 29997            | 3                  | 9.75 / 47.07       | 0               | Fail   |

Reports in execution order:

- `test-results/load/2026-11-09T19-49-36.584Z-capacity-4gb-db4-long/result.json`
- `test-results/load/2026-11-09T19-55-32.326Z-capacity-4gb-db8-long/result.json`
- `test-results/load/2026-11-09T20-01-37.904Z-capacity-4gb-db4-long/result.json`
- `test-results/load/2026-11-09T20-07-43.225Z-capacity-4gb-db8-long/result.json`

All four have zero HTTP-admission refusals, event retries or rejections, matching
accepted/stored counts and zero final committed source lag. No detected OOM or
restart. Every owned stack cleaned up and released the lock. Failure results stay
failed; successful drain does not negate refusals or generator drops.

Refusal events directly show 16 outstanding queries: four executing / 12 waiting
in trial 3, eight executing / eight waiting in trials 2 and 4. Execution round-trip
maxima by trial: 88.02 / 671.86 / 132.43 / 144.80 ms; acquisition maxima:
64.93 / 89.72 / 117.70 / 93.72 ms. Ingestion event-loop histogram maxima:
109.45 / 641.20 / 203.55 / 127.86 ms (20-ms histogram resolution).
Trial 2 additionally had a 4041.55-ms analytical query, failing its two-second
criterion. Sampled average service CPU for the first three trials was about
1.08–1.12 cores, and displayed memory peaks about 1658–1705 MiB, excluding guest
OS overhead/cache and generator resources. Averages cannot explain short stalls.

These runs establish neither pool size as consistently zero-refusal at 100 EPS.
Eight connections did not reliably eliminate the measured gate refusals. High
execution/event-loop maxima suggest scheduling/shared-resource contention is worth
investigating, but cumulative maxima do not prove simultaneity or identify a
root cause. Two sequential repeats each are not a randomized production study.
No production defaults changed. Next correlate interval-level timing and resource
observations around refusal timestamps, then choose one further experiment (for
example a larger outstanding-query gate at fixed pool size) rather than assuming
more connections fixes it.

Harness correction: the first attempt at
`test-results/load/2026-11-09T19-43-07.050Z-capacity-4gb-db4-long/result.json`
failed with an empty/truncated summary at the inherited 300-second Docker command
deadline, which left no allowance for a 300-second traffic run and shutdown.
It cleaned up and remains unusable failed evidence, outside the four trials.
Command deadlines now allow the longest capacity stage plus 120 seconds, with a
300-second minimum; long profiles get 420 seconds. Regression tests first failed
for the missing profiles/timeout helper, then all 41 harness tests passed. This
changes harness execution allowance, not application query/publication deadlines.

## Eight-connection comparison — November 9

User authorized eight connections / 16 outstanding queries (up to eight executing
and eight waiting when all connections are busy). Added `load capacity-4gb-db8`;
existing profiles retain four connections. Normal application defaults and
production configuration remain unchanged. Reports assert eight connections and
16-query capacity from the live adapter; HTTP remains 128. Only pool size changed
relative to the preceding instrumented trial, with the same 100 EPS / 120 seconds,
fresh stack, two shared logical CPUs, memory caps, seed data and direct SQL load.

Report: `test-results/load/2026-11-09T19-36-42.403Z-capacity-4gb-db8/result.json`.

| Measurement                            | Four connections (19:30 run) | Eight connections (19:36 run) |
| -------------------------------------- | ---------------------------- | ----------------------------- |
| Accepted / unique stored               | 12001 / 12001                | 12001 / 12001                 |
| HTTP/metadata refusals                 | 0 / 0                        | 0 / 0                         |
| HTTP p95 / p99, ms                     | 8.96 / 47.20                 | 7.87 / 32.00                  |
| Connection acquisition mean / max, ms  | 0.0415 / 95.20               | 0.0369 / 51.79                |
| Query round-trip mean / max, ms        | 0.624 / 53.25                | 0.554 / 55.74                 |
| Peak outstanding / executing queries   | 6 / 4                        | 8 / 8                         |
| Average sampled service CPU, cores     | 0.973                        | 0.891                         |
| Peak summed Docker service memory, MiB | 1228.41                      | 1244.54                       |
| Ingestion event-loop histogram max, ms | 54.20                        | 71.96                         |

No retries, rejections, generator drops, detected OOM or restart in the eight-pool
run; final broker lag zero. Cleanup passed and the lock was released. All 39
harness units pass, including a workload test first observed failing before the
new profile was implemented. Resource samples exclude the load generator and
whole-guest overhead, use 25 snapshots per run, and can miss peaks. Timing totals
include startup key verification. Acquisition includes setup and waiting; query
round trips include network/scheduling. Occupancy peaks are lifetime counters.

Eight connections is a viable experimental setting in this trial, not proven
superior or production-qualified. Both instrumented trials passed; shared-host
variation and limited duration still apply. Next compare repeated longer four/eight
trials at identical load, then use a matched higher-load profile to investigate
the previously failing 150 EPS workload without changing the 16-query gate.

## Fresh paired HTTP trials — 2026-11-09

Added repeatable `load capacity-4gb-http32` and `load capacity-4gb-http128`
operations. Each runs only 100 EPS for 120 seconds on a fresh isolated stack.
Reports now record all three application limits; container inspection verifies
that the HTTP cap matches the selected profile. Both retain four connections,
16 outstanding metadata queries, identical CPU/memory limits and workload.

| HTTP cap | Accepted / unique stored | HTTP 503s         | HTTP p95 / p99, ms | Result |
| -------- | ------------------------ | ----------------- | ------------------ | ------ |
| 32       | 12001 / 12001            | 0                 | 10.81 / 47.42      | Pass   |
| 128      | 12000 / 12000            | 1 (metadata gate) | 9.22 / 38.75       | Fail   |

Reports, in execution order:

- `test-results/load/2026-11-09T18-59-51.499Z-capacity-4gb-http32/result.json`
- `test-results/load/2026-11-09T19-02-56.585Z-capacity-4gb-http128/result.json`

Neither trial had HTTP-admission refusals, event retries/rejections, generator
drops, detected OOM or restart. Both reconciled accepted/unique stored counts and
finished at zero source lag. The cap-128 observer recorded exactly one metadata
failure/attempt at capacity and one HTTP 503; the generator's `malformed` counter
counts that request-level error response, not proven corrupt JSON. Both owned
stacks cleaned up and released the lock. All 38 harness unit tests pass; the new
workload test was first observed failing for the unimplemented profiles.

This reverses the prior pass/fail ordering: cap 32 now passes and cap 128 has a
single refusal. One sequential pair on shared local CPUs does not prove either
cap is better, but it rejects claiming a reproducible benefit from raising the
HTTP cap on the available evidence. Neither cap makes 100 EPS reliably
zero-refusal across all recorded trials. The 16-query metadata guard remains a
measured refusal source. Next investigate timestamped pool occupancy/query wait
and CPU contention around refusals before selecting one metadata constraint for
a controlled experiment; production limits remain unchanged.

## HTTP admission comparison — 2026-11-09

Changed only the fixture HTTP processing cap from 32 to 128 (the normal ingestion
application default). Metadata remains four connections / 16 outstanding queries;
CPU affinity, memory caps, seed data, publisher budgets and boundary workload are
unchanged. The fixture now uses 128 for subsequent memory/capacity runs; November 6
results below used 32. Application defaults and development services were unchanged.

Report: `test-results/load/2026-11-09T18-50-43.045Z-capacity-4gb-boundary/result.json`.

- 100 EPS for 120 seconds passed: 12001 accepted/unique stored, no HTTP failures,
  event retries, admission/metadata refusals or generator drops; final source lag
  zero. HTTP p95 8.13 ms / p99 27.69 ms. Largest diagnostic query 288.72 ms.
- 150 EPS for 60 seconds failed: 206 HTTP 503s, all instrumented at the unchanged
  metadata gate, zero HTTP-admission refusals, 10 event retry outcomes, and 823
  generator drops. HTTP p95 289.55 ms / p99 3548.87 ms. Later stages were skipped.
- Failed stage reported 7962 accepted versus 7971 unique stored and zero final
  source lag. Publisher counters show 10 cancelled/late completions. Ambiguous
  outcomes prevent exact reconciliation; extra stored rows do not establish
  accepted-event loss. This remains a failed report.
- No detected OOM or restart in lifecycle inspection. Owned infrastructure cleanup
  passed and the load lock was released. All 37 harness units pass.

The old two-minute 100-EPS run at cap 32 failed with 51 HTTP 503s; the new cap-128
run passed once. Runs were on different days with shared host resources: this is
not a repeated paired experiment proving causation or a production recommendation.
At 150 EPS the metadata gate and long-tail latency remain material constraints.
Next: fresh same-session cap-32/cap-128 repetitions at 100 EPS to establish whether
improvement is reproducible, before changing the database pool or query gate.

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
- November 6 ingestion admitted 32 concurrent requests; the November 9 fixture
  uses 128 as described above. Publisher budgets remain 1000 events
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

## Enhanced bottleneck observations — November 9

Capacity samples/final pipeline status now include lifetime HTTP occupancy peaks,
bounded timestamped HTTP refusals, and metadata diagnostics described in
`packages/project-access/README.md`. Each database gate refusal captures queue
occupancy immediately, so a five-second poll no longer has to coincide with it.
The fixture also records cumulative ingestion-process event-loop delay mean/p99/max
in milliseconds (20-ms histogram resolution). This measures ingestion scheduling,
not the separate processor process or PostgreSQL scheduler. No limits changed.

Interpret together rather than treating one metric as proof:

| Observation                                                 | What to investigate                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| Connection acquisition time rises while execution stays low | Pool queueing, connection setup, arrival bursts                |
| Execution time rises                                        | Database work, network or scheduling delays                    |
| Event-loop delay rises                                      | Ingestion scheduling/CPU contention or blocking work           |
| Metadata refusal event                                      | Outstanding/executing/acquiring/waiting counts at that instant |
| HTTP occupancy/publisher reservations rise                  | Body/auth/publication work and downstream pressure             |

Timings are cumulative count/total/max summaries, not percentiles; interval means
can be calculated from deltas. Peaks survive polling gaps but have no full time
trace. Recent refusal lists retain only the last 32 events, while counters retain
the full count. Docker sampling remains approximately every five seconds and can
miss resource spikes. Query timing is client-observed, not server-side execution.
No query text, parameters or credentials are logged. More instrumentation adds
some overhead; earlier runs do not contain these fields and cannot be reconstructed.

Verification: access lint/79 unit tests/types/build pass. Real PostgreSQL adapter
probe passes at `test-results/load/2026-11-09T19-30-21.554Z-project-access/result.json`,
including deliberate queue wait, slow execution, cancellation and refusal capture.
The timing test was first observed failing before timing fields were implemented;
an intermediate test needed an explicit 150-ms contention interval because fixture
SQL inspection could outlast the initial sleep. Failed artifacts remain failed.

Instrumented unchanged 128/4/16 run:
`test-results/load/2026-11-09T19-30-50.879Z-capacity-4gb-http128/result.json`.
100 EPS for 120 seconds passes: 12001 accepted/unique stored, zero failures, retries,
refusals or generator drops, final lag zero. HTTP p95 8.96 ms / p99 47.20 ms.
Retained peaks: 13 HTTP requests, six outstanding metadata queries, four executing,
three acquiring (separate maxima, not necessarily simultaneous). Acquisition
mean 0.0415 ms / max 95.20 ms; execution mean 0.624 ms / max 53.25 ms, including
the startup verification query. Event-loop histogram p99 24.04 ms / max 54.20 ms;
its 20-ms resolution contributes to the baseline and is not pure excess delay.
No refusal was reproduced, so this run validates observations rather than
explaining the earlier transient. Both successful probes cleaned up and released
the lock. Next reproduce a refusal with these diagnostics before tuning limits.
