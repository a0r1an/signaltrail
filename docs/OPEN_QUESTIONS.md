# Open questions and working assumptions

Updated: 2026-10-30. Record unresolved decisions here for asynchronous review.
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
- **Alert delivery:** Grafana Cloud metrics are configured, but alert recipients,
  notification channels, and production availability objectives are undecided.
  Do not send notifications or create external integrations without instruction.

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
  original IDs. Ingestion intentionally permits these duplicates. Before exposing
  analytics totals, implement and test dedupe by `(projectId, eventId)` downstream;
  decide query-time consistency expectations before the first query API.
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
- The project status document predates the October 23 monitoring and telemetry
  work. Inspect committed code and test evidence before repeating listed tasks.

New unknowns discovered during work should include the impact, current default,
and the point at which an answer becomes necessary.
