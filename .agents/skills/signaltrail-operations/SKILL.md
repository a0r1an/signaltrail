---
name: signaltrail-operations
description: Run SignalTrail package checks, Chromium and Redpanda tests, isolated k6 load scenarios, and Grafana Alloy monitoring operations using the repository's standard command runner. Use for operational verification in SignalTrail, not production deployment or arbitrary Docker administration.
---

# SignalTrail operations

Use this skill in the SignalTrail repository after resolving the requested scope
under `AGENTS.md`. Read `docs/PROJECT_STATUS.md` for current milestones; recorded
checks are historical evidence, not proof of the current checkout.

## Standard runner

Use `./scripts/signaltrail-ops.mjs` from the repository root. It selects an already
installed Node 24 runtime, uses argument arrays rather than shell interpolation,
rejects unknown operations and extra arguments, and stops on the first failure.
It does not install Node or change global configuration.

Preview an operation without side effects:

```sh
./scripts/signaltrail-ops.mjs --dry-run load baseline
```

| Need                                 | Command                                                               |
| ------------------------------------ | --------------------------------------------------------------------- |
| Contracts lint, units, types, build  | `./scripts/signaltrail-ops.mjs check contracts`                       |
| Ingestion lint, units, types, build  | `./scripts/signaltrail-ops.mjs check ingestion`                       |
| Processor lint, units, types, build  | `./scripts/signaltrail-ops.mjs check processor`                       |
| SDK lint, units, types, build        | `./scripts/signaltrail-ops.mjs check sdk`                             |
| Chromium integration suite           | `./scripts/signaltrail-ops.mjs browser test`                          |
| Measure native IndexedDB queue cost  | `./scripts/signaltrail-ops.mjs browser benchmark`                     |
| Measure minified SDK transfer sizes  | `./scripts/signaltrail-ops.mjs browser size`                          |
| Install pinned Chromium              | `./scripts/signaltrail-ops.mjs browser install`                       |
| Real-broker integration suite        | `./scripts/signaltrail-ops.mjs broker test`                           |
| Development broker status            | `./scripts/signaltrail-ops.mjs broker status`                         |
| Development broker public metrics    | `./scripts/signaltrail-ops.mjs broker metrics`                        |
| Load-harness unit checks             | `./scripts/signaltrail-ops.mjs load check`                            |
| Native Chromium-to-storage recovery  | `./scripts/signaltrail-ops.mjs load browser-pipeline`                 |
| Isolated event-to-ClickHouse probe   | `./scripts/signaltrail-ops.mjs load pipeline`                         |
| Isolated broker outage and SDK retry | `./scripts/signaltrail-ops.mjs load recovery`                         |
| Baseline / burst and recovery        | `./scripts/signaltrail-ops.mjs load baseline` / `load burst`          |
| Count / byte budget saturation       | `./scripts/signaltrail-ops.mjs load saturation` / `load bytes`        |
| Validate Compose files               | `./scripts/signaltrail-ops.mjs compose validate`                      |
| Validate monitoring configuration    | `./scripts/signaltrail-ops.mjs monitoring validate`                   |
| Start / stop monitoring              | `./scripts/signaltrail-ops.mjs monitoring up` / `monitoring down`     |
| Monitoring status / recent logs      | `./scripts/signaltrail-ops.mjs monitoring status` / `monitoring logs` |
| Filtered collector delivery counters | `./scripts/signaltrail-ops.mjs monitoring delivery`                   |
| Install committed dependencies       | `./scripts/signaltrail-ops.mjs install`                               |

The check operations build required workspace dependencies first. Do not run
operations that clean/rebuild the same `dist/` directories concurrently. For one
TDD behavior, use the package's focused test command rather than the full check.
Avoid root Turbo commands solely for convenience: this checkout's Turbo version
has previously appended guidance to `AGENTS.md` as an unsolicited side effect.

## Permissions and command consistency

