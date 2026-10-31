# Local analytics pipeline measurements — 2026-10-31

## Scope

These runs exercise k6 → HTTP ingestion → Redpanda → the runnable event processor
→ ClickHouse. They use small synthetic JSON events, 20 events/request, and the
isolated `signaltrail-load` Compose project. They do not execute the browser SDK,
simulate SDK retries, or establish production VPS capacity or disaster recovery.

Machine: Apple M3 Pro, 12 logical CPUs, approximately 19.3 GB physical memory;
Node 24.21.0, macOS arm64, Docker Desktop. Docker reports approximately 7.65 GiB
available memory. Redpanda is configured for one core and 1 GiB, one replica,
with `--unsafe-bypass-fsync=false`; topic write caching is disabled. Host loss and
storage-device guarantees were not tested. Generator, broker, storage, ingestion,
worker, and other development processes share this machine.

Ingestion limits were kept at 1,000 outstanding events and 8 MiB. Worker chunks
remain capped at 100 records or 1 MiB source data, with a 4 MiB insert cap.

## Measurements before producer coalescing

| Measurement                                   | 200 events/s, 60 s |       1,000 events/s, 60 s |
| --------------------------------------------- | -----------------: | -------------------------: |
| Result                                        |             Passed | Failed offered-load target |
| Accepted / unique stored events               |    12,020 / 12,020 |            59,197 / 59,197 |
| Retry outcomes                                |                  0 |                         43 |
| Dropped generator iterations                  |                  0 |                         38 |
| Final source lag / dead letters               |              0 / 0 |                      0 / 0 |
| Peak sampled source lag                       |                 14 |                         22 |
| Mean confirmed storage write                  |            4.84 ms |                    4.23 ms |
| Storage p95 histogram upper bound             |              10 ms |                      10 ms |
| Confirmed storage writes                      |              2,457 |                     10,605 |
| Worker average CPU cores over observed window |              0.068 |                      0.177 |
| Worker peak sampled RSS                       |          144.4 MiB |                  199.1 MiB |
| Ingestion peak outstanding events             |                 44 |                      1,000 |

The higher-rate run reached admission capacity and returned bounded retry
outcomes. All accepted events reached unique stored rows, but the offered rate
was not sustained without retries or generator drops. This must remain a failed
load result; it is not evidence of accepted-data loss. The generator's HTTP p95
was about 914 ms in that run. Worker backlog and storage acknowledgement times
alone did not explain the ingestion admission pressure.

The baseline's original k6 JSON was overwritten by an early report filename
collision. Its final counters, worker samples, and successful threshold decision
remain available, but its raw HTTP quantiles are not retained. Generator reports
now use `k6-<profile>.json`, separate from `sustained.json`.

## Producer coalescing and observed comparison

Previously each event made a separate `producer.send` call, with one in-flight
request configured. Commit `3d1e504` coalesces same-turn publications into producer
requests bounded at 100 records and approximately 256 KiB of values, keys, and
headers. A larger single admitted record travels alone. There is no linger timer;
a sparse publication flushes in the next microtask.

Each event remains a separate broker record with its trusted project/session key
and stable event ID. Capacity stays reserved per event until the actual grouped
send settles, including after caller cancellation. A failed grouped send leaves
all its records unconfirmed; retries retain IDs for downstream deduplication.
The admission limits, broker concurrency, and worker chunk limits are unchanged.

Unit checks cover grouping, count/UTF-8 bounds, sync/async failures, cancellation,
shutdown drain, and tenant metadata. The isolated broker interruption/retry
exhaustion probe passed after the change. A clean-checkout repeat of the same
higher-rate profile also passed:

