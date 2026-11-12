# Four-GiB step-down endurance — November 10

## Purpose

Every sustained 100-EPS run on the revised four-GiB allocation failed. The user
chose to find the highest sustained passing rate before further ClickHouse
debugging, starting at 50 EPS.

```sh
./scripts/signaltrail-ops.mjs load capacity-4gb-db8-q24-endurance-50
```

Configuration is identical to `capacity-4gb-db8-q24-endurance` except the offered
rate: 1800 seconds, singleton events, 1000 sessions, one million historical rows,
concurrent analytical SQL, ClickHouse 1536 / app 384 / PostgreSQL 128 / Redpanda
1280 / Valkey 128 MiB plus 640 MiB host allowance, HTTP 128 / pool 8 / gate 24,
worker batch wait 0 (default). Targets share CPUs 0,1; generator uses 2,3
(affinity verified). The user's development stack was running on the same Mac.

## Result — run 1: passed

Report: `test-results/load/2026-11-10T22-38-36.799Z-capacity-4gb-db8-q24-endurance-50/result.json`.

| Measurement                                      | Result                                         |
| ------------------------------------------------ | ---------------------------------------------- |
| Accepted / unique stored                         | 90001 / 90001                                  |
| Retries / rejected / malformed / generator drops | 0 / 0 / 0 / 0                                  |
| HTTP failure rate                                | 0                                              |
| HTTP p50 / p95 / p99 / max                       | 2.40 / 11.29 / 54.26 / 1169.88 ms              |
| Metadata / HTTP admission refusals               | 0 / 0                                          |
| Publication cancellations / late completions     | 0 / 0                                          |
| Final source lag (3 partitions)                  | 0                                              |
| Analytical queries during traffic                | 846, 0 errors; p50 106 / p95 341 / max 1142 ms |
| Container OOM kills / restarts                   | 0 / 0                                          |
| Interval records saved                           | 1806, complete through export                  |

## ClickHouse memory under the 1536-MiB cap

From 359 cgroup samples (`samples.json`, `memory.stat`/`memory.events`):

| Time (UTC) | Anonymous | Page cache | Cumulative `max` events |
| ---------- | --------: | ---------: | ----------------------: |
| 22:38:57   |   253 MiB |     27 MiB |                       0 |
| 22:43:57   |   515 MiB |    639 MiB |                    3853 |
| 22:48:59   |   770 MiB |    534 MiB |                   11217 |
| 22:56:33   |   768 MiB |    174 MiB |                   31809 |
| 23:04:07   |   758 MiB |    106 MiB |                   44947 |
| 23:08:59   |   762 MiB |     24 MiB |                   56453 |

Anonymous (heap) memory grew for about ten minutes, then held at roughly
750–780 MiB for the remaining twenty. This contrasts with 100-EPS runs, where
growth continued until a server-wide memory rejection. The cgroup stayed at its
cap throughout: the kernel reclaimed page cache (`max` events climbed steadily,
no `high`/OOM events). Docker-displayed usage (~1.44 GiB) includes that cache.

## Result — run 2: failed

Report: `test-results/load/2026-11-10T23-10-40.464Z-capacity-4gb-db8-q24-endurance-50/result.json`.
Same checkout, profile and host conditions, started immediately after run 1.

| Measurement                                            | Result                                    |
| ------------------------------------------------------ | ----------------------------------------- |
| Accepted / unique stored                               | 89670 / 89670                             |
| Metadata-gate refusals (HTTP 503) / HTTP-gate refusals | 270 / 0                                   |
| Generator drops / retries / rejected                   | 61 / 0 / 0                                |
| Publication cancellations / late completions           | 0 / 0                                     |
| HTTP p95 / p99 / max                                   | 27.09 / 459.40 / 3252.17 ms               |
| Analytical queries                                     | 826, 0 errors; max 9892 ms (gate 2000 ms) |
| Final source lag / OOM kills / restarts                | 0 / 0 / 0                                 |

Failure reasons: refused responses, generator drops, HTTP failures, k6 threshold
exit and a diagnostic query over two seconds. Accepted events were all stored.

Refusal timeline (interval history, 1645 records): 18 at 23:12:00 during warm-up
(a 2-second interval, 553-ms event-loop delay, 385 ms GC); 5 at 23:18:48; then
about 243 between 23:32:56 and 23:33:36. During that window app-cgroup CPU
pressure `some` avg10 rose from ~10% to 39–52%, event-loop delay reached 2124 ms
and intervals stretched to 2–3 s.

Docker samples show ClickHouse CPU rising from ~40–70% to 114–154% from 23:32:49
for about a minute, while the app reached 52–79%. At 23:33:02 the generator
(separate CPUs 2,3) also showed 130% and Redpanda 31%, and sampling gaps widened
from ~5 s to 7–9 s. ClickHouse anonymous memory stayed ~755–830 MiB, matching run
1's plateau. Simultaneous spikes on the isolated generator suggest a host- or
Docker-VM-wide event, possibly combined with ClickHouse background work; the
data cannot separate these causes. The isolated stack was removed before part
logs could be inspected.

## Interpretation and limitations

- 50 EPS is not a repeated pass: one pass, one failure from a sub-minute CPU
  stall. Memory behaved the same in both runs (plateau ~760 MiB), so the failure
  is CPU scheduling, not ClickHouse memory.
- This Mac, with the development stack running, is too noisy to pin a precise
  sustained limit. Stepping down to 25 EPS locally would test stall tolerance,
  not a VPS limit.
- The heap plateau is observed over 30 minutes only. Retained inactive-part
  metadata (see [heap attribution](4gb-heap-profile.md)) may still grow over
  hours; multi-hour soak remains unverified.
- Page-cache reclaim at the cap is not a failure, but leaves little ClickHouse
  read-cache headroom; query latency on larger retained data is unmeasured.
- Local Docker on an Apple M3 Pro with shared host activity, not a 4 GiB VPS.
  Candidate-host CPU, disk and steal time can change the result.
- Per the qualification rule, the initial operating ceiling would be about half
  the lowest repeated passing rate (≈25 EPS had 50 repeated), still ~5× the
  10–50-user launch estimate of 1–5 EPS.