Use the runner instead of recreating shell strings with absolute Node paths,
pipes, environment assignments, or ad hoc Docker commands. Keep approved command
prefixes stable. A skill supplies instructions; it does not grant sandbox access.
Reuse existing approvals and current user authorization. Keep edits and unrelated
commands separate from approved runner invocations: a compound command may not
match the saved rule. When Docker or listeners require escalation, invoke the
same runner command with the execution tool's escalation option; a saved prefix
does not make a sandboxed invocation gain Docker access automatically. If execution is denied
by the sandbox, retry the same operation through the tool's escalation mechanism.
When requesting a reusable prefix, scope it to the operation, for example:

- `['./scripts/signaltrail-ops.mjs', 'load']` for the allowlisted load scenarios and harness checks.
- `['./scripts/signaltrail-ops.mjs', 'browser', 'test']` for browser checks.
- `['./scripts/signaltrail-ops.mjs', 'monitoring', 'delivery']` for filtered metrics.

Do not request a blanket `node`, shell, or Docker prefix. Dependency additions,
new operations, production actions, and secret changes are outside these aliases;
handle them in their actual task scope rather than adding arbitrary passthrough.

## Load-test interpretation

`tests/load/run.mjs` owns the isolated `signaltrail-load` Compose project, broker
port 29092, broker metrics port 29644, and ingestion metrics port 9465.
`load pipeline` also starts isolated ClickHouse on port 38123. Run one
load scenario at a time. The harness acquires `test-results/load.lock` before
changing infrastructure; a second run must fail rather than tear down another
run's broker. A lock left after a killed process or failed Docker teardown is
intentional. Check its PID/creation time and the isolated Compose project before
removing it; do not blindly delete locks or reuse uncertain broker state.
Teardown enables all test profiles and verifies no project containers remain
before releasing the lock. A successful Docker exit alone is insufficient.
Its cleanup removes only its temporary project volumes;
never substitute the normal application's Compose project or volume names.

Results go to ignored `test-results/load/<run>/`. Inspect `result.json`, k6 stage
summaries, and samples. HTTP 200 is insufficient: inspect per-event accepted,
retry, and rejected outcomes, and k6 dropped iterations. Keep failed runs as
failed evidence. Final success is written only after cleanup; an `incomplete`
result with `passed: false` is not a successful run. Short local k6 scenarios
verify overload handling, not production VPS capacity or endurance.

`load recovery` pauses only the isolated broker twice: first to exercise HTTP
publication deadlines and late acknowledgement, then long enough to exhaust
Kafka publication retries. It verifies SDK retention, stable event IDs, capacity
refusals, recovery, and actual broker records. It deliberately permits duplicate
records; downstream dedupe is still required. This scenario uses the SDK's Node
memory fallback. Chromium tests separately cover native IndexedDB persistence,
offline retry, multi-tab leases, beacons, and expiry; neither suite proves host
or disk disaster recovery.

`load pipeline` validates HTTP ingestion while ClickHouse is paused, processing
through the exported worker library, confirmed ClickHouse writes, unique `FINAL`
reads across repeated event IDs and separate projects, DLQ publication, and
acknowledged Kafka offsets. It also runs the worker entrypoint as an owned child,
pauses storage until a write fails, verifies an uncommitted source offset, kills
that child, and restarts with the same consumer group. Recovery must produce one
logical row and acknowledge the source offset before graceful shutdown. A second
crash window uses an owned ephemeral loopback HTTP gate: ClickHouse confirms the
insert, the gate withholds that response, and the child is killed before its
source commit. The replacement must insert again while `FINAL` still returns
one logical row. The gate is test-only and is closed during cleanup. The
replacement may wait for the old group session to expire. The probe also owns
worker metrics port 9466 and checks retry/completion metrics through real HTTP.
The worker endpoint is optional and loopback-only; it is not automatically
added to the live Alloy configuration. Production process
supervision, retention, and the query API remain separate work.
The fixture preserves unusual client timestamps as strings. This is a small
correctness probe, not a storage-throughput benchmark.

`load browser-pipeline` includes all pipeline checks and a native Chromium SDK
probe. It builds the browser bundle, owns a fixture on loopback port 4179, queues
one event offline in IndexedDB, closes the page, reopens while the isolated
broker is paused, verifies the retry response retains the original ID, and then
checks recovery into ClickHouse with one logical row. Chromium must already be
installed (`browser install` locally; CI also installs its system dependencies).
Failure traces are retained in the load artifact directory. This covers page
closure in one browser context, not browser-process restart, browser eviction,
or host loss. Do not run it alongside another owner of fixture port 4179.