| Measurement at nominal 1,000 events/s for 60 s |          Before | After coalescing |
| ---------------------------------------------- | --------------: | ---------------: |
| Accepted / unique stored events                | 59,197 / 59,197 |  60,020 / 60,020 |
| Retry outcomes / generator drops               |         43 / 38 |            0 / 0 |
| Peak admitted events                           |           1,000 |               80 |
| HTTP p95                                       |          914 ms |          8.21 ms |
| Final source lag / dead letters                |           0 / 0 |            0 / 0 |
| Peak sampled source lag                        |              22 |               20 |
| Confirmed storage writes                       |          10,605 |            2,985 |
| Mean storage acknowledgement                   |         4.23 ms |          4.50 ms |
| Storage p95 histogram upper bound              |           10 ms |            10 ms |
| Worker average CPU cores over observed window  |           0.177 |            0.078 |
| Worker peak sampled RSS                        |       199.1 MiB |        182.8 MiB |

This is one local before/after comparison, not a statistically established
capacity limit or production SLO. Producer coalescing reduced request pressure
without increasing admission limits or broker concurrency. Larger producer
record groups also reached the worker in larger batches, reducing insert count.
The mean storage-write time itself did not improve. The post-change run retained
both its raw k6 summary and pipeline report.

## Storage interruption during sustained traffic

At nominal 200 events/second for 60 seconds, the isolated ClickHouse was paused
for approximately ten seconds after traffic had started. All 12,000 events were
accepted and reached 12,000 unique rows, with no retry responses, generator drops,
or dead letters. Sampled source backlog peaked at 1,980 records and returned to
zero. The worker recorded one failed storage write and a retry. HTTP p95 was
about 13.7 ms; the pause did not make ingestion wait for ClickHouse.

The interruption helper attempts to resume storage even when pause acknowledgement
is uncertain or cancellation occurs, and preserves both interruption and resume
errors. Unit tests cover these cleanup paths. This is a short storage outage in
owned local infrastructure, not host/disk disaster recovery.

## Workload reproducibility limitation

The initial measurements above select sessions from k6 virtual-user IDs. Faster
requests change how many virtual users are active, so the partition distribution
also changes. This confounds attributing every before/after metric to producer
coalescing alone. The recorded gains remain observations, not a controlled
partition-distribution benchmark.

Sustained profiles now select a fixed pool of 100 session IDs using the global
scenario iteration number, independent of virtual-user scheduling. Future reports
record `config.sessionCount`; fresh verification of this workload is in progress.
Normal non-sustained scenarios keep their earlier session selection.

## Evidence

Artifacts are local ignored files; committed harness assertions are the durable
regression coverage. Read `result.json` for final success after teardown.

- Baseline, clean commit `792f53f`:
  `test-results/load/2026-10-31T15-21-50.159Z-sustained/`.
- Higher-rate pre-change run, clean commit `96721f3`, failed:
  `test-results/load/2026-10-31T15-25-27.070Z-sustained-stress/`.
- Higher-rate post-change run, clean commit `3d1e504`, passed:
  `test-results/load/2026-10-31T15-33-04.987Z-sustained-stress/`.
- Sustained storage interruption after coalescing, passed (working tree):
  `test-results/load/2026-10-31T15-38-26.906Z-sustained-outage/`.
- Full native-browser pipeline after coalescing, passed:
  `test-results/load/2026-10-31T15-35-08.189Z-browser-pipeline/`.
- Grouped-send broker recovery, passed (working tree contained the change):
  `test-results/load/2026-10-31T15-32-08.441Z-recovery/`.

CPU averages use changes in process CPU seconds over the sampled wall-clock
window. RSS and lag are sampled peaks, not continuous maxima. The storage
histogram measures HTTP insert acknowledgement through the response body,
excluding validation and source-offset commit. Its p95 is a bucket upper bound,
not an exact percentile. Total chunk-attempt latency remains a separate metric.
Container statistics are sequential snapshots, not atomic with source offsets.

Run profiles with the standard operations runner:

```sh
./scripts/signaltrail-ops.mjs load sustained-smoke
./scripts/signaltrail-ops.mjs load sustained
./scripts/signaltrail-ops.mjs load sustained-stress
```

Longer endurance, representative payload sizes and session skew, repeated runs,
longer/repeated storage interruptions, and tests on a selected deployment
host remain necessary before setting supported throughput or production SLOs.
