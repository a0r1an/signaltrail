# Open questions and working assumptions

Updated: 2026-11-06. Record unresolved decisions here for asynchronous review.
Entries are questions, not approvals or completed work.

## Needs user input before production

- **Initial owner and target configuration:** the atomic initial-project builder
  and local `metadata bootstrap-plan` command are implemented. Before applying a
  plan, supply the exact verified Clerk issuer/owner user ID, fresh row UUIDs,
  desired organization/project/key names, and an explicitly selected database
  with a separate operator identity. No values are inferred from chat aliases,
  email addresses, public SDK keys or account-creation reports. The local input
  example and procedure are in `setup/ingestion-data.md`. Planning is not approval
  to apply a plan, create a live membership or deploy anything; no live metadata
  has been provisioned. Existing principal reuse/extra projects need separate
  operations; this initial workflow intentionally rejects conflicts.
  Local development is now explicitly the existing Compose PostgreSQL/ClickHouse.
  Development Clerk invite-only/email-password/user setup is user-reported complete;
  local configuration checks confirm matching development issuer/key and app origin.
  The user verified owner authorization and signed-out denial. Local migrations,
  owner/project provisioning and restricted reader configuration now succeed;
  production target/operator setup remains outstanding. Browser integration errors
  prevent agent-controlled signed-in UI verification; record manual results
  separately from automated service-read evidence.

- **Project membership policy:** the new private membership foundation uses UUID
  projects and verified issuer/subject identities. Its reversible default grants
  owner/admin/member roles read access to all projects in their organization.
  Organization-wide visibility is now confirmed by the user. Account linking,
  invitations, and last-owner protection remain to be specified before exposing
  administrative APIs.
  Clerk is selected, with invite-only registration, a manually created email/
  password account, and server-side access restricted to the owner Clerk user ID
  for the first 90 days. Local Next.js integration now guards pages/APIs and
  fails closed without configuration. Clerk account creation is reported; application settings and valid-login
  verification remain pending; see `setup/clerk.md`.
  Session guards are implemented with deadlines/admission; live session
  verification, a read-only database identity, TLS/CA provisioning, and deployment
  migration application remain unverified/unconfigured. A bounded real PostgreSQL
  adapter is now locally verified; its pool/query limits still need representative
  workload measurement before production sizing.
  A versioned initial migration statement now has fixture coverage for atomicity,
  replay, checksum changes, and unsupported history. No deployment CLI or migration
  identity has been configured, and existing development data is not migrated.
  The schema/probe uses only owned isolated data; no existing database is migrated.
- **Infrastructure budget and host:** provider, VPS size, region, monthly budget,
  and expected personal-use traffic remain undecided. Current load results are
  local development evidence; do not treat them as production capacity estimates.
  User clarified: only owner-built applications, zero current usage, social-media
  launch and possible growth, with a target burst of 100–1,000 users and measured
  headroom for scaling. Arrival-vs-concurrent interpretation is pending. The
  proposal in `performance/launch-cost-and-capacity.md` budgets $35–55/month for
  analytics with Hobby, or $55–75 with one Vercel Pro seat; these are planning
  allowances, not approved spending. OVH's advertised starting price/term and
  candidate-host benchmarks must be checked before purchase or capacity claims.
  Latest clarification: the VPS budget is at most $50/month, with an initial
  target of 10–50 active users. Four-GiB local feasibility testing is authorized;
  no host purchase is authorized. Whether the $50 ceiling includes taxes,
  backups and the other cloud services remains unclear. Cloudflare
  Workers/D1/Basin/R2 and AWS serverless alternatives were explored; replacing
  the existing backend is not decided. Pricing estimates do not establish
  equivalent acknowledgment, freshness, deduplication or query behavior.
  2026-11-10: user reports $100 AWS credits on the existing account; expiry date
  not yet confirmed (new-account credits usually last six months). Agreed order:
  finish local retention and dashboard/backup load work, then size the VPS and
  use credits for a short non-burstable qualification trial. Choose the long-term
  host on full price within the $50 ceiling; no instance is authorized yet.
