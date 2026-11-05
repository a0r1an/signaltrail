# SignalTrail project status

Last updated: 2026-11-05

Open decisions and working assumptions are tracked in [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md).

## Goal and architecture

Build a complete, reliable product analytics and privacy-conscious session-replay
platform through autonomous implementation and verification.
Next.js dashboard and demo store on Vercel; TypeScript browser SDK; Node.js
ingestion/query APIs; PostgreSQL metadata; ClickHouse analytics; Redpanda event
transport; Valkey caching/rate limits; Amazon S3 replay object storage
(replacing the originally planned MinIO); Docker local stack.
Short isolated load and recovery tests now exercise ingestion and processing.
Sustained capacity, production sizing, and disaster recovery remain unverified.

## Current checkpoint — 2026-11-05

The analytics path now works through the low-level browser SDK, HTTP ingestion,
Redpanda, and a runnable ClickHouse worker. Native-browser persistence, broker
outage recovery, worker crash/restart, downstream deduplication, and dead-letter
commits have local integration evidence. This is not a deployed product or a
verified production availability guarantee.

Autonomous development resumed on November 3. Event-name filtering from
`677482d` now has successful real-storage verification. The ClickHouse bootstrap
healthcheck defect was reproduced and corrected with a controlled initialization
gate. Changes are local; no push, deployment, or remote CI verification has been
performed. Historical sections below preserve evidence from their recorded dates.

### November 5 — owner-only Clerk integration

- Added Clerk Next.js 7.9.25, sign-in/dashboard routes, session-only server
  verification, exact issuer/owner-ID checks, authorized-party origin restriction
  and a no-store session-status API. Guards run at protected resources, not only
  in proxy. Missing configuration fails closed without fixture credentials.
- Dashboard checks pass 47 tests plus lint, route types, TypeScript and optimized
  Next build. A production Next process on an owned ephemeral port verified
  503/no-store on unconfigured protected resources, rejection of forged headers,
  and the unavailable sign-in state. Cleanup completed successfully in
  `test-results/dashboard-auth/2026-11-05T21-10-47.230Z/report.json`. An initial
  report-writer wiring error was corrected before that successful run.
- Added `dashboard auth-smoke`, CI invocation/artifacts, `.env.example`, and
  `docs/setup/clerk.md`. No real credentials were read or changed, no Clerk
  application/account was created, and no valid-password login is claimed.
  Remote CI remains unverified. Real instance configuration/login and membership
  bootstrap remain pending before connecting analytics to the live dashboard.
- Removed the abandoned uncommitted explicit-identity SDK stub/test after the
  user selected automatic anonymous identity and session semantics.
- User decisions recorded in `OPEN_QUESTIONS.md`: org-wide visibility, anonymous
  identity linking/reset/account-switch isolation, shared same-origin/project
  tab state, 30-minute inactivity sessions, stable identity across campaigns,
  URL privacy/UTM allowlist, event-time dashboards, explicit replay opt-in,
  90-day raw analytics retention and 14-day replay retention. Most SDK/storage
  behaviors remain implementation work; documentation is not completion evidence.
- Next: SDK capture URL/campaign sanitization and identity/session implementation
  while real Clerk setup remains pending.

### November 5 — event explorer view

- Implemented the injected React explorer: UTC range/exact filters, precise
  counts, summary table, cursor navigation, refresh, partial failure and
  authorization-denial states. Scope changes remount and clear old results.
- Chromium passed seven scenario groups including safe literal rendering,
  project switching during slow reads, and immediate denial clearing. CSS module
  loading is asserted and the styled screenshot was visually reviewed. Evidence:
  `test-results/event-explorer-browser/2026-11-05T19-14-02.916Z/report.json`.
  Owned browser/server cleanup completed. Initial red was a missing filter;
  setup bundle-path/CSS-mapping issues and effect-replay admission were corrected.
- Dashboard lint, 11 model tests, route types, TypeScript and optimized Next build
  passed. The browser command and artifact upload are added to CI; remote CI is
  unverified. No live route or production session provider is supplied.
- Applied the user-approved licensing split: official FSL 1.1 / Apache 2.0
  future license for the platform, MIT for SDK/contracts. Every workspace has a
  local license and matching package metadata; private flags remain unchanged.
  Offline npm dry-run previews include MIT notices in both SDK and contracts.
  Verified FSL files match the official template after placeholder substitution.
  `docs/LICENSING.md` explains scope, per-version conversion and third-party
  boundaries. Holder confirmation, contributor policy and a full provenance
  audit remain pre-release items. Nothing was published.
- Follow-up native coverage passed all 12 scenario groups, adding session-scope
  replacement during a slow read, empty results, invalid UTC ranges, revoked
  membership and a 390px layout without document overflow. Mobile screenshot
  reviewed; owned resources closed. Evidence:
  `test-results/event-explorer-browser/2026-11-05T19-15-11.224Z/report.json`.
- Mobile table now retains readable columns within a keyboard-focusable horizontal
  scroll region. All 13 Chromium scenarios pass with cleanup in
  `test-results/event-explorer-browser/2026-11-05T19-16-20.427Z/report.json`.
- Next: public SDK ergonomics and production-session integration planning;
  provider/capture-identity semantics remain in the question log.

### November 5 — generated query API types and bounded client

- Added the dashboard explorer state model with 11 test-first behaviors: fixed
  project scope, exact count/page loading, cursor/first-page navigation, stale
  request suppression, immediate denial clearing, partial count failure handling,
  cancellation/reload for React effect replay, and shared-client ownership.
  Dashboard lint, units, route type generation, types, and optimized Next.js build
  passed through the new `check dashboard` runner operation. The model is not
  mounted in a live route; the React view/native fixture remain next.

- Native Chromium verified the built public query client through an owned
  same-origin fixture: HttpOnly session fetch, exact values, reduced-page cursors,
  project/ingestion-key denial before reads, offline recovery, malformed response
  rejection, stalled-body cancellation, and disposal. All seven scenario groups
  passed with owned contexts, Chromium and server closed in
  `test-results/query-client-browser/2026-11-05T17-50-39.932Z/report.json`.
  The fixture supplies no production session provider or real databases; the
  separate combined PostgreSQL/ClickHouse probe covers those data dependencies.
- Added `api browser` to the standard runner/operations skill and the browser CI
  job, retaining reports and failure traces. Remote CI execution remains unverified.

- Added `@signaltrail/analytics/client`, a separate browser-safe query client with
  mandatory session-aware fetch injection, generated request/page types, strict
  runtime response checks, bounded buffering, cancellation/disposal, admission
  retained for unsettled fetches, generic errors and no automatic retries.
  Fifty-four client regressions and all 208 analytics tests/package checks pass;
  DOM-only source/public-declaration compilation also passes. The client entry is
  8.94 KiB unminified with no runtime dependencies; this is not a transfer-size
  budget or native-browser performance measurement. Real HTTP client checks passed against PostgreSQL and ClickHouse with full
  cleanup in `test-results/load/2026-11-05T17-41-32.913Z-authorized-analytics/`,
  including authorization denial, ingestion-key denial, and maximum-field paging.
  Native browser proof is recorded above.

- Added committed OpenAPI-generated query types and an explicit type-only
  `@signaltrail/analytics/api-types` export. Counts/sequences remain strings and
  `hasMore` narrows cursor presence. The standard runner now provides `api generate`
  and `api check`; analytics lint/CI checks drift. A deliberate generated-file edit
  was rejected, then regeneration restored the artifact. The generator is a
  development dependency only; no service/authentication behavior changes.
- Public declaration consumption is checked during builds with DOM libraries and
  Node ambient types disabled. API types produce a zero-byte JavaScript artifact;
  callers must use `import type`, not a runtime import. All 154 analytics tests,
  lint, drift check, typecheck, JavaScript/declaration builds and the public
  declaration consumer passed. Full-repository formatting passed.

### November 3 — startup readiness and filtering verification

- Added test-only response conformance against the OpenAPI reference. Tests cover
  actual handler success/errors, both page variants, exact decimal types, headers,
  and rejection of private extra fields. All 152 analytics tests and package checks
  pass. AJV is an explicit development dependency already cached by the document
  validator; no new runtime dependency was introduced. The real HTTP/storage probe
  passed the same schemas with full owned-resource cleanup in
  `test-results/load/2026-11-04T04-33-48.735Z-authorized-analytics/`.

- Added `docs/api/analytics.openapi.json`, an OpenAPI 3.1.1 reference for current
  read routes, errors, decimal values, filters, cursors, and adaptive pages.
  Validation runs in analytics units with development-only OpenAPI tooling;
  external references are forbidden and external resolution disabled. Its bearer
  scheme describes the fixture binding only, not production authentication.
  All 130 analytics units and package checks pass; the new validator is
  development-only (17 added packages), with no application runtime dependency.

