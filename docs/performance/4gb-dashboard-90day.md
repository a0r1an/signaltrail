# Four-GiB dashboard load over 90 days of data — November 10

## Configuration

```sh
./scripts/signaltrail-ops.mjs load capacity-4gb-memory-trace-async-dashboard-smoke
./scripts/signaltrail-ops.mjs load capacity-4gb-memory-trace-async-dashboard
```

Same as `capacity-4gb-memory-trace-async` (async inserts, small-server ClickHouse,
revised four-GiB allocation, 100 EPS for 900 s, target CPUs 0,1 / generator 2,3)
plus 90-day retention TTL and:

- Seed `retention90`: 9,000,000 rows spread evenly over 90 days by receipt time,
  100 events per visitor (~1000 visitors/day, ~90k total), 20 events per session,
  5% identity-link events. Client timestamps equal receipt times.
- Dashboard load instead of the synthetic full-table query: every 5 s, one
  explorer page load runs the real analytics reader's `listOccurredEvents`
  (limit 50), `countOccurredEvents` and `countOccurredVisitors` in parallel,
  rotating 1/7/30-day windows (the reader rejects windows over 31 days). Each
  query is tagged for the query-log export. Gate: zero query errors and page
  p95 ≤ 2000 ms. Reader limits are unchanged: 64 MiB, 2 threads, ~4 s.

Harness checks: 83 load units pass. The smoke run first exposed a harness bug
(90-day windows rejected by the reader); windows were corrected test-first.

## Result — failed

Report: `test-results/load/2026-11-11T01-06-07.794Z-capacity-4gb-memory-trace-async-dashboard/result.json`.

| Dashboard query | Result over 126 page loads |
| --- | --- |
| Visitor count | **126 / 126 failed**: 125 × code 241 (64 MiB query memory limit), 1 × timeout |
| Event count | 125 ok, 1 timeout (code 159, 4.5 s); p50 1981 / p95 2241 ms |
| Event list | 126 ok; p50 2007 / p95 2374 ms |
| Page load (parallel) | p50 2113 / p95 2408 / max 5036 ms |
| Rows read per query | ~6.6–9.4 million for every window, including 1 day |

Ingestion alongside: 89,523 explicitly accepted, 89,532 unique stored, final
source lag 0. 83 metadata refusals in a ~5 s burst at 01:17:29–34 (CPU pressure
avg10 20–39%), 322 generator drops, 9 retries with 9 publication cancellations/
late completions; HTTP p95 5.3 / p99 18.4 ms. App-cgroup CPU pressure median
4.24%, p95 6.34%. Storage equality failed because ambiguous retried events were
stored without explicit acceptance (stored exceeds accepted by 9); an
acceptance-ID ledger is still needed to reconcile per ID. One harness diagnostic
query (FINAL count over the larger table) took 2.14 s.

ClickHouse memory stayed bounded: jemalloc allocated 225–381 MiB, tracked memory
251–379 MiB, inactive parts ≤ ~700. Async inserts recorded 2623. No OOM/restart;
cleanup passed and the lock was released.

## Interpretation

- Dashboard query cost scales with total retained project data, not the selected
  window. The table is ordered by `(project_id, event_id)` with random UUIDv4 event
  IDs, and occurred-time filters parse the `client_timestamp` string, so no time
  filter can skip data.
- The visitor count cannot complete within its 64 MiB cap at ~9M rows. Its links
  CTE also scans the project's whole history by design (retroactive identity).
- Page loads at ~2.1–2.4 s are already at the gate with one owner. Concurrent
  ingestion is mostly unaffected, but one CPU burst caused refusals.
- This is a schema/query design limit; more RAM would only move the threshold.
  Options and the decision are recorded in OPEN_QUESTIONS.

## Rerun after the read-layout fix — November 11: passed

User approved fixes A + B. Changes (commits caf4737, f9e90ec): SDK UUIDv7 event
IDs; migration 003 (insert-time `occurred_at`, min/max skip indexes on received
and occurred time, `analytics_identity_links` fed by a DEFINER materialized view,
idempotent backfill); 004 (links expire after 90 days); reader filters on
`occurred_at` and resolves visitor links only for IDs active in the window, using
`min = max` instead of per-visitor exact sets. The seed now uses time-ordered IDs.
Reader limits unchanged (64 MiB, 2 threads, ~4 s).

Integration (`load analytics-read`): a 1-day read over 1.2M time-ordered rows
reads ~57k rows (counts/list) and ~90k (visitors). Visitor-resolution, event-time
and retention fixtures pass unchanged, plus backfill-once, insert-only processor,
select-only reader and replay dedupe. `pipeline`, `project-access`,
`authorized-analytics`, `sustained-smoke` pass.

Report: `test-results/load/2026-11-11T17-31-26.930Z-capacity-4gb-memory-trace-async-dashboard/result.json`.

| Measurement | Before (Nov 10) | After |
| --- | --- | --- |
| Dashboard query errors | 126 visitor + 1 count | **0** of 164 pages |
| Page p50 / p95 / max | 2113 / 2408 / 5036 ms | **317 / 1192 / 2008 ms** |
| 1-day page p50 / p95 | ~2.1 s | 122 / 180 ms |
| 7-day page p50 / p95 | ~2.1 s | 312 / 406 ms |
| 30-day page p50 / p95 | ~2.1 s | 1047 / 1384 ms |
| Visitor query p95 | failed (≥ 64 MiB) | 1189 ms; peak query memory ≤ 39.8 MiB |
| Accepted / unique stored | 89523 / 89532 | 90001 / 90001 |
| Refusals / drops / retries | 83 / 322 / 9 | 0 / 0 / 0 |
| ClickHouse jemalloc / tracked | ≤ 381 / ≤ 379 MiB | 228–391 / 253–333 MiB |

Window-cost figures are from the run's last 136 page loads. Result gate passed
with no reasons; drain 0.05 s; no OOM/restart.

Remaining limits:

- 30-day pages now dominate (p95 1.4 s, one 2.0 s page) and grow with visitors
  active in the window. Exact visitor counts may need an approximate count or
  daily rollups at larger scale.
- One owner viewing; concurrent dashboard users are untested.
- Events from SDKs sending random IDs stay correct but cannot be skipped.
- The ingestion improvement (no refusals) is one run on a shared Mac; the
  earlier CPU-stall refusals are not shown to be fixed.