- **Launch workload and host direction (2026-11-11):** user expects ~1 event/minute at
  launch and requires handling 1 event/second with **no lost events** (brief
  unavailability acceptable; one server). Other services stay in AWS, so the host is
  EC2 in the same region; t4g.medium is the primary candidate. User wants measured
  limits and alarms to know when to upgrade. Plan: `performance/vps-qualification-plan.md`.
  Later 2026-11-11: phase B approved (≤ $10, same-day teardown); credits expire in
  182 days. The credits are on a **new, separate Free plan account**; the Identity
  Center profiles (`signaltrail-admin`, `signaltrail-replay-dev`) and the replay dev
  bucket stay in account 469302114413. Needed now: CLI access to the new account.
  Needed before launch: which account hosts production (a Free plan account closes
  at plan end unless upgraded; upgrading keeps remaining credits), and whether replay
  storage moves. Working assumption: trial and backup bucket in the new account,
  `us-west-2`; replay unchanged until replay work starts.
- **Recovery targets:** the single-VPS plan accepts a four-hour restore target and
  a best-effort one-hour recovery point. Backups, off-server archive lag rejection,
  and restoration drills still need implementation and measured validation.
- **Replay consent and enablement:** user approved replay as a separate explicit
  opt-in from analytics. Analytics initialization must not start page recording.
  Applications enable replay separately after handling any required consent.
  Recording/consent lifecycle implementation remains pending.
- **SDK telemetry consent:** aggregate health reporting is opt-in and sampled.
  Keep those defaults; decide product-facing consent and documentation before
  enabling it in a deployed application.