- Large summary pages now reduce their row limit within one overall deadline
  instead of failing solely on combined identifier bytes. The 160-KiB attempt
  cap fits two worst-case valid escaped rows; only byte overflow retries smaller
  complete queries, with at most seven attempts. Malformed results and storage
  errors still fail privately. Real maximum-field HTTP paging passed with full
  cleanup in `test-results/load/2026-11-04T01-15-35.489Z-authorized-analytics/`.
  All 129 analytics tests plus lint, typecheck, and builds pass.

- Cursor byte expansion was reproduced: a valid 4-KiB control-character ID made a
  32,950-character cursor. Version-two wire encoding now encodes identifier bytes
  independently; bounded version-one cursors remain accepted. All 122 analytics
  tests and package checks pass. Real maximum-ID HTTP paging passed with cleanup
  in `test-results/load/2026-11-04T01-12-08.657Z-authorized-analytics/`.

- Event IDs, event names, and session IDs now share the reader's existing 4-KiB
  UTF-8 bound and reject lone surrogates without rewriting values. Contract tests
  reproduced 12 previously accepted invalid cases. Ingestion preserves valid
  batch siblings; the processor dead-letters legacy invalid records before commit.
  This tightens the private pre-release contract and does not migrate stored data.
  Contracts (96), ingestion (64), worker (106), and SDK (252) units plus their
  lint/type/build checks passed; all 13 native Chromium tests also passed.

- Real HTTP overload checks confirm timed-out reads retain capacity until the
  underlying operation settles, then recover. A shutdown regression exposed
  keep-alive responses during draining; they now explicitly close the connection
  instead of waiting for forced termination. All 113 analytics tests and package
  checks pass. The earlier real-storage probe remains valid for unchanged reads.
- Added the Node HTTP query bridge with a configured origin, duplicate-auth/body
  rejection before authorization, connection/header limits, disconnect cancellation,
  and bounded idempotent shutdown including incomplete headers. All 112 analytics
  tests, lint, types, and builds pass; 25 load-harness units pass. Real HTTP denied
  and authorized reads passed against PostgreSQL and ClickHouse with full cleanup
  in `test-results/load/2026-11-04T01-04-54.854Z-authorized-analytics/`.
  The server is an unbound library factory; production identity/session integration,
  TLS termination, process entrypoint, and deployment remain pending.

- Added a bounded node-postgres membership adapter: explicit connection config,
  certificate verification by default, bound parameters, one extended statement,
  read-only session default, connection/query/server deadlines, admission retained
  through cancellation, and idempotent bounded shutdown. Its snapshots expose no
  credentials or query values. The combined probe now uses the real driver rather
  than a psql membership bridge; psql remains fixture migration/seeding only.
- Real driver checks passed with cleanup in
  `test-results/load/2026-11-04T00-48-13.124Z-authorized-analytics/`: pool saturation,
  cancelled acquisition retaining capacity, active cancellation, immutable queued
  values, statement timeout, killed idle/active backends, recovery, throwing pool
  diagnostics, read-only defaults, and shutdown with queued/active work.
- Initial metadata migration application is now transactionally recorded with a
  source checksum and advisory lock. Concurrent/identical replay, checksum mismatch,
  unsupported newer history, rollback after DDL failure, and refusal to adopt an
  untracked schema passed against PostgreSQL. All 22 project-access unit checks,
  lint, types, and builds pass. The combined read/migration probe completed cleanup
  in `test-results/load/2026-11-04T00-23-30.052Z-authorized-analytics/`.
  The helper supports initial version 1 only; deployment credentials/CLI and future
  migration versions remain pending. No existing development database was changed.
- Pagination cursors now bind a versioned fingerprint to canonical project,
  UTC time window, event-name filter, and session filter. Mismatched scope is
  rejected before storage; equivalent timestamps and changed page sizes remain
  valid. Listing snapshots caller inputs before awaiting results. All 99 analytics
  units and package checks pass, and the combined real-storage probe passed with
  cleanup in `test-results/load/2026-11-04T00-17-25.921Z-authorized-analytics/`.
  Cursors remain unsigned positions, not authorization or snapshot tokens.
- The database membership resolver and real ClickHouse reader passed a combined
  authorized-query probe in
  `test-results/load/2026-11-04T00-12-28.561Z-authorized-analytics/`. Projects share
  event/session IDs but return distinct correct totals and pages. Denied/revoked
  requests perform no analytics read. All owned containers and volumes were
  removed. CI uses this probe; production authentication remains pending.
- Added `@signaltrail/project-access` and a transactional initial PostgreSQL
  schema for principals, organizations, projects, and memberships. Verified session
  issuer/subject pairs feed a fixed parameterized membership query; no identity
  provider or default authentication is supplied. UUID project scope is checked,
  cancellation and malformed results fail closed, and grants are not cached.
  The provisional organization-wide read policy is in `OPEN_QUESTIONS.md`.
- Project-access checks passed 16 units, lint, types, and builds. Real PostgreSQL
  isolation, revocation, constraints, and query-boundary integration passed in
  `test-results/load/2026-11-04T00-08-29.413Z-project-access/` with cleanup.
  An earlier run deliberately failed the missing role constraint. At that initial checkpoint,
  the fixture used a test identity resolver and psql bridge. The driver and migration
  checks above supersede that limitation; production session verification and an
  application route remain pending.
- Added exact session-ID filters to count and paged-summary reads and both
  authorized query routes. They compose with event-name filters and preserve
  tenant scope, latest-version selection, and existing resource/cancellation
  bounds. All 87 analytics units, lint, types, and builds pass. The expanded
  real-storage probe passed with final cleanup in
  `test-results/load/2026-11-04T00-02-32.854Z-analytics-read/` (November 3 local
  time), including changed-session duplicates, literal/newline IDs, combined
  paging, another project with the same session ID, and authorized empty results.
- The installed ClickHouse image starts a temporary loopback-only server during
  initialization. The prior loopback healthcheck could succeed before the final
  network listener existed. A controlled init gate reproduced that exact false
  readiness assertion, then passed after checking the container hostname instead.
- The successful gated probe and real analytics probe both completed cleanup:
  `test-results/load/2026-11-03T17-52-32.216Z-storage-readiness/` and
  `test-results/load/2026-11-03T17-53-15.921Z-analytics-read/`.
  Filters, latest-version replacement, paging, and authorized listing passed.
  The October 31 failed run remains failed evidence; it lacked server logs, so
  its specific socket closure cannot be attributed uniquely after the fact.
- Added the readiness probe to CI, standardized installed-image/startup-log
  diagnostics, and retained ClickHouse failure logs before isolated teardown.
  Development services were not restarted and their volumes were not removed.
- Harness checks: 25 tests passed. Both Compose configurations validated quietly.
  Package builds succeeded during the probes. Latest 99-unit analytics and 22-unit
  membership checks supersede the earlier reader-only unit checkpoint.

### October 31 — sustained measurement and producer improvement

- Added fixed sustained profiles and a short CI smoke profile using the runnable
  worker. The harness samples exact source lag, worker CPU/memory and latency,
  and isolated-container resources. It reconciles k6 outcomes with broker offsets,
  unique `FINAL` rows, and dead letters after traffic stops, then verifies cleanup.
- Baseline at nominal 200 events/s for 60 seconds passed: 12,020 accepted events,
  12,020 unique rows, no retries or drops, and zero remaining lag/dead letters.
- The initial 1,000-events/s profile failed its offered-load target: 43 retries
  and 38 generator drops. All 59,197 accepted events still reached unique rows.
  Publisher admission reached its 1,000-event cap while worker lag stayed small.
- Coalesced same-turn admitted publications into producer requests bounded by
  100 records and an approximate 256 KiB grouping budget. Each event remains a
  separate broker record with its trusted tenant/session key and original ID.
  No linger timer or larger admission/concurrency limit was introduced. A larger
  individual admitted record travels alone. Tests preserve acknowledgement,
  cancellation reservations, shutdown drain, and tenant metadata.
- The same 1,000-events/s profile passed after coalescing: 60,020 accepted events
  became 60,020 unique rows, with no retries, drops, remaining lag, or dead letters.
  Peak admitted work fell to 80; observed HTTP p95 fell from about 914 ms to 8.21 ms.
  This is one local comparison, not production sizing or a maximum capacity claim.
- Added standard worker process metrics and separate ClickHouse acknowledgement
  latency, keeping diagnostics unable to alter delivery. Real broker interruption
  and exhausted-retry recovery passed after producer coalescing.
- A 60-second, 200-events/s storage-outage profile passed: ClickHouse was paused
  for ten seconds while all 12,000 events remained accepted. Source backlog
  peaked at 1,980, the worker recorded a real failed write/retry, and all events
  reached unique rows with zero final lag or dead letters after resume.
- The initial load generator tied sessions to active VUs, confounding partition
  mix across latency changes. Sustained profiles now use a fixed 100-session
  pool, independent of VU scheduling. Its fresh 1,000-events/s run passed with
  60,020 unique rows, zero retries/drops, and traffic across all three partitions.