The harness advertises temporary scrape targets in
`test-results/load-targets.json`; Alloy collects them while they exist and they
are withdrawn afterward. During normal dashboard use choose
`signaltrail-ingestion` and `signaltrail-redpanda`; load targets are separate.

## Sustained pipeline measurements

Use `load sustained-smoke` for a five-second harness check, `load sustained` for
60 seconds at 10 requests/second, and `load sustained-stress` for 60 seconds at
50 requests/second. Each request contains 20 events. These fixed profiles ignore
`DURATION`, run on isolated Redpanda/ClickHouse, and use the runnable worker on
metrics port 9466. No normal development services are restarted.

The scenario samples exact source offsets, worker Prometheus metrics, and Compose
container CPU/memory stats. It requires zero generator drops, malformed responses,
rejections, or retry outcomes, then drains for up to 60 seconds and reconciles
accepted counts with unique `FINAL` rows and committed source offsets. Failure to
keep up is a failed measurement at that offered load, not automatic evidence of
lost events. Inspect k6 summaries, `sustained.json`, `worker-samples.json`,
`worker.prom`, `container-samples.json`, and the authoritative `result.json`.
Only the final result establishes successful cleanup.

Sampling is sequential and skips ticks while a previous sample is pending.
Container stats cover the whole isolated project (including k6 while running):
this Compose version accepts at most one explicit stats service argument.
Generator, worker, broker, and storage share the development machine. This is
neither a production sizing estimate nor a browser/SDK retry simulation. Do not
tune limits from one short run or confuse chunk-attempt latency with storage-only
acknowledgement latency.

## Monitoring and secrets

Monitoring configuration lives under `infra/monitoring/`. It reads ignored
`.env.monitoring` and mounts `.secrets/grafana-metrics-token`; never print the
file, put its contents in command arguments, or commit it. No cloud credentials
belong in the browser SDK. Do not show expanded Compose configuration containing
secrets; use `config --quiet` for validation.

A successful syntax validation or running container does not prove live delivery.
Check forwarded sample counters and successful remote-write counters, alongside
failed/retried sends. Confirm Cloud visibility with the user or an already
authorized read interface; the metrics-write token does not authorize dashboard
administration. Dashboard JSON is prepared locally for import.

For broker selectors use a metric verified on the running broker. This version
does not expose `redpanda_uptime_seconds_total`. The verified selector is:

```text
label_values(up{job=~"signaltrail-redpanda(-load)?"}, job)
```

In Grafana's label filter UI select `job`, not the `$job` dashboard variable.
Idle histograms can yield no percentile values even while scraping is healthy.
Redpanda `dev-container` mode also enables fsync bypass independently of topic
write caching; check the effective broker command before claiming disk durability.
Do not restart the user's development broker as part of load-test cleanup.

## Browser SDK size measurement

`browser size` builds contracts and the SDK, then uses the pinned tsup toolchain's
esbuild to bundle all public exports and the delivery-only entry. It records
minified bytes, gzip level 9, Brotli quality 11, hashes, tool versions, and the
largest source contributors in ignored `test-results/sdk-size/<run>/report.json`.
It does not enforce a size budget or claim browser startup performance. Do not
run it alongside checks that rebuild the same package output directories.

## Native IndexedDB queue benchmark

`browser benchmark` builds the public SDK browser bundle and launches owned
headless Chromium against an ephemeral loopback fixture. It performs three
sequential fill trials each at 100, 500, and 1,000 events with a 128-character
property value. Every trial verifies native IndexedDB and exact FIFO reads.
Artifacts in ignored `test-results/queue-benchmark/<run>/report.json` record
per-enqueue percentiles, total fill/read times, browser/runtime versions, and
machine details. Success is recorded only after owned resources close.

These are local queue measurements without upload, concurrent tabs, CPU
throttling, or replay recording. No performance threshold or production capacity
is implied, and defaults are not changed. Do not overlap package builds.
