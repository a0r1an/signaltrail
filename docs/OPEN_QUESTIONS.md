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

## Evidence gaps

- October 23 load scenarios covered short local baseline, burst, count, and byte
  saturation runs. Broker interruption, endurance, production sizing, and full
  SDK-to-storage recovery were not demonstrated by those results.
- The project status document predates the October 23 monitoring and telemetry
  work. Inspect committed code and test evidence before repeating listed tasks.

New unknowns discovered during work should include the impact, current default,
and the point at which an answer becomes necessary.