- The fixed-session larger-payload profile passed: 12,000 accepted/unique events,
  each preserving its 8,000-byte padding value, with zero retries/drops/dead
  letters/final lag. Repeated padding is a byte-integrity probe, not a realistic
  compression or production sizing workload.
- Added a separate 128-slot request-processing admission gate before body parsing,
  configurable with `SIGNALTRAIL_MAX_CONCURRENT_REQUESTS`. Health/preflight remain
  available, refusals expose a browser-readable one-second `Retry-After`, and
  request active/refusal metrics distinguish this pressure from broker admission.
  Unit checks cover release/error paths and isolated diagnostics. A real slow
  upload with a one-slot fixture verified that the SDK retains its event on 503
  and retries the same ID after release. This does not bound all TCP connections.
- Detailed measurements, artifact paths, report limitations, and unchanged limits
  are in [the performance report](performance/2026-10-31-analytics-pipeline.md).
  The initial baseline's raw k6 summary was overwritten by a filename collision;
  later runs preserve generator and pipeline reports separately.

### Completed since the October 22 checkpoint

- **Bounded event explorer reads:** the reader now lists event ID/name, session,
  receive time, and exact sequence summaries in stable newest-first order.
  Defaults are 50 rows, at most 100, with a 64 KiB response cap and an extra-row
  `hasMore` indicator. Both count and list use shared deadline/cancellation,
  validation, and `FINAL` execution. Optional list routing shares membership
  authorization and admission; raw event payloads are excluded. First-page reads
  passed the real ClickHouse probe, including ties, cross-project isolation,
  replacement before time filtering, empty results, and cleanup. Bounded keyset
  cursors now continue across timestamp ties without growing offsets. Final pages
  omit the cursor; malformed/out-of-window cursors fail before storage. Paging
  under concurrent writes is not a snapshot or a complete export guarantee.
  Optional exact event-name filters now apply to both counts and lists using
  parameter-bound UTF-8 bytes and the same canonical authorized project scope.
- **Server-side analytics read foundation:** `@signaltrail/analytics` counts unique
  events using a fixed parameterized `FINAL` query scoped to a trusted project ID.
  Required UTC receive-time windows are half-open and capped at 31 days. Client
  deadlines, query memory/thread settings, and response-size limits bound reads;
  counts remain decimal strings to preserve UInt64 precision. The isolated real
  ClickHouse probe verifies project separation, exact project-ID bytes, boundary
  timestamps, and replacement selection before time filtering. This is a private
  library, not a public query endpoint; membership authorization and production
  read credentials remain pending. See [the package guide](../packages/analytics/README.md).
- **Query authorization boundary:** a portable Request/Response handler requires
  an injected dashboard-session/project-membership resolver. It reads only the
  canonical authorized project, denies before storage, disables shared caching,
  rejects ambiguous parameters, and bounds admission and response waits. No
  resolver, application route, listener, or production identity provider is
  installed. The real-storage probe also exercises fixture-authorized and denied
  requests. Hanging dependencies retain their admission slot until settlement.
  Query deadlines and caller disconnects propagate to the reader's fetch/body
  operation; pre-cancelled reads never start storage work. The independent reader
  deadline remains in place even if a custom fetch ignores cancellation.
- **Ingestion admission and recovery:** publisher work is bounded by outstanding
  event count and serialized bytes, including sends still pending after an HTTP
  deadline. Defaults are 1,000 events and 8 MiB, pending workload measurements.
  Saturation returns retry outcomes. Acceptance still requires Redpanda's
  acknowledgement; ingestion does not consult ClickHouse or deduplicate events.
  Isolated broker interruption tests verify stable SDK IDs, retained events,
  late acknowledgements, exhausted publication retries, and recovery.
- **SDK health and monitoring:** opt-in sampled health reports, ingestion and
  broker metrics, Grafana Alloy configuration, and a service-health dashboard
  exist. Grafana Cloud ingestion/broker scrape visibility was demonstrated in
  the October 23 session. Worker metrics are optional and loopback-only; live
  Alloy scraping of the worker and alert delivery are not configured.
- **Runnable analytics worker:** shared validated broker records carry trusted
  project identity. The worker validates each record, sends malformed data to a
  dead-letter topic, writes valid events to ClickHouse, then commits source
  offsets only after the required acknowledgements. It keeps heartbeats alive,
  retries with bounded backoff, has startup/shutdown deadlines, and stops further
  sink writes for shutdown or stale partition batches. Storage failures retain
  work for replay rather than silently dropping schema-valid events.
- **Bounded storage batches:** partition chunks contain at most 100 records or
  1 MiB of source payload; serialized ClickHouse inserts have a 4 MiB cap.
  A single oversized source record uses the bounded dead-letter path. Real
  integration tests stored 205 events in inserts of 100, 100, and 5. A gzip
  record batch expanded into 20 events and was split into chunks of 16 and 4,
  each below 1 MiB. Limits are provisional, not production capacity claims.
- **Downstream uniqueness:** the initial ClickHouse migration uses
  `ReplacingMergeTree(received_at)` ordered by `(project_id, event_id)`.
  Tests use `FINAL` for unique reads across retries and isolated projects.
  They verify recovery after both a pre-storage crash and a stored insert whose
  acknowledgement never reached the worker. Background merges alone do not
  guarantee unique reads. The query handler is library-only; no application
  endpoint or production membership resolver is installed.
- **Native browser recovery:** a real Chromium SDK page queues offline in
  IndexedDB, closes, reopens during a broker outage, retains the original ID on
  retry, and drains into one logical ClickHouse row after recovery. This covers
  one browser context, not browser-process restart, eviction, or host loss.
- **SDK performance and storage lifecycle:** atomic bulk IndexedDB reads reduce
  queue scan overhead; initialization has a five-second bound, blocked opens
  fall back to memory, and connections cooperate with future database upgrades.
  Queue defaults remain unchanged. Standalone bundle measurements and native
  queue benchmarks have standard runner commands and CI artifact steps.
  Tree-shakable Zod imports reduced the recorded pinned-bundler gzip measurement
  from about 101 kB to 37 kB. Local queue measurements and limitations are in
  [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md); neither establishes a public SDK budget.
- **Operations and CI:** `scripts/signaltrail-ops.mjs` and the repository-local
  `signaltrail-operations` skill standardize checks, browser/broker tests,
  isolated load scenarios, and monitoring operations. Load runs lock their
  isolated infrastructure, bound cleanup, and record success only after teardown.
  CI is configured for browser tests, measurements, real-broker integration,
  saturation, SDK recovery, and the browser-to-storage pipeline. Configuration
  is committed; successful remote execution of these latest changes is unverified.

### Remaining product and production work

- Public SDK `init`/`track`/`identify`, visitor/session identity lifecycle, and
  runtime validation/error reporting for JavaScript capture callers. Existing
  low-level delivery APIs accept complete events; do not present them as a
  finished drop-in analytics SDK.
- Production project-key resolution, metadata persistence and authorization;
  ingestion currently uses the development resolver and refuses production mode.
- Analytics query APIs and dashboard data integration with consistent unique
  reads; ClickHouse retention and conflict/query-cost decisions.
- Session replay capture, replay worker/object integration, and playback. S3 and
  restricted human development access are established; that is not an implemented
  replay pipeline or unattended worker identity.
- Off-server analytics archives, archive-lag ingestion gating, database backups,
  replacement-host restoration, and measured four-hour RTO/best-effort one-hour
  RPO. These remain planned, not demonstrated by local process recovery tests.
- VPS selection, production credentials and supervision, sustained/endurance load
  tests, consumer-lag visibility, alert routing, and production capacity sizing.
  See [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) before making unresolved decisions.

## Latest observed verification evidence

Counts below are the latest observed results from separate package runs, not a
claim that the entire workspace or remote CI ran at final HEAD.

| Suite                                          | Latest observed passing count | Evidence scope                                                            |
| ---------------------------------------------- | ----------------------------: | ------------------------------------------------------------------------- |
| Contracts                                      |                            96 | November 3 identifier byte and Unicode validation checks                  |
| Ingestion                                      |                            64 | November 3 valid-sibling identifier rejection checks                      |
| Browser SDK unit tests                         |                           252 | Includes IndexedDB lifecycle/fallback work                                |
| Chromium browser tests                         |                            13 | Includes native database upgrade cooperation                              |
| Event processor unit tests                     |                           106 | November 3 legacy identifier dead-letter checks                           |
| Analytics reader and query boundary unit tests |                           208 | Includes query-bound cursors, input snapshots, filters, and authorization |
| Native query-client browser probe              |             7 scenario groups | November 5 owned same-origin fixture, Chromium 156; cleanup confirmed     |
| Dashboard explorer model                       |                            11 | November 5 lint, route types, TypeScript and production build passed      |
| Project access unit tests                      |                            42 | Membership, migration input, and database admission/config checks         |
| Load harness unit tests                        |                            25 | Includes measurements, reports, and safe storage interruption             |

