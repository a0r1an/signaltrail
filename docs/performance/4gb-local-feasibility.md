# Local memory feasibility probes

## Result — two GiB, 2026-11-06

The same workload passed under the smaller profile:
`test-results/load/2026-11-06T19-51-47.894Z-memory-2gb/result.json`.

| Session pool | Events/second | Accepted / unique stored | HTTP p95, ms |
| ------------ | ------------: | -----------------------: | -----------: |
| 10           |             1 |                  61 / 61 |        64.69 |
| 25           |           2.5 |                150 / 150 |        40.13 |
| 50           |             5 |                301 / 301 |        18.40 |

Each stage ran for 60 seconds, with no retries, rejections, malformed outcomes,
generator drops, detected OOM termination or restart. All accepted events were
uniquely stored; teardown and lock release passed. Across 38 samples, the largest
simultaneous sum of Docker-displayed service memory was 730.12 MiB. Individual
maxima: ClickHouse 446.4 MiB (512-MiB cap), combined Node services 133.3 MiB,
Redpanda 113.2 MiB, PostgreSQL 24.3 MiB and Valkey 14.27 MiB.

Two GiB therefore passes this first screen, with the same limitations below.
ClickHouse has relatively little room within its assigned cap, and Docker's
display excludes some cache; these numbers do not establish available guest RAM.
Prefer longer retention-scale, background-maintenance and backup tests before
choosing this as a production size. This one trial does not establish relative
performance between memory profiles.

The later [two-CPU capacity search](4gb-local-capacity.md) uses one million rows
and longer/higher traffic. ClickHouse there exceeds this two-GiB fixture's
512-MiB ClickHouse cap. Do not extend the small-data two-GiB pass to that workload;
this also does not prove that every possible two-GiB service allocation would fail.

## Result — four GiB, 2026-11-06

The first complete run passed all three stages and teardown:
`test-results/load/2026-11-06T19-42-33.537Z-memory-4gb/result.json`.

| Session pool | Events/second | Accepted / unique stored | HTTP p95, ms |
| ------------ | ------------: | -----------------------: | -----------: |
| 10           |             1 |                  61 / 61 |        46.05 |
| 25           |           2.5 |                150 / 150 |        29.13 |
| 50           |             5 |                300 / 300 |        22.93 |

Each stage ran for 60 seconds. There were no retry/rejected/malformed responses,
generator drops, detected OOM terminations or restarts. Actual memory/swap limits
were verified before and after traffic and during sampling. All owned test
containers/volumes were removed and the shared load lock released.

Across 39 samples, the largest simultaneous sum of Docker-displayed service memory
was 778.94 MiB. Individual observed maxima: ClickHouse 430.8 MiB, combined Node
services 114.5 MiB, Redpanda 204.8 MiB, PostgreSQL 26.35 MiB and Valkey 13.5 MiB.
These are sampled working-set displays, not total guest memory or startup peaks.
The largest measured diagnostic SQL duration was 368.34 ms. Lower later-stage
latency does not establish that more traffic improves performance: warm-up and
background work vary between stages.

Two earlier attempts remain failed artifacts: the initial fixture inherited a
development Valkey port mapping, and the next attempt included k6 terminal
progress after the JSON summary. Both fixture defects were corrected; neither
attempt is counted as successful capacity evidence. The final probe uses quiet
JSON output and no host port for Valkey.

Conclusion: a four-GiB candidate deserves a real-host trial. This is not evidence
that its CPU, disk, long-term retention or backup workload will meet requirements.

## Repeating the probe

Run from the repository root:

```sh
./scripts/signaltrail-ops.mjs load memory-4gb
# Same workload with the smaller, separately tuned memory profile:
./scripts/signaltrail-ops.mjs load memory-2gb
```

