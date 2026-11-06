# SignalTrail remaining work

Updated: 2026-11-06. This is the current task queue. Historical “next” entries in
PROJECT_STATUS are session records, not instructions to repeat completed work.
Evidence and limitations belong in PROJECT_STATUS; decisions awaiting the user
belong in OPEN_QUESTIONS. Update this queue when a slice is completed or blocked.

## Completed slice: real local capture to dashboard

- [x] Configure development Clerk owner-only sign-in; user verified authorized
      owner and signed-out denial.
- [x] Apply tracked metadata migrations to existing local Compose PostgreSQL.
- [x] Provision owner/project/key and restricted dashboard readers.
- [x] User confirmed signed-in project selection and empty event/visitor totals.
- [x] Finish demo-store capture page lint/types/optimized build checks.
- [x] Provision separate stored-key ingestion and insert-only processor identities;
      real delivery succeeds with those identities.
- [x] Start the owned local demo pipeline through the CLI and verify an SDK event
      reaches ClickHouse. Distinguish command-line delivery from browser capture.
- [x] Commit the verified demo/pipeline slice and updated task queue.
- [x] Confirm product-click events reach local storage: read-only CLI status
      reports four `demo_product_viewed` events, separate from one labeled CLI probe.
- [x] User confirmed `demo_product_viewed` appears in the authenticated dashboard.
      This is manual browser evidence plus CLI storage verification; browser-control
      integration remains broken, and no automated browser success is claimed.

## Analytics release work

- [ ] Finish operator apply/verification tooling for an explicitly chosen
      production target; no local CLI command may silently target production.
- [ ] Verify live non-owner denial, logout and vendor-session revocation behavior;
      current owner-only checks must remain enforced.
- [ ] Enforce configurable 90-day analytics retention and document late events,
      backups/deletion and effects on visitor/identity-link resolution.
- [ ] Settle clock-skew and attribution semantics before exposing corresponding
      dashboard claims. Event-time explorer and identified visitor counts already exist.
- [ ] Decide key-rotation overlap and implement deliberate key administration;
      never silently move an old SDK queue to another key.
- [ ] Finish SDK initialization behavior when IndexedDB is unavailable, or make
      the limitation an explicit release contract; preserve multi-tab identity safety.
- [ ] Complete demo-store journeys and supported SDK installation/API examples.
- [ ] Define per-project quotas/abuse controls and deployment connection limits.
- [ ] Confirm remote CI and release checks for the final changes. Local passing
      probes do not establish a remote run, deployability or production capacity.

## Session replay

- [ ] Separate explicit replay enablement/consent lifecycle from analytics.
- [ ] Browser recording, bounded buffering, serialization/compression and upload.
- [ ] Replay ingestion/worker/S3 storage and scoped unattended worker identity.
- [ ] Protected session listing and playback with privacy defaults/masking.
- [ ] Configurable 14-day retention across S3 and metadata; deletion verification.
- [ ] End-to-end replay, consent, privacy, recovery and browser/CI coverage.

## Production reliability and operations

- [ ] Select VPS provider/region/size/budget using representative workload evidence.
      Current proposal and launch workload are in
      [launch cost/capacity](performance/launch-cost-and-capacity.md). Benchmark the
      actual short-term candidate before claiming support for 100–1,000 active users;
      no provider or spending is approved yet.
- [ ] Production TLS, restricted credentials, process supervision, Vercel routing
      and deployment/rollback workflow.
- [ ] Off-server analytics archiving and reject-ingestion policy when lag exceeds
      the agreed recovery bound.
- [ ] PostgreSQL/ClickHouse backups and replacement-host restore drill against
      four-hour RTO and best-effort one-hour RPO.
- [ ] Representative sustained/endurance/failure load tests and capacity limits.
- [ ] Production lag/availability alerts, recipients and runbooks; Grafana Cloud
      metrics exist, but alert delivery/production objectives remain unresolved.
- [ ] Define production DLQ retention/access and protected payload investigation.

The project is not complete when the analytics demo works: replay, retention,
production deployment and measured disaster recovery remain required product work.
