# SignalTrail remaining work

Updated: 2026-11-10. This is the current task queue. Historical “next” entries in
PROJECT_STATUS are session records, not instructions to repeat completed work.
Evidence and limitations belong in PROJECT_STATUS; decisions awaiting the user
belong in OPEN_QUESTIONS. Update this queue when a slice is completed or blocked.

## Next safeguard comparison

- [x] Explain HTTP concurrency, PostgreSQL pool and outstanding-query limits;
      user authorized a single-constraint comparison.
- [x] Raise only isolated fixture HTTP cap 32 → 128 and run boundary profile:
      100 EPS / 120 seconds passes; 150 EPS fails at metadata gate/latency.
- [x] Repeat fresh cap-32/cap-128 trials at 100 EPS in the same session:
      cap 32 passes; cap 128 has one metadata-gate HTTP 503. No reproducible
      benefit from raising the HTTP cap is established.
- [x] Add retained metadata occupancy peaks, acquisition/execution timing and
      timestamped refusals, plus HTTP peaks and ingestion event-loop delay.
      Real PostgreSQL contention probe and unchanged 100-EPS trial pass.
- [x] User-authorized eight-connection / 16-total-query experiment at 100 EPS
      for two minutes passes. Named `capacity-4gb-db8` profile retains baseline.
- [x] Complete four alternating five-minute 100-EPS trials (4/8/4/8 connections):
      pass / fail / fail / fail; metadata refusals 0/64/10/3. All accepted events
      stored and all stacks cleaned up. No consistently zero-refusal pool found.
- [x] User-authorized eight connections / 24-total-query experiment: two fresh
      five-minute 100-EPS trials both fail (275 / 743 HTTP 503s), including HTTP
      and metadata gate refusals. Experimental profile preserved; no default change.
- [x] Add and validate interval scheduling/GC/pressure/PostgreSQL-wait telemetry.
      Reproduced one refusal with CPU pressure and GC activity in the same interval;
      no app quota throttling or memory-limit events. Historical long stall remains
      unresolved; capacity fixtures were not registered with Alloy load discovery.
- [x] Suppress only concurrent analytical SQL at unchanged limits/data/rate:
      control still fails with 14 metadata refusals and roughly 13% app CPU pressure.
      Query workload is not a sufficient explanation; one pair is not causal proof.
- [x] Pin generator to CPUs 2,3 while targets remain on 0,1: five-minute 100-EPS
      full-query run passes with 30001 stored and zero refusals; affinity verified.
- [x] Inspect ClickHouse memory counters: 1280-MiB cap causes reclaim/max-limit
      events without OOM. Overall four-GiB insufficiency is not established.
- [x] Research Lightsail CPU/RAM bundle prices: no four-vCPU/four-GB plan;
      two/four IPv4 $24 general or $42 compute; smallest four-vCPU compute is
      eight GB/$84. Sources in `performance/lightsail-options.md`.
- [x] Repeat generator-isolated original allocation: fails with 13 metadata 503s;
      isolation alone is not reliably sufficient. All accepted events stored.
- [x] Test separate four-GiB redistribution (ClickHouse 1536 / app 384 / PostgreSQL
      128 MiB, other caps/reserve unchanged). Two fresh five-minute 100-EPS runs
      pass with zero refusals, exact storage/drain and no detected OOM/restart.
- [x] Add 30-minute revised-allocation profile, complete streamed interval history
      and minute checkpoints; 58 units and fresh telemetry integration pass.
- [x] Complete authorized 30-minute 100-EPS endurance run: fails with ClickHouse
      analytical memory rejection, later metadata/HTTP refusals and generator drops.
      Recovered traffic intervals; automatic export and exact reconciliation fail.
      See [endurance evidence](performance/4gb-endurance.md).
- [x] Decouple interval collection from analytical-query errors; persist/report errors
      immediately and continue attempts. 65 units and real 30-second forced-memory
      failure verify later attempts, exact storage, continued/complete telemetry.
- [x] Complete bounded query-memory/threads/spill/count/FINAL investigation and
      one-variable text-log control. Query peaks ~14–15 MiB; no thread/spill memory
      benefit observed, text-log disabling does not reduce broader tracked growth.
      Evidence: [query memory](performance/4gb-query-memory.md).
- [x] Complete 15-minute allocator/background trace: reproduce two server-wide
      rejections with 15–17 MiB query memory; all 387 IDs/61 snapshots retained.
      Large query-log merge (402 MiB), live allocation and fragmentation measured.
      See [memory trace](performance/4gb-memory-trace.md); no single-cause proof.
- [ ] Compare reduced routine insert query-log volume with 100% tagged analytical
      logging at unchanged 15-minute workload/budget; verify every analytical ID.
      If growth persists, capture allocation stacks/heap for retained consumers.
- [ ] Extend the revised profile to longer retained-data/maintenance measurements;
      qualify actual-host CPU credits/disk/OS overhead before supported capacity
      or production sizing claims. No paid target/default change is authorized.
      See [memory redistribution](performance/4gb-memory-rebalance.md).
- [x] Register isolated capacity ingestion/host/processor/broker metrics with Alloy;
      export DB histograms/pressure, run labels/config and test lifecycle metrics.
      Two telemetry smoke runs pass; actual Alloy load forwarding observed.
- [x] Prepare 28-panel capacity dashboard and validate metric names against real
      endpoint output. Add scrape availability/freshness and measurement semantics.
- [ ] Import/render/query-verify in `https://dashingjackal3083.grafana.net`.
      URL supplied; blocked by browser page-control TypeError despite working
      tab discovery and documented recovery attempts. Resume when browser control
      works; no Grafana plugin alternative found. Do not request the URL again or
      assume telemetry write-token permissions. See
      [capacity monitoring](setup/capacity-monitoring.md).

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

- [x] Local two-CPU/four-GiB frontier and longer repeat: 50 EPS passes a fresh
      three-minute trial with one million rows; 100 EPS is not repeatably
      zero-refusal and 200 EPS fails. Exact accepted/stored/offset drain holds;
      admission and metadata limits surfaced before an observed OOM. See
      [capacity evidence](performance/4gb-local-capacity.md).
- [ ] Investigate measured admission/metadata-gate contention without blindly
      raising bounds; repeat on the selected host with CPU-credit, retained-data,
      concurrent-query, backup and endurance measurements before capacity claims.
- [x] First two-GiB comparison: same three stages and concurrent SQL pass under
      1664-MiB service caps plus host allowance. ClickHouse cap headroom is narrow;
      this does not qualify production memory, CPU, disk or endurance.
- [x] First four-GiB local memory screen: 10/25/50 session pools at 1/2.5/5 EPS,
      seeded rows, concurrent SQL and accepted/stored reconciliation pass under
      hard service caps. No target-host or endurance capacity claim.
- [ ] Qualify a low-cost host after the local four-GiB memory screen. User set a
      maximum $50/month VPS budget and an initial 10–50 active-user target.
      `load memory-4gb` and its limitations are documented in
      [local feasibility](performance/4gb-local-feasibility.md). Cloudflare
      Workers/D1/Basin is an alternative under discussion, not an approved rewrite.
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