- October 31 ingestion checks passed all 63 units, lint, types, and builds after
  HTTP admission. The 13-test Chromium suite also passed after those changes.
  The real request-admission probe passed at
  `test-results/load/2026-10-31T15-57-34.911Z-request-admission/`.
- Analytics lint, 99 units, types, and JavaScript/declaration builds passed.
  The real-storage read probe passed with final cleanup in
  `test-results/load/2026-10-31T16-11-11.187Z-analytics-read/`.
  The expanded fixture-authorization probe also passed and cleaned up in
  `test-results/load/2026-10-31T16-19-27.614Z-analytics-read/`.
  The final probe passed again at clean application commit `1c15314` in
  `test-results/load/2026-10-31T16-23-05.164Z-analytics-read/`, including final
  container/volume cleanup. Full-repository Prettier checking also passed.
  Bounded list ordering and filtering passed the expanded real-storage probe in
  `test-results/load/2026-10-31T18-57-29.203Z-analytics-read/` with final cleanup.
  Multi-page keyset traversal across ties passed with final cleanup in
  `test-results/load/2026-10-31T19-01-31.767Z-analytics-read/`.
  The later event-name filter probe failed in
  `test-results/load/2026-10-31T19-05-10.998Z-analytics-read/`: the initial fixture
  ClickHouse request failed with `UND_ERR_SOCKET` / `other side closed` after
  Compose reported healthy. It did not establish filter correctness against
  real storage. Containers and temporary volumes were removed successfully.
  The cause is unresolved; a startup/readiness race is a hypothesis, not a finding.
  No retries or readiness changes were added before stopping at the user's request.
  CI now includes this probe; remote execution remains unverified.
- The final processor checks passed lint, tests, typecheck, and JavaScript/type
  declaration builds. Formatting and `git diff --check` passed for changed files.
- Native full-pipeline recovery passed in
  `test-results/load/2026-10-31T02-53-21.091Z-browser-pipeline/`.
- The latest isolated pipeline passed in
  `test-results/load/2026-10-31T03-01-11.073Z-pipeline/`, including count/byte
  chunking, real HTTP worker metrics, and both crash/replay windows. Its result
  was finalized after isolated containers and volumes were removed.
- The October 31 full native-browser pipeline passed after the stale-batch guard,
  resource/latency instrumentation, and producer coalescing:
  `test-results/load/2026-10-31T15-35-08.189Z-browser-pipeline/`.
  This includes offline IndexedDB retention, broker retry, both worker crash
  windows, dedupe, compressed/count chunking, and final resource cleanup.
- The October 30 UTC artifact names above fall on October 30 in the project's
  local timezone. Local artifacts are ignored by Git; committed probe assertions
  are the durable regression coverage. October 31 load evidence and limitations
  are recorded in the linked performance report.
- Short local load tests and benchmarks do not establish production throughput,
  VPS sizing, browser eviction resilience, or host/disk disaster recovery.
- Strict TypeScript settings remain enabled. Branch protection and remote CI for
  the latest commits remain unverified. No production deployment was performed.

## Exact next step

On a request to continue, resume autonomously under `AGENTS.md`; daily scope
approval and teaching checkpoints are no longer required. Record unanswered
decisions in `OPEN_QUESTIONS.md` and continue independent work. Do not
repeat publisher admission, SDK delivery setup, broker-outage recovery, initial
ClickHouse consumption, batch inserts, or the existing recovery probes.

The full native browser/crash-recovery pipeline passed after producer coalescing.
The server-side project-scoped analytics reader and injected membership boundary
passed unit verification; real ClickHouse checks cover the reader and fixture
authorization. Query cancellation now reaches the underlying storage read.
Startup readiness and exact-name filtering are now verified; do not repeat
that investigation as unfinished work. Exact session-ID filtering and the PostgreSQL membership foundation are complete.
The combined authorized-query probe and query-bound cursors are verified.
Initial metadata migration replay and change detection are also verified.
The bounded PostgreSQL adapter and Node HTTP bridge are now verified, including
real wire authorization/storage reads, disconnects, bounded shutdown, and overload
recovery. Identifier validation now matches existing read-side UTF-8/4-KiB bounds. Next,
build the accessible event-explorer React view and native browser fixture around
the verified state model, with required selected-project/session scope and injected
client inputs. Keep production route mounting dependent on session integration. The bounded client, generated types, real HTTP/storage probe and native
Chromium proof are implemented; do not repeat their setup as unfinished work.
Do not silently attach ingestion keys. Generated types, drift
checks and response conformance are implemented; reuse the recorded real storage
evidence for unchanged read behavior. The production identity provider/transport remains a user decision. Large-page reduction and cursor byte
encoding are locally verified; do not repeat them as unfinished work. Session verification remains injectable;
production identity-provider/credentials and public deployment remain pending.
Continue the explorer/product work after
that slice. Integrate a
session/membership resolver and dashboard route once the
identity-provider decision is settled. No production authentication is implied by
fixture tests; public ingestion keys must never authorize reads. Longer endurance
and connection/proxy admission can follow the established performance harness. Fixed-session higher-rate,
larger-payload, and short storage-outage measurements already pass. A short sustained ClickHouse outage is already
verified; do not repeat it as if no failure-under-load coverage exists. The basic sustained measurement
harness and one measured producer improvement are complete. Keep this isolated
from the user's development services and distinguish overload/recovery correctness
from throughput and production sizing. Compressed fetches are decoded by KafkaJS
before chunking; the application byte cap is not a whole-process memory bound.

Then progress toward the next product slice: public SDK capture/identity semantics
or analytics query/dashboard integration. Record unresolved decisions and use
reversible defaults where appropriate; defer work that requires an irreversible
commitment until it is authorized. Production authentication, off-server archives and lag
rejection, backups/restore drills, and replay remain separate required milestones.
S3 is selected; do not restart the provider comparison. Inspect remote CI only
after an authorized push. No Senior workspace documentation was edited.

## Historical session record

The dated notes below retain the evidence and coaching context from each session.

## Previously documented completed setup

- Git repository and pnpm/Turbo monorepo initialized.
- `@signaltrail/dashboard` and `@signaltrail/demo-store` created.
- Shared `@signaltrail/typescript-config` added; Node.js 24 selected.
- Dependency build permissions configured.
- Compilable `@signaltrail/contracts` scaffolded.
- Zod, Vitest, tsup, and TypeScript tooling added.

Important commits: `98b7111` monorepo; `b22d1c1` frontends; `c2c9522` build
permissions; `7fc9fc7` TypeScript configuration; `cbcdb88` Node 24/contracts.

## Completed Day 1 — 2026-10-01

The valid-event acceptance milestone is complete, with additional rejection
coverage. Saved source and the final shared-fixture refactor were reviewed.

- Added `packages/contracts/src/analytics-event.ts`, exposing
  `AnalyticsEventSchema.safeParse(input)` through a Zod object schema.
- Corrected the test's self-import and replaced `isValidSync` with `safeParse`.
  Setup failures were distinguished from the intended assertion failure.
- Established valid-event rejection with `z.never()`, then implemented acceptance.
- Added tests for missing, empty, whitespace-only, and numeric `eventId`;
  unsupported schema version; negative and fractional sequence; accepted zero
  sequence; invalid URL; and invalid client timestamp.
- Learner reported red → green cycles for acceptance, empty/whitespace-only ID,
  negative/fractional sequence, invalid URL, and invalid timestamp. Other tests
  covered rules already implemented.
- Refactored all eleven tests to use one `validEvent` fixture, with object-spread
  overrides or destructuring for the missing-field case. No test mutates it.
- Configured `allowImportingTsExtensions: true` alongside `noEmit: true` so the
  test can import `./analytics-event.ts` directly.

The saved fixture uses `eventName: 'pageview'`, `properties: { productId: '123' }`,
`url: 'https://www.example.com'`, and `context: { sdkVersion: '1.0.0' }`.
The full fixture is in `packages/contracts/src/analytics-event.test.ts`.

## Completed Day 2 — 2026-10-05

Day 2's core SignalTrail package-readiness and engineering-check work is complete.

- Exported `AnalyticsEventSchema` through `packages/contracts/src/index.ts`,
  preserving `CONTRACT_VERSION`. Generated JavaScript and declarations were
  inspected and both expose the schema and version.
- Added `packages/contracts/eslint.config.mjs` and a contracts lint script using
  recommended JavaScript/TypeScript rules and `--max-warnings 0`.
  `ignoreRestSiblings: true` permits intentional field omission in the test fixture.
- Added root development dependencies for ESLint 10, `@eslint/js` 10, and
  `typescript-eslint` 8. Frontends retain ESLint 9; its unsupported-version warning
  remains a dependency-maintenance follow-up.
- Applied existing Prettier formatting to eight files, then formatted the new
  lint configuration and CI workflow. Reviewed changes preserve behavior.
