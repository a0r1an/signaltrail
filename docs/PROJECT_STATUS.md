# SignalTrail project status

Last updated: 2026-10-01

## Goal and architecture

Build a product analytics and privacy-conscious session-replay platform while
preparing for Staff Software Engineer interviews at Vercel.
Next.js dashboard and demo store on Vercel; TypeScript browser SDK; Node.js
ingestion/query APIs; PostgreSQL metadata; ClickHouse analytics; Redpanda event
transport; Valkey caching/rate limits; MinIO replay storage; Docker local stack.
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

## Completed this session — 2026-10-01

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

- Latest learner-reported results after the fixture refactor: **11 tests passed**
  and **typecheck completed without errors**. Commands from repository root:
  `pnpm --filter @signaltrail/contracts test` and
  `pnpm --filter @signaltrail/contracts typecheck`.
- Source was inspected; these commands were not independently run by the coach.
- Strict TypeScript settings were inspected, including `strict`,
  `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Package build after these changes is **not verified**. The build command is
  `pnpm --filter @signaltrail/contracts build` (tsup with declaration generation).
- `packages/contracts/src/index.ts` still exports only `CONTRACT_VERSION`;
  the schema is not yet exposed through the package entry point.
- Lint, formatting checks, and CI configuration/run results remain unverified.
- Last inspected working tree had modified documentation/configuration and
  untracked schema/test files. No commit of this session's work is verified.

## Exact next step

Expose the schema through the package entry point. Keep the existing declaration
in `packages/contracts/src/index.ts` and add:

```ts
export { AnalyticsEventSchema } from './analytics-event.ts';
```

Then verify tests, typecheck, and the package build using the commands above.
Inspect any build/declaration errors before claiming package consumption works.
After that, continue Day 2 with lint/formatting and CI inspection, addressing
remaining contract rules one behavior at a time. Local infrastructure is Day 3;
SDK and event-to-dashboard integration remain later milestones.

## Preparation continuity

Senior's `docs/LEARNING_LOG.md` records Day 1 algorithms and request-lifecycle
learning, plus review needs. That log has not been updated for this session.
No career recording, evidence inventory, social draft, or end-of-day reflection
is verified. Stable coaching and development rules are maintained in `AGENTS.md`.

This session's teach-backs demonstrated missing versus empty values, whitespace
length, literal-version validation, integer/nonnegative constraints, untrusted
client time, and object-spread overwrite order. Numeric ID acceptance initially
needed correction; the learner then correctly explained boolean rejection by
`z.string()`. Code was supplied through guided examples rather than independent
implementation. Review runtime type versus format constraints on 2026-10-02.