- **Public SDK capture API:** `openAnalyticsClient` now implements anonymous
  `track`/`reset`, generated visitor/session/event IDs, validated inputs, private
  URL/campaign capture and existing batching/retries. `identify` now stores local transitions and durable link records atomically;
  server-side visitor counts now resolve retained project links and the event-time dashboard displays those totals. User decisions: generate anonymous
  visitor IDs; support `identify(userId)` and link earlier anonymous activity
  within the same project; expire sessions after 30 minutes without captured
  activity, retaining the session on tab reopen within that window. URL navigation
  and query/UTM changes must not independently rotate the session.
  User agreed to stable visitor identity across campaign changes and preserving
  campaign context with events, rather than overwriting a visitor-level current
  campaign. Campaign changes do not create new anonymous IDs. First-touch,
  last-touch and session-entry dashboard attribution remain distinct models;
  their precedence remains to be specified. User approved stripping query
  parameters and fragments from recorded page URLs by default, separately
  capturing only `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, and
  `utm_content`. Applications may explicitly allow additional parameters. This
  policy now drives the public anonymous capture API; allowlisted values still
  require bounds and must not be treated as inherently free of sensitive data. A campaign change does not independently rotate sessions under the
  current inactivity-based rule. Never use query parameters as identity or copy
  arbitrary query strings into attribution.
  User approved explicit SDK `reset()` on logout: clear the identified user,
  generate a new anonymous visitor ID, and start a new session. Existing queued
  events retain their captured identities; reset must not reattribute them.
  User approved shared visitor/session state across tabs on the same origin and
  SignalTrail project, including propagation of logout/reset to other tabs.
  Cross-origin synchronization is not implied. User approved automatic reset
  before `identify(B)` when A is currently identified: create a fresh anonymous
  identity context/session for B without linking A’s history to B. Previously
  queued events retain their original identities. These transitions are implemented; keep the low-level APIs stable.
  The durable anonymous/session store now drives capture, with fake IndexedDB
  and native-browser coverage. Current high-level initialization requires
  IndexedDB, and later identity-write failures return `identity_unavailable`.
  Coordinated identity memory fallback remains future work; never claim a shared
  reset succeeded if its write fails. Low-level queue memory fallback is unchanged.
- **Analytics retention:** user approved a configurable 90-day default for raw
  analytics events. 2026-11-10: user chose row expiry on the unpartitioned table
  (no time partition, preserving cross-day retry dedupe) over partitioning by
  client or arrival time. `infra/clickhouse/002-analytics-retention.sql` applies
  `TTL toDateTime(received_at) + INTERVAL 90 DAY DELETE` (server receipt time);
  the period changes by re-running with another interval. Background TTL merge
  cost is not yet measured. Identity links now live in their own table and
  expire after the same 90 days (004). Still to define: deletion across
  backups/archives and DLQ retention. This is not a
  promise that aggregates remain after raw-event deletion. Replay retention is
  separate.
- **Dashboard query scaling:** 2026-11-11 user approved fixes A + B after a
  90-day run showed every explorer query reading all ~9M rows and the visitor
  count failing its 64 MiB cap. Implemented: SDK UUIDv7 event IDs (rows stay
  time-clustered under the unchanged `(project_id, event_id)` dedupe key);
  migration 003 adds insert-time `occurred_at` plus min/max skip indexes and an
  `analytics_identity_links` table fed by a DEFINER materialized view (processor
  stays insert-only) with an idempotent backfill; 004 expires links with events
  after 90 days, so link retention matches the previous behaviour (links came
  from retained events). Working assumptions, reversible: keep links 90 days
  (longer retention would preserve retroactive identity past 90 days but adds a
  longer-lived personal-data store); events from old SDKs with random IDs stay
  correct but unclustered. Remaining limits: exact visitor counts still need
  memory proportional to visitors active in the window; a later approximate
  count or daily rollups may be needed at larger scale. The 64 MiB reader cap is
  unchanged. Evidence: `performance/4gb-dashboard-90day.md`.
- **Dashboard concurrency:** 2026-11-11 user confirmed one dashboard viewer at a
  time at launch and that the launch dashboard views are not final. Deferred: no
  query cache, concurrency workload, `max_threads` tuning or rollups until views
  are chosen. Evidence for later: one viewer p95 ~1.2 s; five simultaneous viewers
  p95 2.23 s with 0 errors on 2 CPUs. ClickHouse guidance when needed: minute-
  rounded windows + `use_query_cache`, a dashboard WORKLOAD with a concurrency cap
  and queue, test `max_threads` 1/2/4, AggregatingMergeTree rollups for chosen views.
- **Backups (S3 approved 2026-11-11):** local drill passes. Bucket goes in the
  trial account, written by the instance role. Still needed: schedule (hourly
  incremental for the 1-hour RPO), backup retention, encryption and a production-
  size restore on the candidate VPS.
- **Replay retention:** user approved a configurable 14-day default for replay
  recordings. Recording, object lifecycle/deletion and metadata cleanup are not
  implemented. This default does not authorize changing the existing S3 bucket
  or deleting objects; enforcement requires a scoped implementation.
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

- **Analytics read semantics and access:** product dashboard dates use client
  event time, with receive time retained for diagnostics. Event-time counts,
  visitor counts, list APIs, query client and protected dashboard are implemented.
  The owner confirmed real local project selection and empty analytics reads.
  Malformed/extreme stored dates are excluded. Decide unreasonable client-clock
  handling and attribution precedence before making stronger product claims.
  Server-side Clerk owner checks and PostgreSQL membership gate each resource;
  public ingestion keys grant no reads. Local restricted readers are provisioned;
  production credentials/TLS/deployment remain pending. The original receive-time
  methods remain available for delivery diagnostics, not product date semantics.
  Event summaries and bounded keyset paging are now available in the private
  reader. Paging is not a snapshot under concurrent writes or later retries;
  decide stable export/snapshot semantics before offering complete exports.
  Provisional cursor/list URL caps are 8/16 KiB and must fit production proxy
  limits. New events now share the reader's 4-KiB/valid-UTF-8 identifier bounds. Historical
  oversized rows remain unchanged and broker records violating the new contract
  follow the acknowledged dead-letter path. Plan a compatible rollout before
  production; aggregate page byte limits remain independent of per-field limits.
  Cursor control-character expansion is fixed with versioned byte encoding.
  Aggregate pages now shrink safely within a 160-KiB attempt budget and one
  overall deadline; this remains a provisional operational limit requiring
  representative workload measurement.

## Licensing decision — November 5

The user selected FSL 1.1 with Apache 2.0 conversion for the platform and MIT
for the browser SDK and required shared contracts. Each published platform
version converts after two years. Describe restricted releases as source-available.
License files and package metadata now apply this split. Notices use repository
author Adrian Eufracio; confirm the preferred copyright holder before public
release. Contributor intake/signoff policy and a complete third-party notice
audit remain pending; no copyright assignment or commercial relicensing rights
from outside contributors should be assumed. See `LICENSING.md`.

## Reversible defaults during autonomous work

- **Resolved November 3 — fixture follow-up:** a controlled bootstrap gate proved
  that the old loopback healthcheck could report readiness on the image's temporary
  initialization server. The hostname-based check rejects bootstrap and accepts
  the final network server. Real filtering verification now passes, including
  cleanup. The original closed-socket run remains failed evidence; its precise
  cause cannot be proven uniquely without the missing historical storage logs.
  New failed storage runs retain ClickHouse logs. No user decision is needed.

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
  by `(projectId, eventId)` using `FINAL`. The query API now preserves that uniqueness; every
  additional analytics read must do the same rather than relying on background
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

- **Identity outbox retention (provisional):** links currently retain a stable
  payload for up to 90 days, bounded by 64 records / 1 MiB per project/endpoint.
  Ordinary events retain the existing queue expiry. Confirm the link retention
  and capacity policy before release; these are reversible defaults rather than
  measured capacity recommendations. Client identity assertions never grant access.
- **Clerk setup progress:** user reports creating a Clerk account. Application,
  invite-only mode, application owner and local environment setup are not yet
  verified. Do not infer successful private login from an admin account.

- **Live dashboard verification:** the server analytics resource now requires the
  owner session plus PostgreSQL membership on every request. Restricted read roles,
  tracked migration/bootstrap tooling, actual owner principal/membership, and live
  Clerk login remain unconfigured/unverified. Never replace these checks with
  fixture access to make the page work. Server connection limits must also be
  validated across Vercel function instances.

- **Public ingestion-key rotation:** hashed key lookup and revocation. 2026-11-11:
  user chose an in-memory key cache invalidated by PostgreSQL LISTEN/NOTIFY
  (migration 003) over a TTL-only cache or Valkey, after per-request lookups caused
  metadata-gate refusals during short app stalls. The cache is used only while
  LISTEN is live; a notified revocation is applied within milliseconds of commit
  (fixture: ~1.5 ms), with a 5-minute TTL backstop. Lost database privileges are
  not key changes: uncached keys fail closed and readiness fails, but cached keys
  keep working until notification or TTL. Batches
  already authorized/publishing are not undone. SDK queues are scoped by public
  key and are never silently reassigned to another key/project. Decide the
  rotation overlap/grace policy before exposing a rotate-key operation so older
  queued events have a deliberate delivery/expiry path.

## November 9 — safeguard comparison follow-up

- User authorized changing one constraint: isolated HTTP cap 32 → 128. The
  two-minute 100-EPS stage passes once; 150 EPS fails with 206 metadata-gate
  refusals, long-tail latency and generator drops. Four connections / 16 queries
  remain unchanged. No user decision is required for paired local repetitions;
  repeat both HTTP caps in the same session before claiming a causal improvement
  or choosing production limits. See `performance/4gb-local-capacity.md`.

- Follow-up fresh paired trials on November 9: cap 32 passes, cap 128 records
  one metadata-gate HTTP 503. Earlier improvement is not reproducible on this
  evidence; no HTTP-cap winner or production setting is established. Next inspect
  timestamped database wait/occupancy and CPU contention before selecting one
  metadata constraint to change. Both stacks cleaned up; no user decision needed
  for read-only investigation.

- Bottleneck visibility follow-up: retained occupancy peaks, bounded timestamped
  refusals, database acquisition/execution timings and event-loop delay are now
  implemented and verified. Instrumented 100-EPS trial passed without reproducing
  a refusal, so the earlier cause remains unresolved. Reproduce with these
  diagnostics before tuning; no new user decision is required for investigation.

- User subsequently authorized eight connections / 16 total queries. Isolated
  `capacity-4gb-db8` 100-EPS/two-minute trial passes with all eight connections
  observed executing concurrently. Both instrumented four/eight runs passed;
  eight remains experimental, with no production default change or proven
  superiority. Next matched longer repeats/higher-load diagnosis; no new user
  decision is required for local verification.

- Five-minute repeated pool comparison completed at 100 EPS (4/8/4/8): metadata
  refusals 0/64/10/3. Neither pool size is consistently zero-refusal; eight is not
  a proven remedy. Accepted events reconcile and cleanup passed. Next investigate
  timing/resource intervals around refusals before selecting another safeguard
  experiment. Production settings remain undecided; no deployment/spending approved.

- User authorized total-query gate 24 at eight connections. Both five-minute
  100-EPS repeats failed, with broader scheduling stalls and both HTTP/database
  gates filling. No evidence to adopt 24; application defaults unchanged. Before
  further limit tuning, investigate scheduling/generator pressure and establish
  stable comparison conditions. Detailed counts/ambiguity are in the capacity
  report; no new user decision or paid infrastructure is assumed.

## November 9 — telemetry access and observed scheduling pressure

- The capacity scrape-discovery gap identified during this investigation is now
  resolved for future runs. Historical missing telemetry remains unavailable.
  The single pending Grafana URL/access dependency is tracked in the Grafana
  capacity telemetry follow-up below; development graphs are not substitutes.
- Interval diagnostic run captured one refusal with assigned CPUs around 91–92%
  busy, CPU pressure and GC activity, without app throttle/memory events. Broader
  CPU/scheduling contention is the lead; historical 6.9-second stall not reproduced.
  Next reversible control suppresses concurrent analytical SQL at unchanged limits.
  See `performance/cpu-stall-investigation.md`; no new paid/remote action authorized.

- Analytical-SQL control completed with unchanged limits and instrumentation:
  14 metadata refusals, all accepted events stored, CPU pressure remains about 13%.
  Concurrent analytical reads are not a sufficient explanation. Next isolate
  generator/host conditions, then profile ingestion CPU/GC if pressure remains.
  No new paid or external action is assumed; see the current Grafana follow-up below.

## November 9 — generator isolation, memory allocation and Lightsail options

- User authorized generator isolation and Lightsail price research. One matched-rate
  five-minute run with generator CPUs separate passes, but needs repeatable controls
  with matched instrumentation before a causal claim. No limits/defaults changed.
- ClickHouse now has measured max-limit/reclaim events under its 1280-MiB cap,
  without OOM. Review redistribution within four GiB before inferring larger host
  RAM is required; any redistribution must preserve service safety and host reserve.
- Official Lightsail has no four-vCPU/four-GB bundle; two/four IPv4 is $24 general
  or $42 compute optimized; smallest four-vCPU compute is eight GB/$84, above the
  recorded $50 VPS budget. No budget increase or provider purchase assumed. Sources
  and CPU-credit limitations in `performance/lightsail-options.md`.

## November 9 — four-GiB allocation follow-up

- User authorized baseline repeat and revised allocation. Original generator-
  isolated repeat fails with 13 metadata refusals, so isolation alone is not a
  reliable fix. Revised ClickHouse/app/PostgreSQL caps 1536/384/128 MiB preserve
  the same four-GiB total, 640-MiB reserve and other settings. Two fresh five-minute
  100-EPS runs pass with 30001 accepted/unique stored each, zero refusals and no
  detected OOM/restart; cleanup passed. More promising local experimental profile,
  not a proven optimum or production host recommendation.
- ClickHouse still hits its cap, but measured memory-pressure duration is lower.
  Longer retained-data/maintenance tests and actual-host qualification remain.
  No application defaults, paid resources, deployment or budget changed. Evidence
  and exact next step: `performance/4gb-memory-rebalance.md`.

## November 9 — Grafana capacity telemetry follow-up

- User authorized implementing the missing telemetry wiring/dashboard. Capacity
  targets now register with Alloy and observed load forwarding increases; local
  endpoint and real dashboard metric-reference checks pass. Prepared dashboard
  is `infra/monitoring/capacity-dashboard.json`. Historical capacity cloud coverage
  remains absent; new runs now advertise their targets.
- Resolved: user supplied `https://dashingjackal3083.grafana.net` and existing
  ingestion dashboard URL. Do not ask for it again. Cloud import/render/query
  verification is now blocked by browser control, not a missing URL: Chrome finds
  the tab but page/screenshot/accessibility/fresh-tab actions fail with a TypeError
  reading `timeoutMs`. Supported recovery alternatives failed; no other browser
  session or Grafana plugin is available. Needed: functioning browser page control
  to resume the prepared import. No credential extraction/scope change assumed;
  no tokens should be sent in chat. See `setup/capacity-monitoring.md`.

