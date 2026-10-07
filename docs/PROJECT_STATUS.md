# SignalTrail project status

Last updated: 2026-10-06

## Goal and architecture

Build a product analytics and privacy-conscious session-replay platform while
preparing for Staff Software Engineer interviews at Vercel.
Next.js dashboard and demo store on Vercel; TypeScript browser SDK; Node.js
ingestion/query APIs; PostgreSQL metadata; ClickHouse analytics; Redpanda event
transport; Valkey caching/rate limits; replay object storage (provider pending,
originally MinIO); Docker local stack.
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
- Properties currently permit arbitrary values through
  `z.record(z.string(), z.unknown())`; JSON-only validation remains pending.
- Other required string fields still allow empty strings. Optional envelope
  fields and broader validation remain future work.

## Test and build status

- Contracts: learner reported **11 tests passed**, successful typecheck, and
  successful tsup JavaScript/declaration build. Build output was supplied and
  generated exports were inspected.
- Workspace: learner reported `pnpm test`, `pnpm typecheck`, and `pnpm build`
  all passing. Full root outputs were not supplied.
- Formatting: Day 2 supplied `pnpm format:check` output confirms success.
  Day 3 Compose formatting remains unchecked; visible whitespace differences
  remain. No CI run for today's infrastructure changes is verified.
- Lint: supplied `pnpm lint` output confirms **three successful tasks** for
  contracts, dashboard, and demo-store. TypeScript-config has no lint task.
- CI: learner reported a successful GitHub Actions run after the documentation
  fix. Workflow source was reviewed; remote run logs/URL were not independently
  inspected. Repository: https://github.com/a0r1an/signaltrail.
- Source was inspected; application checks were not independently run by the coach.
- Strict TypeScript settings were inspected, including `strict`,
  `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Build/export verification does not yet demonstrate an application importing
  the package or runtime service integration. Branch-protection enforcement is
  not verified.
- At Day 3 close, `compose.yaml` and unexpected files `rpk` and `--partitions`
  were untracked. Their purpose is unknown; inspect before staging. They were
  not removed. This status update is not committed or pushed. Live service
  state at close was not rechecked.

## Exact next step

Resume with infrastructure wrap-up: inspect the unexpected untracked files,
then have the learner run `docker compose ps` and `docker stats --no-stream`
to capture current readiness and resource use. Review, format, and validate
`compose.yaml` before staging. Resource usage remains unmeasured.

Resolve the replay object-storage decision before adding a fifth service or
creating a managed bucket. Do not assume a replacement was approved. Verify
upload/download and persistence for the selected local store; do not repeat
the four completed service probes.

Day 4's bounded batch contract remains next curriculum work. JSON-compatible
properties and required-string policies remain follow-ups. SDK and full
event-to-dashboard integration remain later milestones.

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
