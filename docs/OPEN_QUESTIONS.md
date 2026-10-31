# Open questions and working assumptions

Updated: 2026-10-31. Record unresolved decisions here for asynchronous review.
Entries are questions, not approvals or completed work.

## Needs user input before production

- **Infrastructure budget and host:** provider, VPS size, region, monthly budget,
  and expected personal-use traffic remain undecided. Current load results are
  local development evidence; do not treat them as production capacity estimates.
- **Recovery targets:** the single-VPS plan accepts a four-hour restore target and
  a best-effort one-hour recovery point. Backups, off-server archive lag rejection,
  and restoration drills still need implementation and measured validation.
- **SDK telemetry consent:** aggregate health reporting is opt-in and sampled.
  Keep those defaults; decide product-facing consent and documentation before
  enabling it in a deployed application.
- **Public SDK capture API:** the package currently exposes queue/transport APIs
  that accept complete typed events. A higher-level `init`/`track`/`identify` API,
  generated session/visitor identities, and runtime validation/error reporting for
  JavaScript callers are not implemented. Decide those semantics before presenting
  the SDK as a drop-in analytics integration. Keep the low-level APIs stable during
  infrastructure verification.
- **Dead-letter policy:** the processor core caps input parsing at 512 KiB.
  Invalid messages within the cap retain original bytes as base64 in DLQ records;
  oversized messages retain only source coordinates, byte count, and SHA-256.
  Choose production DLQ retention, access restrictions, and oversized-payload
  retrieval before enabling it. Raw dead-letter bytes can contain customer data
  and must never be copied into general logs. The processor now has a
  runnable consumer with bounded retries and shutdown. The isolated pipeline
  verifies process kill/restart recovery with the same consumer group. Production
  process supervision, credentials, and DLQ configuration are still pending.
- **Alert delivery:** Grafana Cloud metrics are configured, but alert recipients,
  notification channels, and production availability objectives are undecided.
  Do not send notifications or create external integrations without instruction.

- **Representative analytics workload:** sustained profiles currently use small
  synthetic JSON events, 20 events/request, at nominal 200 and 1,000 events/second
  for 60 seconds. Decide expected event sizes, sparse/burst traffic, hot sessions,
  and performance objectives before interpreting these as a supported workload.
  Current rates are local measurement inputs, not customer capacity promises.

- **Whole-ingestion admission:** publisher limits bound admitted broker work;
  HTTP now also has a provisional 128-slot body/auth/publication processing gate,
  configurable with `SIGNALTRAIL_MAX_CONCURRENT_REQUESTS`. A real slow-upload
  probe verifies early 503 refusal and SDK retention/retry. TCP/proxy connection
  admission and per-project quotas remain unresolved; a processing-slot cap is
  not a whole-process RSS guarantee or connection-flood test.

- **Analytics read semantics and access:** the new server-only reader counts
  unique events by latest `received_at`, using a required UTC window of at most
  31 days. A later retry can move an event between received-time windows. Decide
  event-time versus receive-time product semantics before exposing dashboard
  totals. A server must authorize project membership before calling the reader;
  public ingestion keys must never grant read access. Production read-only
  ClickHouse credentials and allowed query settings remain to be provisioned.

## Reversible defaults during autonomous work

- Keep ingestion acknowledgement dependent on Redpanda, with downstream dedupe
  by trusted project identity and stable event ID. Do not introduce a database
  lookup into ingestion to deduplicate.
- Exercise failures only against isolated test infrastructure; do not restart
  the development broker or remove its volumes to test recovery.
- Continue local development and make local commits after verified slices.
  Pushing commits, production deployment, and paid infrastructure are out of scope.
- SDK queue limits remain provisional until workload and browser tests justify
  changing them. Preserve older queued events when capacity is reached.

## Newly observed during October 30 work

- **Downstream dedupe is still required:** the isolated recovery probe observed
  sends settling after the ingestion deadline, followed by SDK retries with the
  original IDs. Ingestion intentionally permits these duplicates. The initial
  ClickHouse migration and isolated pipeline now exercise downstream uniqueness
  by `(projectId, eventId)` using `FINAL`. The query API is still pending; every
  analytics read must preserve that uniqueness rather than relying on background
  merges. Confirm consistency and conflict semantics before exposing totals.