## November 9 — endurance qualification failed

- User-authorized 30-minute revised-allocation 100-EPS trial fails. ClickHouse
  aggregation memory rejection precedes sampling stoppage; later traffic hits
  metadata/HTTP gates with severe scheduling stalls. Five-minute passes do not
  establish stable capacity. No higher DB/HTTP limits, paid host or deployment
  assumed. Internal query memory, scheduling contention and harness observation
  failure need separate follow-up; evidence in `performance/4gb-endurance.md`.
- No new user decision is needed for the next local harness reliability fix.
  Production sizing still requires actual-host/retention/maintenance evidence.

## November 9 — query-memory follow-up resolved locally

- User authorized repairing observation and investigating aggregation memory.
  Real forced-memory failure confirms telemetry/attempts continue while result
  stays failed. Short before/after controls find ~14–15 MiB query peaks; earlier
  ~1.33-GiB error is a server-wide total limit, not that query's allocation.
- Server-tracked growth persists with internal text_log disabled. No query semantic
  change, higher application gates, logging default, production change or purchase
  adopted. Exact next diagnostic scope and remaining attribution uncertainty are
  in `performance/4gb-query-memory.md`; no new user choice is needed for local
  category/allocator/background observation. Target-host qualification remains.

## November 10 — sustained memory trace completed

