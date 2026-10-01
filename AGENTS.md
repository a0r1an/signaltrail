# SignalTrail project status

Last updated: 2026-10-01

## Goal

Build a production-style product analytics and session-replay platform while
preparing for Staff Software Engineer interviews at Vercel.

## Architecture direction

- Next.js dashboard hosted on Vercel
- Next.js demo store hosted on Vercel
- TypeScript browser SDK
- Node.js ingestion and query APIs
- PostgreSQL for transactional metadata
- ClickHouse for analytics events
- Redpanda for event streaming
- Valkey for caching and rate limiting
- MinIO for replay payload storage
- Docker-based local infrastructure
- Load and peak-traffic testing

## Completed

- Initialized Git repository and pnpm/Turbo monorepo
- Created `@signaltrail/dashboard`
- Created `@signaltrail/demo-store`
- Added shared `@signaltrail/typescript-config`
- Upgraded the project to Node.js 24
- Configured dependency build permissions
- Scaffolded the compilable `@signaltrail/contracts` package
- Added Zod, Vitest, tsup, and TypeScript tooling
- Confirmed clean working tree

## Important commits

- `98b7111` Initialize monorepo tooling
- `b22d1c1` Scaffold dashboard and demo store
- `c2c9522` Configure dependency build permissions
- `7fc9fc7` Add shared TypeScript configuration
- `cbcdb88` Upgrade to Node 24 and scaffold contracts

## Current task

Build the first analytics-event runtime contract using Zod and TDD.

The first behavior is:

> A valid browser analytics event is accepted.

The planned public interface is:

```ts
AnalyticsEventSchema.safeParse(input)