# Four-GiB local readiness runs — November 11

All runs: revised four-GiB allocation (ClickHouse 1536, app 384, PostgreSQL 128,
Redpanda 1280, Valkey 128 MiB), targets on CPUs 0,1 and generator on 2,3, async
inserts + small-server ClickHouse, 100 singleton EPS, 1000 sessions. The user's
development stack was running on the same Mac. New in these runs:

- **Ingestion key cache** (commit fc154a8): in-memory key→project cache, used only
  while a PostgreSQL LISTEN connection is live, invalidated by NOTIFY (migration
  003), 5-minute TTL backstop.
- **Acceptance-ID ledger** (9743d2f): ingestion records each event's outcome
  (`accepted`, `late`, `failed`); the run reconciles every stored ID against it.
  Accepted-but-missing or stored-without-outcome fails; stored ambiguous retries
  are reported, not treated as loss.

## Early refusal burst: cause and fix

Two pre-cache repeats of `capacity-4gb-memory-trace-async` failed on metadata-gate
refusals in the first two minutes (latest: 89 refusals, 32 drops at 17:53). Interval
history: refusals coincide with 200–350 ms app event-loop stalls; metadata
connection wait up to 439 ms and query time up to 994 ms while PostgreSQL backends
were idle (`ClientRead`). Every request looked up its key in PostgreSQL, so a short
stall queued ~24 lookups and filled the gate. The user chose the NOTIFY-invalidated
cache.

| `capacity-4gb-memory-trace-async` (15 min) | Before cache      | With cache                             |
| ------------------------------------------ | ----------------- | -------------------------------------- |
| Metadata refusals / drops                  | 89 / 32           | **0 / 0**                              |
| HTTP p95 / p99 / max                       | 8.1 / 70.0 ms / — | **4.5 / 12.3 / 153 ms**                |
| Accepted → stored (per ID)                 | 89880 → 89880     | 90001 → 90001, 0 missing, 0 unrecorded |
| Result                                     | fail              | **pass**                               |

Report: `test-results/load/2026-11-11T18-22-46.859Z-capacity-4gb-memory-trace-async/`.

## 30-minute endurance with dashboard load and retention — failed on one host stall

`capacity-4gb-memory-trace-async-dashboard-endurance`: 9M rows over 90 days, TTL
active, one explorer page load every 5 s.
Report: `test-results/load/2026-11-11T18-49-41.256Z-capacity-4gb-memory-trace-async-dashboard-endurance/`.

| Measurement                                              | Result                                |
| -------------------------------------------------------- | ------------------------------------- |
| Accepted / missing / stored without outcome              | 179177 / 0 / 0                        |
| Failed publications later stored (client told retry)     | 125                                   |
| Metadata refusals / generator drops                      | 0 / 556                               |
| HTTP p95 / p99 / max                                     | 5 / 17 / 8425 ms                      |
| Dashboard pages / query errors / p50 / p95 / max         | 325 / 0 / 352 / 1188 / 2517 ms        |
| Dashboard p95 first vs second half                       | 1151 vs 1299 ms                       |
| Window p95: 1 / 7 / 30 days                              | 271 / 455 / 1320 ms                   |
| ClickHouse jemalloc / tracked memory (start → max → end) | 229 → 363 → 296 / 253 → 326 → 267 MiB |
| Drain                                                    | 0.27 s                                |

Everything failed in a single interval at 19:12:54: the app's 1-second interval took
6.6 s, event-loop delay 3.6 s, GC max 293 ms, app CPU pressure 50%. Container samples
show every container spiking together at 19:12:44 (ClickHouse 135%, app 108%, k6
generator 139% on its separate CPUs, PostgreSQL 21%, Redpanda 19%), and the next sample
arrived after 13 s instead of 5. This matches the host/Docker-VM-wide stall in the
[50-EPS run 2](4gb-step-down-endurance.md); it is not explained by SignalTrail work and
cannot be separated further on this Mac. The ledger shows no accepted loss: the 125
retry responses were publications that completed late.

## Five concurrent dashboard viewers — fails the 2-second page target

`capacity-4gb-memory-trace-async-dashboard-viewers5`: five page loads fired at the
same instant every 5 s (a worst-case burst, ~1 page/s), 10 minutes, with ingestion.
Report: `test-results/load/2026-11-11T18-38-38.185Z-capacity-4gb-memory-trace-async-dashboard-viewers5/`.

| Measurement                        | Result                                                 |
| ---------------------------------- | ------------------------------------------------------ |
| Pages / query errors               | 430 / 0                                                |
| Page p50 / p95 / max               | 1130 / 2228 / 3018 ms                                  |
| Window p50 / p95: 1 day            | 614 / 878 ms                                           |
| Window p50 / p95: 7 days           | 1126 / 1632 ms                                         |
| Window p50 / p95: 30 days          | 1954 / 2404 ms                                         |
| Query p95: list / count / visitors | 1646 / 1015 / 2227 ms                                  |
| Ingestion                          | 60000 accepted, 0 refusals, HTTP p95 4.9 ms, 0 missing |

With two CPUs shared by all services, five simultaneous 30-day pages queue behind
each other. Ingestion was unaffected. Options (not decided): cap concurrent dashboard
queries per server; cache page results for a short time; approximate visitor counts;
more CPU on the VPS. Single-viewer pages stay under 1.3 s p95.

## Retention (TTL) delete cost

No TTL merge ran during 10- or 30-minute runs (2094 expired seed rows remained at
the end of endurance); ClickHouse schedules TTL merges itself (`merge_with_ttl_timeout`,
default 4 h between TTL merges). To measure the cost, an isolated ClickHouse with
the same limits (2 CPUs, 1.5 GiB, small-server config) held 9M rows in one 423-MiB
part, 62,075 past 90 days, and ran `MATERIALIZE TTL` (no concurrent load):

| Measurement  | Result                                 |
| ------------ | -------------------------------------- |
| Duration     | 6.0 s                                  |
| CPU          | ~1 core (104%)                         |
| Merge memory | ~58 MiB (container 535 MiB)            |
| Rows removed | 62,070 (5 more expired during the run) |

On the unpartitioned table a TTL merge rewrites every part containing expired rows,
so the cost grows with retained size: about one core for ~6 s per 9M rows, at most
every 4 hours by default. Under concurrent ingestion it competes for the same two
CPUs; that combination was not observed.

## Remaining limitations

- One run each on a shared Mac; host-wide stalls make a stable local pass/fail
  impossible. Qualification needs the candidate VPS.
- Concurrent viewers modelled as simultaneous bursts, not real browsing.
- TTL cost measured without concurrent load.