- User-authorized 15-minute diagnostic reproduces analytical total-memory rejection.
  Failed queries use 15–17 MiB; allocator allocations grow ~611 MiB, fragmentation
  ~130 MiB, and a system.query_log merge is captured using ~402 MiB. Its timing
  does not prove it caused the rejections or account for all growth. Complete
  observation survives failures; accepted/stored reconcile, capacity still fails.
- Next local control is reduced routine fixture insert query logging while preserving
  tagged analytical evidence, same limits/budget. No production logging change,
  higher gates, memory increase, paid host or deployment assumed. Source/evidence
  and unresolved attribution: `performance/4gb-memory-trace.md`.

## November 10 — heap attribution changes the next experiment

- User selected allocation profiling before query-log changes. Five profiles and
  inactive-part observations identify retained part metadata as the leading measured
  sustained-growth source. Effective worker writes average ~1.13 events, inactive
  analytics parts reach ~55k, and part-related memory recovers during idle.
- Next comparison is effective bounded batching with acknowledged storage/offset
  safety; no production batching/logging/retention change inferred. Three-minute
  idle is shorter than 480s part lifetime and cannot rule out every persistent
  consumer. Query-log spikes/scheduling remain separate potential contributors.
  Evidence/limits: `performance/4gb-heap-profile.md`.

## November 10 — worker batching remains opt-in

- User authorized implementation/testing. Bounded fetch batching produces ~7.3
  source records/write versus ~1.1, with lower observed part/memory footprint.
  Correctness/recovery checks and short load pass; long 200-ms candidate fails badly
  during broad scheduling stalls and delivers fewer events. Cause unresolved;
  reduced memory is not proof of reliability or stable capacity.
- Final default 0, opt-in 200 through SIGNALTRAIL_PROCESSOR_BATCH_WAIT_MS. No running
  process/default deployment changed. Next local investigation is component CPU/
  fetch/heartbeat timing before promotion; no new budget/provider/gate decision
  assumed. Exact evidence/limitations: `performance/4gb-worker-batching.md`.
