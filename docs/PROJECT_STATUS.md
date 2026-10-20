# SignalTrail project status

Last updated: 2026-10-20

## Goal and architecture

Build a product analytics and privacy-conscious session-replay platform while
preparing for Staff Software Engineer interviews at Vercel.
Next.js dashboard and demo store on Vercel; TypeScript browser SDK; Node.js
ingestion/query APIs; PostgreSQL metadata; ClickHouse analytics; Redpanda event
transport; Valkey caching/rate limits; Amazon S3 replay object storage
(replacing the originally planned MinIO); Docker local stack.
Load and peak-traffic testing follow working ingestion and processing.

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

## Important decisions and current limits

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

## Test and build status

- Browser SDK as of 2026-10-20: **196 tests passed**, agent-run under Node 24;
  formatting, lint, typecheck, and tsup JavaScript/declaration builds passed.
  Actual browser, live ingestion, and full-workspace/CI verification remain pending.
- Contracts as of 2026-10-15: supplied output confirms **57 tests passed**, lint,
  typecheck, and tsup JavaScript/declaration builds passed. Source and generated
  response schema/helper exports inspected. Formatting supplied before final
  guard move; whitespace reviewed afterward.
- Workspace: learner reported `pnpm test`, `pnpm typecheck`, and `pnpm build`
  all passing. Full root outputs were not supplied.
- Formatting: Day 2 root check passed from supplied output. Compose formatting
  check passed on 2026-10-12; modified contract formatting learner-reported.
  No fresh root formatting check or CI run verified today.
- Lint: supplied `pnpm lint` output confirms **three successful tasks** for
  contracts, dashboard, and demo-store. TypeScript-config has no lint task.
- CI: learner reported a successful GitHub Actions run after the documentation
  fix. Workflow source was reviewed; remote run logs/URL were not independently
  inspected. Repository: https://github.com/a0r1an/signaltrail.
- Earlier application checks were learner-run; the 2026-10-20 SDK checks above
  were independently run by the agent.
- Strict TypeScript settings were inspected, including `strict`,
  `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Build/export verification does not yet demonstrate an application importing
  the package or runtime service integration. Branch-protection enforcement is
  not verified.
- At Day 3 close, `compose.yaml` and unexpected files `rpk` and `--partitions`
  were untracked. Their purpose is unknown; inspect before staging. They were
  not removed in that session; both were absent on 2026-10-08. Live service
  state at close was not rechecked.

## Exact next step

Next session: propose the day's scope and resolve necessary design questions,
then wait for approval before implementation. Do not repeat completed queue,
response matching, retry timing, or explicit transport work.

1. Choose the next slice: automatic flush scheduling and SDK lifecycle, HTTP 413
   batch splitting and single-event oversize policy, or live ingestion integration.
   The explicit transport is ready; automatic sending is not implemented.
2. For scheduling, agree on triggers, timer ownership, shutdown behavior, and how
   retries become eligible without creating overlapping requests.
3. For ingestion, implement request-level authentication, body-size protection,
   per-event publication outcomes, and acceptance only after Redpanda acknowledgment.
   Stable client event IDs still require server-side deduplication.
4. Schedule real browser reload and multi-tab checks. Fake IndexedDB tests cover
   connection coordination but do not prove browser persistence or eviction behavior.
5. Public capture/session APIs, project-wide opt-out clearing, broader diagnostics,
   and full event-to-dashboard integration remain later work. Run full workspace
   checks and inspect CI before treating repository-wide readiness as verified.

Review lease ownership versus expiry, uncertain acknowledgment versus rejection,
retry timing versus automatic scheduling, and project isolation versus server
access control. Restricted S3 and Compose setup are complete; do not repeat them.

Plan the recovery bucket and PostgreSQL/ClickHouse backup and event-archive
strategy separately. No archive implementation or production deployment is
required before continuing contract/API work. S3 is selected; do not restart the
provider comparison or add a fifth local service by assumption.

Inspect and intentionally stage current changes when committing. Full workspace
checks and CI for these changes remain pending. SDK and full event-to-dashboard
integration remain later milestones; production recovery targets remain unverified.

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
