# Four-GiB async inserts with small-server tuning — November 10

## Purpose and configuration

Heap attribution showed retained inactive-part metadata dominating ClickHouse
memory growth because the worker averaged ~1.1 records per insert. ClickHouse
guidance is about one insert per second, using `async_insert` when clients cannot
batch, plus low-memory tuning on small servers. The user chose to test both together.

```sh
./scripts/signaltrail-ops.mjs load capacity-4gb-memory-trace-async-smoke
./scripts/signaltrail-ops.mjs load capacity-4gb-memory-trace-async
```

- Worker: opt-in `SIGNALTRAIL_CLICKHOUSE_ASYNC_INSERT=1` sends `async_insert=1`,
  `wait_for_async_insert=1`, `wait_end_of_query=1`. The insert response, and so
  the source-offset commit, still follows the flushed write. Default remains `0`.
  Worker fetch batching stays 0 ms.
- ClickHouse users profile (`clickhouse-async-insert-users.xml`): adaptive busy
  timeout off, `async_insert_busy_timeout_max_ms=1000` (pinned 26.8 defaults are
  adaptive 50–200 ms), `input_format_parallel_parsing=0`.
- ClickHouse server (`clickhouse-small-server.xml`): `mark_cache_size` 256 MiB;
  13 system log tables removed (trace, text, metric, asynchronous_metric,
  query_metric, error, part, query_thread, query_views, processors_profile,
  opentelemetry_span, asynchronous_insert, background_schedule_pool).
  `query_log` stays for tagged analytical query verification.
- Workload/allocation identical to `capacity-4gb-memory-trace`: 900 s at 100
  singleton EPS, one million seed rows, concurrent analytical SQL, ClickHouse
  1536 / app 384 / PostgreSQL 128 / Redpanda 1280 / Valkey 128 MiB, HTTP 128 /
  pool 8 / gate 24, targets on CPUs 0,1 and generator 2,3. The user's
  development stack was running on the same Mac.
- The run asserts that the server recorded `AsyncInsertQuery > 0` (and zero for
  synchronous profiles). Two variables change together; this does not separate
  the effect of async inserts from the small-server settings.

Verification: processor lint, 127 tests, types and build; 78 harness units.
Smoke: `test-results/load/2026-11-10T23-49-38.008Z-capacity-4gb-memory-trace-async-smoke/result.json`
passed with 3001 accepted/stored in 88 writes (~34 records/write).

## Result — failed on nine refusals in one interval

Report: `test-results/load/2026-11-10T23-51-31.870Z-capacity-4gb-memory-trace-async/result.json`.

| Measurement | Synchronous baseline ([memory trace](4gb-memory-trace.md)) | Async + small-server |
| --- | --- | --- |
| Accepted / unique stored | 88272 / 88272 | 89992 / 89992 |
| Metadata / HTTP refusals | 1285 / 82 | 9 / 0 |
| Generator drops | 361 | 0 |
| Analytical memory rejections | 2 | 0 |
| Records per confirmed write | ~1.1 | 34.3 (89992 / 2620) |
| Server async insert queries | 0 | 2620 |
| Mean storage write duration | — | 1.02 s |
| Inactive analytics parts | tens of thousands (40584–54907 in [heap run](4gb-heap-profile.md)) | 102 → ~700 plateau |
| ClickHouse jemalloc allocated | grew ~611 MiB | 230–277 MiB, flat |
| Server tracked memory | reached ~1.33 GiB limit | 252–285 MiB |

Other measurements: HTTP p95 7.54 / p99 55.23 / max 437 ms; 429 analytical
attempts, diagnostic query max 379 ms; drain 0.02 s; no publication
cancellations/late completions; no OOM/restart; cleanup passed and lock released.
App-cgroup CPU pressure `some` avg10 over 906 intervals: median 3.79%, p95 5.29%,
max 6.82%. Run 2 at 50 EPS synchronous showed ~10% typical and 52% during its stall.

All nine refusals occurred in one interval at 23:55:12 (about 3.5 minutes in), at
the metadata gate, with 257-ms event-loop delay and 47 ms GC while CPU pressure
was only 3.98%. No refusals occurred in the following ~11.5 minutes.

Source lag held at roughly 100–200 records during traffic instead of 0–1: about
one second of traffic is always waiting for its flush. It did not grow and
drained within 0.02 s after traffic stopped.

## Interpretation and limitations

- The memory mechanism is addressed in this run: inactive parts and ClickHouse
  memory stay flat at 100 EPS where synchronous runs grew to rejection.
- CPU pressure is much lower, consistent with less merge/part work, but a single
  run on a shared host does not establish causation or that stalls are gone.
- The failure is a short early burst, not the sustained degradation seen
  before. Its cause is not identified.
- Not yet verified in async mode: the real pipeline recovery probe (paused
  storage, worker crash, ambiguous acknowledgement), and async insert behavior
  during ClickHouse outages. `async_insert_deduplicate` is 0; downstream
  `ReplacingMergeTree`/`FINAL` dedupe still covers replays.
- Storage acknowledgement latency is now ~1 s by design; end-to-end freshness
  is about one second longer.
- One 15-minute local run; repeats, longer soaks and a candidate VPS remain.