The runner builds the application dependencies and creates only the isolated
`signaltrail-memory` Compose project. It shares the load-test lock with the other
probes. Existing test containers cause refusal; normal development containers and
volumes are never reset. Only the owned test project's volumes are removed during
cleanup. Reports are written under `test-results/load/<timestamp>-memory-4gb/`;
`result.json` is authoritative and can pass only after successful cleanup.
Two-GiB reports use the `-memory-2gb` suffix. Both profiles use the same isolated
project, ports and lock; never run them concurrently.

## Two-GiB allocation

| Service                          | Hard limit, MiB |
| -------------------------------- | --------------: |
| Redpanda                         |             640 |
| ClickHouse                       |             512 |
| PostgreSQL                       |             128 |
| Valkey                           |              64 |
| Ingestion and processor combined |             320 |
| Reserved for host/operations     |             384 |
| Total                            |           2,048 |

The two-GiB override reduces Redpanda's internal memory setting from 1 GiB to
512 MiB, PostgreSQL shared buffers from 64 to 32 MB and Valkey's cache limit
from 128 to 32 MB. Fsync remains enabled, swap remains disabled, and the Node heap
settings, seed rows, traffic stages and analytical queries are unchanged. This is
an experimental low-memory fixture, not a vendor-supported production sizing
claim. The host reserve is smaller and still not a measured operating-system or
monitoring allowance. Lifecycle diagnostics are retained when available, including
startup failures before traffic can begin.

## Four-GiB allocation

| Service                          | Hard limit, MiB |
| -------------------------------- | --------------: |
| Redpanda                         |           1,280 |
| ClickHouse                       |           1,280 |
| PostgreSQL                       |             256 |
| Valkey                           |             128 |
| Ingestion and processor combined |             512 |
| Reserved for host/operations     |             640 |
| Total                            |           4,096 |

Memory and total memory-plus-swap limits are equal, preventing container swap.
The probe inspects actual Docker limits rather than assuming Compose enforces
them. Missing services, restarts, stopped containers and OOM termination fail the
probe. Both Node processes have a 128-MiB V8 old-space limit, which is separate
from total resident memory. PostgreSQL uses 64-MB shared buffers and 30 connections.
The November 6 fixture admitted at most 32 concurrent requests. The November 9
comparison changes the fixture cap to 128; see the capacity report. Redpanda fsync bypass is disabled.
These are fixture settings, not changes to the development or production stack.

## Workload and checks

- Real PostgreSQL key-hash lookup on every request, using a synthetic isolated
  key table. This does not qualify full production schema/role provisioning.
- 100,000 historical ClickHouse rows with received times spread over 30 days.
- Sequential 60-second profiles for 10, 25 and 50 session IDs, assuming six events
  per active user per minute: 1, 2.5 and 5 events/second. Sessions are a fixed pool,
  not actual browsers. Each HTTP request contains one event with 512 padding bytes.
- Concurrent direct analytical SQL: event totals and exact visitor counts with
  `FINAL`, grouped by event name. Query durations and container CPU/memory samples
  are retained separately. k6 is outside the constrained service budget.
- No rejected/retry/malformed outcomes or generator drops; every accepted event
  must appear as one unique ClickHouse row within the 60-second drain deadline.
  Per-stage HTTP timings are retained, not converted into an unsupported SLA.

## Interpretation

This is a first memory-feasibility screen, not a four-GiB guest VM or a Lightsail
qualification. Separate service caps prevent borrowing unused memory across
services. The host reserve is an allowance, not a measured OS/collector footprint.
CPU and disk are shared with the development machine and are not restricted to
Lightsail's two burstable vCPUs. Docker's displayed memory usage excludes some
cache; it is not whole-host RAM usage. Startup peaks between samples can be missed.

Valkey is idle; no Clerk/Next.js dashboard process is hosted here (the deployment
plan keeps it on Vercel). Backups, monitoring collector, full retention-sized
datasets, replay recording, broker/storage outages and long-duration growth are
not covered. Passing justifies a candidate-host trial; it does not establish
production capacity, recovery objectives or an upper limit on active users.