- Added `.github/workflows/ci.yml`: push/PR checks on Ubuntu, Node 24,
  pnpm 10.27.0, frozen-lockfile installation, formatting, lint, tests, typecheck,
  and build. No deployment or infrastructure checks are configured.
- Connected `origin` to `git@github.com:a0r1an/signaltrail.git` and pushed `main`.
  Commits inspected: `cf4cd40` initial event/tests; `4a9462f` schema export/CI;
  `e81ceca` status update/document formatting.
- First GitHub run failed on the committed status document's formatting. Local
  checks had used its newer unstaged version. Committing the formatted document
  resolved the failure; the learner reported the subsequent CI run successful.

## Day 3 progress — 2026-10-06

Stopped for today at the learner's request. Four local services have been checked;
object storage is deferred, so Day 3 infrastructure is partially complete.
Root `compose.yaml` was inspected. Commands were supplied through coaching and
run by the learner; the coach did not run services or edit the Compose file.

- Docker CLI/engine 27.3.1 and Compose v2.30.3-desktop.1 were reported reachable.
  Compose configuration validation returned without errors at each step.
- PostgreSQL: `postgres:18`, actual query-reported version 18.6; healthy and
  authenticated TCP query inside container passed. Probe row `1` survived
  `docker compose down` and `up` (lifecycle confirmed by learner). Uses
  `postgres_data:/var/lib/postgresql`. Host port 5432 was occupied, so the local
  mapping is `127.0.0.1:5433:5432`.
- Redpanda: `v26.2.3`, one development broker, one core, 1 GB configured memory;
  healthy. Topic `infrastructure-probe` has one partition and one replica.
  Produced and consumed `signaltrail-probe-1` at partition 0, offset 0; message
  survived stop/remove/recreate (lifecycle confirmed). Uses `redpanda_data`;
  containers connect to `redpanda:9092`, host clients to `localhost:19092`.
- ClickHouse: `26.8` LTS series, actual client-reported version 26.8.19.9; healthy.
  MergeTree probe row written/read, then full stop/remove/recreate output and
  subsequent read of `1` supplied. Uses `clickhouse_data`, host ports 8123/9000.
- Valkey: `9.1.2`, healthy on host port 6379. SET/GET and TTL 60 supplied;
  expiration confirmed by EXISTS 0 and TTL -2. A non-expiring probe was absent
  after restart (lifecycle confirmed). Persistence is disabled; 128 MB data-memory
  limit and `noeviction` policy. No named volume. Rate-limit reset policy remains
  unresolved; a memory limit does not provide durability.
- Initial Redpanda topic creation had no visible result and topic list was empty.
  Retry with `docker compose exec -T` returned OK/exit status 0. Subsequent
  noninteractive client commands use `-T`.
- Initial ClickHouse inline multiquery insert failed with code 48 concerning
  async inserts and stdin. Retry with `--async_insert=0` and `</dev/null` passed.
- Probe tables/topic remain. Host application connections are untested.
  Single-node volumes protect against container replacement, not disk/host loss;
  replication and backup/restore remain unverified.
