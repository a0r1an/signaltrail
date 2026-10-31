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
| Install pinned Chromium              | `./scripts/signaltrail-ops.mjs browser install`                       |
| Real-broker integration suite        | `./scripts/signaltrail-ops.mjs broker test`                           |
| Development broker status            | `./scripts/signaltrail-ops.mjs broker status`                         |
| Development broker public metrics    | `./scripts/signaltrail-ops.mjs broker metrics`                        |
| Load-harness unit checks             | `./scripts/signaltrail-ops.mjs load check`                            |
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
acknowledged Kafka offsets. Its Kafka adapter is currently part of the harness;
a supervised production worker, retention, and query API remain separate work.
The fixture preserves unusual client timestamps as strings. This is a small
correctness probe, not a storage-throughput benchmark.

The harness advertises temporary scrape targets in
`test-results/load-targets.json`; Alloy collects them while they exist and they
are withdrawn afterward. During normal dashboard use choose
`signaltrail-ingestion` and `signaltrail-redpanda`; load targets are separate.

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
