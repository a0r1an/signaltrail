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
- Clean working tree reported previously; not reverified for this handoff.

Important commits: `98b7111` monorepo; `b22d1c1` frontends; `c2c9522` build
permissions; `7fc9fc7` TypeScript configuration; `cbcdb88` Node 24/contracts.

## Current task and inspected state

First analytics-event runtime contract using Zod and test-first development.
First behavior: **a valid browser analytics event is accepted**.
Public interface: `AnalyticsEventSchema.safeParse(input)`.

Inspected `packages/contracts/src/analytics-event.test.ts` at handoff:
- Vitest's `describe`, `it`, and `expect` are imported.
- Schema import still points to `./analytics-event.test.js` (self-import).
- Test calls `isValidSync({})`; that is not the planned Zod interface and the
  empty object is not a valid event fixture.
- No working acceptance test or schema has been demonstrated. Re-read files
  in the new session in case the user has changed them.

The package test command from repository root is:
`pnpm --filter @signaltrail/contracts test`.

## Resume here

Read AGENTS.md and inspect contracts source/tsconfig before giving code.
Explain and show the corrected acceptance test in
`packages/contracts/src/analytics-event.test.ts`: import the implementation,
use a concrete valid fixture, call `safeParse`, assert `result.success` is true.
The user writes and runs it. Do not merely request they invent the test.
Resolve setup/import failures, then establish the intended behavior failure
before guiding schema implementation. Show one step at a time, with rationale.

Agreed fixture shape (not yet validated by implementation):
- `schemaVersion: 1`
- `eventId: "d23f947a-15e8-4fa1-9cb8-338e50cb2a16"`
- `projectKey: "adrianproject-1234"`
- `distinctId: "visitor-789"`
- `sessionId: "2e8b4071-8f65-4a92-a653-909bc390ab24"`
- `eventName: "product_viewed"`
- `clientTimestamp: "2026-10-01T16:00:00.000Z"`
- `sequence: 1`
- `url: "https://demo.signaltrail.dev/products/product-123"`
- `properties: { productId: "product-123" }`
- `context: { sdkVersion: "0.1.0" }`

The learner explained that TypeScript types do not validate runtime inputs and
that a retry preserves eventId. Teach visitor/session/event identity as needed.
Do not reintroduce product definition or repeat scaffolding. Runtime validation,
invalid-event rejection, checks/CI verification, and local infrastructure remain
next milestones; the full event-to-dashboard slice is later work.

## Preparation continuity

Senior's `docs/LEARNING_LOG.md` records Day 1 algorithms and request-lifecycle
learning, plus review needs. No career recording or social draft is verified.
New teaching preference: explain the task, show code and why, then let the user
write/run it and review their result. No application code was edited during this
handoff; only documentation was authorized.