- **Working ClickHouse design:** the first migration uses
  `ReplacingMergeTree(received_at)` with `(project_id, event_id)` as the sorting
  and replacement key. Unique reads use `FINAL`; background replacement alone
  does not guarantee unique results. The latest receive timestamp wins. There
  is no time partition, so retries crossing receive dates stay together. Client
  timestamps remain strings so valid out-of-range client dates cannot poison
  storage writes. Confirm conflict semantics, query cost, retention, and future
  partitioning before production. The worker now groups fetched partition records
  into synchronous inserts bounded at 100 records or 1 MiB of source data, with
  a 4 MiB serialized insert cap. A single oversized source record goes through
  the existing bounded dead-letter path. Offsets advance only after all required
  storage and dead-letter acknowledgements; a failed chunk may replay in full.
  These are provisional operational limits, not measured production throughput.
  Measure sustained capacity before changing them. Mixed-chunk attempt metrics
  use the stored outcome; completion counters still count individual records.
  Chunk-size histograms count selected source chunks once, before retries, and
  include invalid records. They do not count unique events or completed inserts.
  Non-transient storage failures currently retry the entire chunk rather than
  discarding schema-valid events. Decide operator repair/quarantine procedures
  before production; do not infer that every storage error is a poison event.
  KafkaJS expands compressed fetches before application chunking, so the chunk
  byte cap bounds processor work and insert construction, not total decoder
  memory. Keep broker access restricted and measure compressed workloads plus
  broker record-batch limits before claiming a whole-process memory bound.
- **Worker monitoring:** the worker has an optional loopback-only metrics endpoint
  (`SIGNALTRAIL_PROCESSOR_METRICS_PORT`), disabled by default. Its running gauge
  means the consumer loop is active, not that storage is healthy or lag is zero.
  Completion counters reset on process restart and are not unique-event totals.
  The isolated pipeline verifies retry and completion metrics. Decide production
  scrape networking, lag visibility, and alert thresholds before deployment; the
  endpoint is not yet added to the live Alloy configuration.
- **Queue capacity evidence:** the native Chromium benchmark records three fill
  trials each at 100, 500, and 1,000 events with a 128-character property value.
  On the local Apple M3 Pro, replacing cursor-based scans with atomic bulk reads
  reduced median fill time from about 1.19 s to 0.65 s at 500 events and from
  4.25 s to 2.48 s at 1,000. These are local queue-only measurements, not upload
  throughput or a supported-device budget. Defaults remain unchanged; profile
  representative payloads, weaker devices, concurrent tabs, and real delivery
  before changing capacity or adding cached counters/schema migrations.
- **IndexedDB upgrade fallback:** blocked opens use the existing bounded memory
  fallback immediately; silent opens have a five-second timer. Abandoned late
  opens are closed. Existing connections close for future version upgrades and
  subsequent operations degrade to memory while durable data stays in IndexedDB.
  Unit and native Chromium tests verify this behavior. Review whether a grace
  period or later durable reattachment is needed before public SDK rollouts;
  memory fallback remains best effort and is not page-close persistence.
- **Browser bundle budget:** the initial unminified test harness bundle measured about 791 kB
  plus its source map. This is a development artifact, not a measured production
  transfer size. Measure minified gzip/Brotli size and startup cost before setting
  a public SDK size budget or deciding whether validation dependencies need to
  change. The initial standalone minified bundle measured 479,294 bytes
  (100,956 gzip; 83,690 Brotli) for all public exports and nearly the same for
  the delivery-only import. The report identifies validation modules and locale
  code as major contributors. Native ESM namespace imports in contracts reduced
  this pinned-esbuild measurement to 125,199 bytes minified, 36,739 gzip, and
  32,614 Brotli while preserving the schema behavior. This comparison does not
  establish the savings in a different application bundler. CI now records the
  size report without enforcing an arbitrary budget. No dependency replacement
  is assumed.
- **Kafka timeout warning:** local KafkaJS runs emit a `TimeoutNegativeWarning`.
  A local reproduction traced it to KafkaJS 2.2.4's
  `RequestQueue.scheduleCheckPendingRequests`: an empty, unthrottled queue can
  schedule `throttledUntil - Date.now()` with `throttledUntil = -1`. Node 24 clamps
  that negative delay to 1 ms. The source is identified; production compatibility
  and the appropriate upstream fix remain unresolved. Do not suppress warnings
  globally or change the client library without regression tests.

## Evidence gaps

- October 23 load scenarios covered short local baseline, burst, count, and byte
  saturation runs. Broker interruption, endurance, production sizing, and full
  SDK-to-storage recovery were not demonstrated by those results. On October 30,
  an isolated pause/resume probe verified both late acknowledgements and exhausted
  Kafka retries, stable SDK event IDs, bounded publication capacity, and actual
  Redpanda records. That probe uses Node memory fallback; it does not demonstrate
  browser persistence through a full broker outage or host/disk disaster recovery.
  A later native-Chromium pipeline now verifies an event survives page close in
  IndexedDB, is retained after an actual broker publication retry, and reaches
  ClickHouse after broker recovery with the original ID and one logical row.
  This covers one browser context, not browser-process restart, eviction, or
  host/disk disaster recovery.
- The project status document now includes the October 30 checkpoint and
  distinguishes current verification from dated session history. Inspect the
  current checkout and recorded evidence before repeating completed tasks.

New unknowns discovered during work should include the impact, current default,
and the point at which an answer becomes necessary.