- MinIO was not installed: its community repository is archived
  (https://github.com/minio/minio). Discussed SeaweedFS, Garage, R2, B2, Spaces,
  and Amazon S3; no replacement or local/production pairing was selected.
  The original plan had no dollar budget for MinIO, only shared-VPS hosting.

## Storage and recovery session — 2026-10-08

This session was limited to SignalTrail work. Infrastructure decisions and AWS
setup were guided; the learner performed console actions and CLI commands.
No application code or Compose configuration was changed and no VPS was provisioned.

### Hosting and recovery decisions

- Start with one self-managed VPS for APIs, workers, PostgreSQL, Redpanda,
  ClickHouse, and Valkey. Provider, machine size, disks, and total cost remain
  undecided. Earlier three-machine prices were illustrations, not sizing advice.
- Use managed Amazon S3 for replay and off-server recovery archives. The learner
  selected S3 over R2; no local object-storage replacement service was installed.
  Separate private replay and recovery buckets are proposed; only the development
  replay bucket exists so far.
- Initial recovery time objective (RTO): restore service within four hours of
  VPS failure. Initial recovery point objective (RPO): best-effort maximum one
  hour of lost acknowledged analytics. Neither target has been implemented or
  verified. This replaces the earlier zero-loss requirement for the initial
  deployment. Datacenter resilience remains a future goal, not an initial guarantee.
- A single VPS can be recoverable but cannot remain available during host loss.
  Vercel may serve the dashboard shell while its backend dependencies are down.
- Proposed archive worker: consume accepted Redpanda events, upload compressed
  batches to S3, then commit consumer offsets. Preserve event IDs for deduplication
  during recovery. Object naming, manifests, retention, and safe replay are unresolved.
- Learner approved rejecting ingestion when off-server archiving falls behind.
  Proposed thresholds: archive within five minutes, alert at 15 minutes, reject
  at 30 minutes or when archive status is unknown. Thresholds and recovery from
  rejection remain unimplemented and untested.
- Rejection does not protect an existing unarchived backlog. A prolonged archive
  failure followed by VPS loss can exceed the RPO; learner accepted this limitation
  for the initial best-effort target. A strict zero-loss guarantee would require
  an off-server durable copy before acknowledgment.
- PostgreSQL backup design, ClickHouse backup/rebuild strategy, preservation of
  unprocessed Redpanda events, backup-tool compatibility, secret recovery, alerts,
  and a timed replacement-host restore are pending. Replay storage alone does
  not protect the database metadata required to locate and authorize replay.

### AWS setup and supplied evidence

- Learner reported AWS account creation, root MFA, and a zero-spend budget
  notification configured. The budget is an alert, not a spending cap.
- IAM Identity Center organization instance enabled in `us-west-2`, single Region;
  personal user created, invitation accepted, AdministratorAccess assigned,
  portal sign-in verified, and Identity Center MFA reported enabled.
- Development S3 region selected: US West (Oregon), `us-west-2`. Production
  placement should be revisited alongside VPS location.
- Bucket created: `signaltrail-replay-dev-eufracio-25812850`. Guided settings:
  general purpose, ACLs disabled/bucket owner enforced, all public access blocked,
  SSE-S3 encryption, versioning disabled, Object Lock disabled. Configuration
  was learner-reported, not independently queried.
- Learner reported the unsigned Object URL returned AccessDenied. Console
  upload/download was initially reported successful, but later CLI listing showed
  a zero-byte probe; that initial check did not establish content preservation.
- AWS CLI initially reported 2.22.20; learner reported updating to the latest
  version, but did not supply the final version string. Configured SSO session
  `signaltrail` and profile `signaltrail-admin`, default region `us-west-2`, JSON
  output. Configuration/credentials are outside the repository.
- Supplied `sts get-caller-identity` output confirms an assumed Identity Center
  AdministratorAccess role for user `eufracio` in the expected account.
- Supplied CLI listing confirms bucket access. Corrected probe upload succeeded;
  subsequent listing showed 28 bytes. Learner supplied
  `PASS: downloaded bytes match` after downloading to a different file and using
  `cmp`. Nonempty authenticated upload/download is verified from supplied output.
- These checks used administrator permissions. No restricted development identity,
  worker credentials, SDK integration, recovery bucket, or restore test exists yet.
- At session start the working tree was clean; previously unexpected `rpk` and
  `--partitions` files were absent. At close, `storage-probe.txt` is untracked;
  do not stage it unintentionally. No service readiness/resource output, application
  checks, or new CI evidence was supplied today.

## Restricted S3 access and batch contract — 2026-10-12

Core session work completed through guided coaching. The learner wrote all
application code and ran checks; the coach inspected saved source and generated
exports. This session stayed within SignalTrail work.

### Restricted development access

- Created custom Identity Center permission set `SignalTrailReplayDev`, assigned
  to the existing user in the same AWS account. One-hour session duration and
  Project/Environment tags were guided; setup completion learner-reported.
- Inline policy allows `s3:ListBucket` on
  `signaltrail-replay-dev-eufracio-25812850` and `s3:GetObject`/`s3:PutObject`
  on its objects. PutObject can overwrite objects. No delete or bucket-management
  permissions were granted by this policy.
- Configured CLI profile `signaltrail-replay-dev` using the existing `signaltrail`
  SSO session. Supplied STS output confirms the SignalTrailReplayDev assumed role.
  Admin and restricted role sessions do not combine permissions.
- Supplied restricted-profile output verifies listing, upload of
  `restricted-role-probe.txt`, download, and byte-for-byte comparison PASS.
- Read-only GetBucketPolicy returned AccessDenied explicitly because no
  identity-based policy allows `s3:GetBucketPolicy`. This verifies that denial,
  not every possible unauthorized operation. Worker credentials remain undecided;
  this human SSO role is for development, not unattended production execution.

### Local infrastructure wrap-up

- Supplied `docker compose ps` shows all four SignalTrail services healthy,
  with five days of uptime. No completed functional/restart probes were repeated.
- Supplied one `docker stats --no-stream` snapshot: ClickHouse 1.15 GiB/8.56% CPU,
  Redpanda 279.9 MiB/0.54%, PostgreSQL 24.48 MiB/0%, Valkey 13.27 MiB/0.77%.
  Combined SignalTrail memory approximately 1.46 GiB. Separate `pg_docker`
  container also running, using 51.03 MiB.
- The 7.653 GiB displayed limit is Docker-available memory, not individual
  container caps. ClickHouse's 45.4 GB block writes are cumulative I/O, not disk
  occupancy. Snapshot without application load does not establish VPS sizing.
- Supplied Prettier check confirms Compose formatting; `docker compose config
--quiet` returned without error. Configuration was not changed today. Host
  application connections, actual disk use, backups, and load/failure tests remain
  unverified. No VPS has been provisioned.

### Contract implementation and decisions

- Added `packages/contracts/src/analytics-batch.ts` with
  `AnalyticsBatchSchema`: `{ events: z.array(z.unknown()).min(1).max(100) }`.
  Count limit is provisional, not a measured capacity or HTTP byte limit.
- Learner chose partial event acceptance: one malformed event must not discard
  valid siblings. Structural validation permits unknown entries; exported
  `validateAnalyticsEvents` independently safe-parses each entry and preserves
  its original index and Zod result. Indices work even when eventId is invalid.
- Callers must check batch structure/count first. The helper alone accepts any
  array length and does not enforce the batch bounds. No publishing or HTTP
  response implementation exists yet; validation success is not acknowledgment.
- Learner selected request-level project authentication. Proposed API header:
  `Authorization: Bearer <public-project-key>`. Key permits ingestion only;
  server resolves and adds trusted project ID. Authentication is not implemented.
- Removed required `projectKey` from AnalyticsEventSchema. Tests verify keyless
  events pass and supplied projectKey is stripped from parsed output. Future
  publication must use parsed data, not the original unvalidated object.
  Shared fixture still contains projectKey for omission/stripping coverage.
- Schema version and CONTRACT_VERSION remain 1. Package has no demonstrated
  deployed consumers; future compatibility policy remains a follow-up.
- Exported batch schema/helper through `src/index.ts`. Supplied tsup builds
  succeeded for JavaScript and declarations; generated exports and absence of
  projectKey in declarations were inspected.
- Learner reported 22 tests passing. Supplied intended assertion failures for
  batch acceptance, empty-batch rejection, over-limit rejection, independent
  validation, and keyless-event acceptance establish guided red-to-green cycles.
  Remaining boundary/structure/stripping tests covered implemented behavior.
- Learner reported final formatting, lint, and typecheck passed; earlier successful
  typecheck output and final build output supplied. Final saved source reviewed,
  including moving the non-array test to the batch schema describe block.
  No full-workspace checks or new remote CI run verified today.
- SDK batch timers and buffering were discussed, not implemented. Five seconds
  is a provisional flush interval, with earlier count/byte/lifecycle flushes;
  one in-flight request was proposed, not finalized. Replay is a separate chunk
  stream. SDK defaults, response-loss retries, partial-result response design,
  bounded queues, and JSON-only properties remain future work.
- At recording, batch source is untracked and three existing contract files are
  modified. `storage-probe.txt` is no longer listed by git status; its disposition
  was not investigated. No commit or push performed by the coach.

## JSON validation and SDK delivery discussion — 2026-10-13

Application changes were learner-written and learner-run through guided TDD.
Coach reviewed saved source and generated declarations; no application checks
were run by the coach.

- Properties now use `z.record(z.string(), z.json())`. Direct undefined rejection
  first used a refinement; nested undefined exposed its shallow scope, leading
  to the recursive JSON validator. Learner used Zod's `error` option instead of
  deprecated `message` on the temporary refinement.
- Tests cover direct/nested/array undefined rejection, explicit null acceptance,
  nested JSON primitives/objects/arrays, Infinity and bigint rejection, and
  preservation of a valid sibling during independent event validation.
- JSON validation is not a byte-size/depth bound or cycle guard. Browser-side
  validation before serialization remains important: undefined object fields
  disappear, undefined array entries/Infinity become null, and bigint throws.
  Ingestion must independently validate the received JSON.
- eventName, distinctId, sessionId, and context.sdkVersion now each use
  `z.string().min(1).regex(/\S/)`, matching eventId's nonblank policy. Values are
  preserved, not trimmed; SDK version format is not enforced.
- Added empty and whitespace-only rejection cases for each field. Review found
  the empty sdkVersion test duplicated whitespace; learner corrected it and
  reported 38 passing tests afterward (initial count of 28 corrected to 38).
- Learner reported 38 tests passing; supplied output confirms formatting, lint,
  typecheck, and JavaScript/declaration builds passed. Generated properties type
  `ZodJSONSchema` inspected. No new full-workspace checks or remote CI verified.
- Proposed browser SDK responsibility: generate/manage session IDs; future
  identify(userId) links an anonymous visitor to customer-supplied identity.
  Identity lifecycle, multi-tab behavior, and server-event contracts remain
  undecided. Client identity claims must not authorize dashboard access.
- Discussed a three-outcome per-event response (accepted/rejected/retry), optional
  retry delay, request-level errors, and response-loss handling. HTTP 200 for a
  processed mixed batch was proposed, not finalized. Acceptance requires Redpanda
  acknowledgment; authentication and publication remain unimplemented.
- Learner explicitly wants persistent SDK event buffering. Storage mechanism is
  not selected. Per-event retry is undecided; the earlier three-outcome response
  is a proposal, not an approved implementation requirement. Partial acceptance
  remains desired; retry granularity and response semantics must be reconciled.
- Compared SDK batching, persistent event queues versus identity storage,
  request-level retries, asynchronous ingestion validation, GTM destination-specific
  delivery, and replay segment uploads/compression workers/envelopes. These were
  explanatory discussions, not implemented SignalTrail capabilities.
- At recording, only analytics-event.ts and analytics-event.test.ts are listed
  as modified; no commit/push performed by the coach. Infrastructure/S3 checks
  were not repeated. Recovery storage and production resilience remain pending.

## Completed delivery design and response contract — 2026-10-14–2026-10-15

Today (2026-10-15) is done at the learner's request. Delivery design was agreed
on 2026-10-14; response-schema work began then and completed today. Application
code and checks were learner-written/run with supplied coaching. Coach reviewed
source and generated exports, without running application checks.

### Agreed analytics SDK delivery design (not implemented)

- IndexedDB is the primary pending-event store. Valid analytics events are stored
  before transmission and retained while delivery is unresolved. Replay persistence
  is a separate, undecided policy. No browser SDK package exists yet.
- On storage failure, fall back to bounded memory and report degraded persistence;
  do not disrupt the host application. Memory does not survive page closure.
- Provisional configurable limits: IndexedDB 500 events/1 MiB serialized payload;
  memory 100 events/256 KiB. Either count or bytes can fill the queue. Both use
  a 24-hour maximum age from capture, with expired events removed first.
  Preserve older pending events and drop new arrivals at capacity; report losses.
  Payload bytes are UTF-8 serialized event bytes, not actual disk/RAM occupancy.
- Limits are starting budgets, not measured capacity. Calibration process:
  measure representative demo-store journeys (event rate, serialized sizes and
  bursts), choose the offline duration to support, estimate count/byte budgets
  with margin, then test offline/reconnect, refresh, multiple tabs, storage failure,
  overflow and expiry. Measure browser responsiveness, storage latency and memory;
  tune before production. Backend load testing alone cannot size browser queues.
- Per-event outcomes selected: accepted after Redpanda publication acknowledgment;
  permanently rejected events removed with diagnostics; unconfirmed publication
  retained for retry. Lost/malformed/incomplete/inconsistent responses must not
  cause unresolved events to be discarded. Preserve event IDs on every retry.
- Retry until 24-hour expiry, without a separate attempt-count cutoff. Exponential
  backoff starts with a one-second window, capped at five minutes, using full
  jitter from zero to that window; honor a longer server minimum. Persist attempt
  count and next eligible time. Newer eligible events may proceed while older
  events wait, so strict delivery ordering is not promised.
- Authentication failures pause delivery and report configuration failure. Rate
  limiting honors server delay; transient failures retry. Oversized requests need
  splitting, not identical repeated sends. Exact HTTP status mapping, resumption
  behavior, and oversized-single-event handling still need final API design.
- Multiple tabs use atomic expiring claims on selected work. Proposed initial
  request timeout 15 seconds and claim duration 60 seconds were accepted as
  provisional. Upload outside the transaction; apply responses only while owning
  the claim. Expiry allows recovery after tab loss; duplicates remain possible.
- Tracking disable stops capture/future uploads and clears pending project events
  in IndexedDB/memory across tabs. Already sent requests cannot be recalled.
  Detailed API, cleanup coordination, and re-enable behavior remain to implement.
- Recommended one analytics event per Redpanda record, with producer transport
  batching and separate ClickHouse insert batching. This recommendation was
  discussed, not independently approved as a final record format. Producer/client,
  partition key, durability configuration and downstream deduplication remain open.

### Completed response-contract increment

- Added `analytics-batch-response.ts` and its test file in contracts. Schema covers
  accepted (index/eventId/status), rejected (index/status/INVALID_EVENT), and retry
  (index/eventId/status/PUBLICATION_UNCONFIRMED plus optional retryAfterMs).
  Retry delays are nonnegative integers; event IDs are nonblank strings.
- Results must be nonempty, statuses recognized, indexes nonnegative integers
  and unique. Original rejected entries need no usable event ID.
- Exported `isAnalyticsBatchResponseForEvents`: checks equal result/request counts,
  index bounds and ID equality for accepted/retry results. Rejections match by
  index. Caller MUST parse through AnalyticsBatchResponseSchema first: uniqueness,
  nonnegative/integer indexes and nonempty results are schema responsibilities,
  not enforced again by the helper or guaranteed by TypeScript's structural types.
- On response validation/matching failure, retain unresolved queue data. The
  helper is a boolean check, not a type guard or queue-deletion implementation.
  Reordered results are logically supported by indexes but not separately tested.
- Supplied intended red failures established accepted/rejected/retry support,
  empty results, ID mismatch, missing coverage and out-of-range index behavior.
  Duplicate-index test initially passed for an unrelated invalid status; corrected
  the fixture before implementing uniqueness. Do not count that initial pass as
  evidence of duplicate detection. Other cases verify existing rules.
- Extracted index-uniqueness helper required an explicit readonly index-only type;
  removed accidental console import. Count guard moved outside every() on review.
  Helper naming (`sameSize`/`a`) remains an optional readability cleanup.
- Supplied final output confirms **57 tests passed** (38 event/batch tests,
  19 response tests), lint, typecheck and tsup JavaScript/declaration builds passed.
  Formatting output supplied before final guard move; saved code and whitespace
  reviewed afterward. Public schema/helper exports verified in source and both
  generated artifacts. Initial build omitted the unsaved entry-point export;
  corrected and rebuilt before claiming package exposure.
- No queue, retry scheduler, API authentication, publication, deduplication or
  production recovery was implemented. No fresh full-workspace checks or CI run
  verified. Response schema alone cannot prove Redpanda publication happened.
- At close, index.ts is modified and both response source/test files are untracked.
  No commit or push performed by the coach. Senior workspace documents not edited.

## Decisions and limits recorded before October 20 (historical)

- Only schema version `1` is supported (`z.literal(1)`).
- `eventId` must be a string containing a non-whitespace character. Its value is
  preserved, including surrounding spaces; UUID format is not enforced.
  Retries must preserve event identity.
- Keep `sequence` for capture order within an SDK event stream. It must be a
  nonnegative integer; zero is explicitly accepted. Retries should preserve it.
  Multi-tab coordination and session-wide ordering remain unresolved.
- URL format uses `z.url()`; protocol restrictions are not implemented. Format
  validation does not verify that a website exists.
- Client timestamps use `z.iso.datetime()` (UTC ISO datetime). Correct format
  does not establish clock accuracy; trusted receive time will be server-derived.
- Properties require JSON values recursively through `z.record(z.string(), z.json())`.
  Byte/depth bounds and cyclic runtime-value handling remain pending.
- eventId, eventName, distinctId, sessionId, and sdkVersion require a non-whitespace
  character, without trimming. Optional envelope fields and broader validation
  remain future work.
- Project association is request-level; per-event projectKey is omitted from
  the parsed contract. Batch validation supports independent event results, but
  client response handling is implemented in the SDK; actual ingestion publication
  and Redpanda acknowledgment remain pending.

## Completed browser SDK queue session — logged 2026-10-15

Today's agreed queue slice is complete. The learner wrote all application code
and ran all checks through guided, one-behavior-at-a-time TDD. Saved source was
reviewed at close; the coach did not run application checks.

- Created `@signaltrail/browser-sdk` with browser TypeScript settings, contracts
  dependency, ESLint, Vitest, tsup, and a public entry point exporting
  `openEventQueue` and `EventQueue`. Added `idb` as a runtime dependency and
  `fake-indexeddb` as a test-only dependency. Set ESLint `tsconfigRootDir`
  explicitly to resolve multiple package-root candidates.
- Implemented IndexedDB connection opening/closing, enqueue, and ordered reads.
  An auto-incrementing primary key preserves enqueue order; a unique eventId
  index is present. Duplicate-enqueue behavior is not yet specified or tested.
- Added configurable event-count capacity, default 500. Enqueue returns
  `{ status: 'queued' }` after commit or
  `{ status: 'dropped', reason: 'capacity' }` while preserving existing events.
  Count and insert share one read/write transaction on the events store.
- Four tests cover close/reopen preservation, enqueue order rather than eventId
  order, dropping new events at capacity, and capacity across two concurrent
  connections. Supplied failures established ordering, capacity, and concurrent
  capacity gaps. Initial missing eventName and missing reopen were test setup
  issues, not evidence of a persistence behavior failure.
- The concurrent test exposed a separate `database.add()` transaction after the
  count. Switching to `transaction.store.add()` kept check and insertion atomic.
  The learner correctly identified the check-then-act race in their teach-back.
- Learner reported **4 tests passed**. Supplied output confirms final Prettier,
  SDK lint, typecheck, and JavaScript/declaration builds passed. No fresh contracts,
  full-workspace, CI, actual browser reload, or real multi-tab run was verified.
- At close, `packages/browser-sdk/` is untracked and `pnpm-lock.yaml` modified.
  No commit or push was performed by the coach.

Count capacity is a completed slice, not the full persistent delivery queue.
The remaining queue and transport work listed at that session close was
subsequently implemented below on 2026-10-20; broader diagnostics remain pending.
Fake IndexedDB tests do not establish real browser durability or eviction behavior.

## Completed resilient SDK queue and transport — 2026-10-20

Stopped for today at the user's request. The agent implemented and verified the
approved slices directly, using behavior-by-behavior test-first work. The user
requested scope agreement and design questions before each day's implementation;
`AGENTS.md` now records this workflow.

- Validated configuration and added serialized UTF-8 byte capacity and capture-time
  expiry. Defaults remain IndexedDB 500 events/1 MiB/24 hours. Expired entries are
  removed before capacity decisions; new events are dropped at capacity while
  older events are preserved. Duplicate IDs return `already_queued` without
  replacing payload, order, age, or retry state.
- Isolated persistent queues by normalized ingestion endpoint and public project
  key. The transport opens its own matching queue from fixed configuration.
  This prevents accidental cross-project delivery; ingestion authentication and
  project authorization still need implementation.
- Added explicit storage outcomes and bounded memory fallback: 100 events/256 KiB,
  with the same age policy. IndexedDB open/runtime failures switch that instance
  to memory until reinitialization. Existing disk backlog remains available for
  recovery; memory fallback does not establish durable storage.
- Added atomic claims for up to 100 events with 60-second leases, owner-only
  release, and expiry-based reclamation across IndexedDB connections. Database
  migrations preserve existing events while adding claims and retry metadata.
- Added atomic response application against private original-batch snapshots.
  Accepted/rejected entries are removed, retry entries retained, and incomplete,
  malformed, mismatched, foreign, or stale responses cannot authorize deletion.
- Persisted retry timing with full jitter, an exponential window starting at one
  second and capped at five minutes, and longer server minimum delays. Retry
  state survives reopening; newer eligible events can bypass waiting entries.
  Retries preserve event IDs and continue until capture-time expiry, without a
  separate attempt limit. Server deduplication remains unimplemented.
- Added explicit `flush()` transport: POST `{ events }` to the configured endpoint
  using the public project key as a Bearer token, one request in flight per
  transport, and a 15-second deadline covering response-body parsing. Closing
  aborts the request; a late response cannot remove timed-out events.
- Network failures, timeouts, HTTP 5xx, and invalid responses retain events and
  schedule retries. HTTP 429 respects `Retry-After` seconds or dates, with a
  one-second fallback, and pauses new sends for that transport during cooldown.
  HTTP 401/403 pause for authentication; 413 pauses for payload size; other
  unexpected non-success statuses pause for investigation. Paused events remain
  queued; reinitialization is required to resume. Automatic splitting is pending.
- Agent-run verification under Node 24: **196 SDK tests passed across five files**;
  SDK formatting, lint, typecheck, JavaScript/declaration builds, and
  `git diff --check` passed. Tests use fake IndexedDB and mocked HTTP, not a live
  ingestion service. No fresh contracts, full-workspace, or remote CI run was
  verified today; real browser durability, eviction, and multi-tab behavior remain
  unverified.
- At logging time the working tree was clean. Latest inspected commit:
  `012d067` (batch upload transport); preceding retry timing commit: `ad608d0`.
  The agent did not commit or push. This documentation update is a new change.

## Completed ingestion and Redpanda session — 2026-10-22

Today's SignalTrail work is complete. After approved scopes, the agent implemented
and verified the changes directly. Documentation was updated at the user's request.

- Added automatic SDK delivery, immediate-send bypass, navigation beacon attempts,
  request-size-aware batches, HTTP 413 splitting, and single-event oversize drops.
  Events remain queued until a matching acknowledgment; beacon submission alone
  cannot authorize deletion. Oversized events are rejected before persistence;
  capacity still preserves oldest events and drops new arrivals.
- Added a Chromium Playwright harness and browser CI job covering reload persistence,
  multi-tab leases, navigation beacons, immediate sends, oversized-event handling,
  and real HTTP ingestion integration. Unit tests now live under package
  `tests/unit/`; browser tests and their harness live under SDK `tests/browser/`.
- Implemented `apps/ingestion`: request-level project-key resolution, CORS, bounded
  body size and JSON nesting, independent event validation, and per-event outcomes.
  Trusted project identity and server receive time are attached before publication.
  The entry point retains development-only authentication and refuses production.
- Connected the real KafkaJS Redpanda publisher: one record per valid event,
  project/session partition keys, all-in-sync-replica acknowledgments, bounded
  client retries, and graceful shutdown that drains underlying sends. Acceptance
  follows broker acknowledgment. Failed or uncertain publication returns retry;
  cancellation cannot retract a send already started. Producer idempotence does
  not replace downstream event-ID deduplication.
- Added the Compose `redpanda-init` one-shot service and
  `infra/redpanda/init-topics.sh`. It creates missing topics and verifies existing
  configuration without altering or deleting existing topics. Development defaults:
  three partitions, one replica, seven-day delete retention, no byte retention cap,
  and write caching disabled. The existing-topic verification was run successfully
  against the local broker. One replica provides no broker/host redundancy.
- Added four real-broker integration tests and a separate CI broker job. Tests use
  a uniquely named temporary topic; local persistent service volumes were preserved.
  CI cleanup is scoped to its isolated Compose project.
- Latest inspected commits: `436796c` topic setup/publisher; `fb85233` ingestion and
  test organization; preceding commits contain the SDK delivery and browser harness.
  Working tree was clean before this log update. The agent did not commit or push.

### Review findings and remaining risks

- High priority: outstanding publications have no count or byte capacity bound.
  HTTP publication deadlines stop waiting, but underlying Kafka sends may continue.
  Sustained traffic during broker slowness can accumulate pending work in memory.
  Bound admission and return retry outcomes when full; retain capacity until the
  underlying send settles, including after the HTTP deadline.
- Integration coverage includes a missing topic, cancellation before sending, and
  healthy-broker shutdown draining. Broker interruption during publication,
  uncertain acknowledgment, and subsequent recovery still need fault testing.
- Each event currently uses a separate producer send with one broker request in
  flight. Throughput has not been measured. Separate event records can share a
  broker request; evaluate this after establishing a measured baseline.
- Downstream deduplication, ClickHouse processing, archive-lag admission control,
  production project resolution, and recovery guarantees remain unimplemented.

## Preparation continuity

Senior's `docs/LEARNING_LOG.md` also records Day 2 algorithms and system-design
learning. It has not been updated for this SignalTrail session. The Day 2 Staff
architecture-story exercise and end-of-day review remain unverified here.
Social-media work is outside the coached curriculum per the current weekly plan.
Stable coaching and development rules are maintained in `AGENTS.md`.

This session's teach-backs demonstrated missing versus empty values, whitespace
length, literal-version validation, integer/nonnegative constraints, untrusted
client time, and object-spread overwrite order. Numeric ID acceptance initially
needed correction; the learner then correctly explained boolean rejection by
`z.string()`. Code was supplied through guided examples rather than independent
implementation. Review runtime type versus format constraints on 2026-10-02.

Day 2 teach-backs: learner explained the public export makes the schema available,
that Turbo package scope does not guarantee a lint task ran, and why a fresh CI
environment exposes dependence on local state. Formatting check versus automatic
rewrite required explanation. Review on the next curriculum day: public package
boundaries, package scope versus executed tasks, and working-tree versus committed
CI input. Implementation and commands were supplied through guided coaching.

Day 3 teach-backs: Docker engine must be running; service mounts specify volume
paths; deleting a volume loses its database files; consuming a log record does
not delete it; single-host storage does not survive disk loss; cache misses can
fall back to ClickHouse. Initially confused volumes with images and Valkey with
session search; corrected after explanation. Durability versus memory limits
also required clarification. Review these distinctions next working day
(2026-10-07), then 2026-10-13 and 2026-10-27. Senior's learning log was not edited.

2026-10-08 learning evidence: learner explained retries retain event IDs for
deduplication, ingestion acknowledgment depends on Redpanda rather than
ClickHouse processing, and containers on one VPS share its failure. RPO/RTO and
partial archive failures required explanation. Learner recognized workers need
separate permissions; corrected separate AWS account to separate identity.
Review on 2026-10-09, 2026-10-15, and 2026-10-29: recovery time versus recovery
point, partial failures and archive lag, identity versus account, and why admin
access does not verify least-privilege application access. AWS steps and commands
were supplied through guided coaching. Senior workspace documents were not edited.

2026-10-12 learning evidence: learner correctly explained unknown batch entries
allow valid/invalid siblings to be handled separately, and twice recalled that
valid events need publication to Redpanda before acceptance (reinforced waiting
for acknowledgment). Role assignment versus combined permissions required
explanation; batch buffering location, sparse traffic, replay versus analytics,
in-flight events, and vendor validation behavior were discussed with guidance.
All code/tests and commands were provided, then written/run by learner; independent
implementation mastery is not established. Closing check: one project question
answered correctly, not a full curriculum quiz. Review next session (2026-10-13),
2026-10-19, and 2026-11-02: role sessions, batch bounds versus byte limits,
partial validation versus acknowledged publication, and request-derived project
identity. Senior workspace documents were not edited in this session.

2026-10-13 learning evidence: learner correctly distinguished explicit null from
likely accidental undefined, explained client validation avoids unnecessary
ingestion calls, and correctly stated regex validation accepts surrounding spaces
without removing them. Serialization mutation needed additional explanation.
Guided discussion clarified SDK versus ingestion buffers, persistence versus
batching, request failures versus downstream event rejection, workers on the
client device, and custom envelopes versus web standards. All code/tests were
supplied; implementation mastery is not independently established. Review next
session (2026-10-14), 2026-10-20, and 2026-11-03: validation before serialization,
recursive JSON versus resource bounds, persistent queue lifecycle, and response
semantics versus retries. Senior workspace documents were not edited.

2026-10-14–15 learning evidence: learner selected storage/fallback/overflow/expiry,
per-event retry and multi-tab/opt-out policies through guided discussion. These
are agreed requirements, not implementation mastery. Clarified tests passing
because invalid fixtures assert false versus actual schema acceptance; duplicate
test initially masked missing uniqueness with an invalid status. Standalone helper
typing versus contextual inference required explanation. Learner correctly said
a mismatched response ID cannot confirm acceptance and independently recalled
retaining events and retrying with the same ID after response loss. Closing check
correct; no full curriculum quiz conducted. All implementation code supplied;
learner wrote/refactored and ran it. Review 2026-10-16, 2026-10-22, 2026-11-05:
isolating test failures, schema parsing prerequisites, safe queue removal,
uncertain acknowledgment and duplicate handling.

Browser SDK queue learning evidence (logged 2026-10-15): learner correctly
explained that closing a connection leaves the database intact, unlike deleteDB;
that queue order must follow enqueue order; and that splitting count and insert
introduces a check-then-act race. Auto-increment keys, transaction scope, test
fixture corrections, and the implementation were guided with supplied code.
Independent implementation mastery is not established. Review connection lifecycle,
key order versus event sequence, transaction atomicity, and fake versus real
browser evidence at the next session, one week later, and three weeks later.
This closes the SignalTrail slice only, not a full curriculum day or closing quiz.
Senior workspace documents were not edited.

2026-10-20 learning evidence: the user explored project queue selection and asked
for concrete scenarios and HTTP error-code explanations before approving slices.
Implementation and verification were performed by the agent after scope approval;
passing tests do not establish independent learner implementation mastery. Review
queue isolation versus ingestion authorization, lease expiry, response matching,
retry eligibility, and HTTP pause policies next session, then 2026-10-27 and
2026-11-10. Senior workspace documents were not edited. Today's SignalTrail work
is complete; this is not evidence of a full curriculum day or closing quiz.

2026-10-22 learning evidence: the user questioned topic ownership and requested
Compose-managed initialization, then requested a review of the day's work. The
review identified missing publisher admission bounds and broker-interruption
coverage. Implementation and tests were agent-performed; passing checks do not
establish independent learner implementation mastery. Review timeout versus
cancellation, outstanding-work capacity, broker acknowledgment versus downstream
deduplication, and one replica versus host resilience next session, then
2026-10-29 and 2026-11-12. Senior workspace documents were not edited.
