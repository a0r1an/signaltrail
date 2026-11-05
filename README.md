# SignalTrail

A source-available product analytics and session-replay platform in development.
SignalTrail focuses on reliable browser event delivery, project-scoped analytics,
and operationally verifiable failure recovery.

## Current state

The analytics pipeline works locally from the low-level browser SDK through HTTP
ingestion and Redpanda into ClickHouse. It has native-browser persistence,
retry/recovery, downstream deduplication, and isolated real-storage test coverage.
Authorized count and paged event queries, a browser query client, and an injected
React event explorer are implemented. Owner-only Clerk sign-in routes and guards
are implemented, but real account configuration/verification remain pending. The
explorer is not mounted in a live route.

Production authentication verification, a convenient `init`/`track` SDK API, session recording
and replay playback, deployment, and backup/restore drills remain ahead.
This is not a production-ready service or an availability guarantee.

## Architecture

- **Browser SDK:** IndexedDB buffering, bounded batching, retries with stable IDs,
  multi-tab coordination, and page-exit delivery attempts.
- **Ingestion:** validates events independently, authorizes ingestion keys, bounds
  outstanding work, and waits for Redpanda acknowledgement before acceptance.
- **Event processor:** consumes broker records, writes ClickHouse, handles dead
  letters, and commits offsets after required acknowledgements.
- **Analytics reads:** project membership authorization through PostgreSQL,
  bounded ClickHouse queries, exact counts, filters and cursor-based summaries.
- **Dashboard:** Next.js, with an injected explorer component and browser fixture.
- **Operations:** Docker local services, isolated load/recovery probes, and metrics
  forwarding through Grafana Alloy. S3 is selected for future replay objects.

## Development and verification

Use Node.js 24 and the repository-pinned pnpm 10.27.0. The standard runner selects
an installed Node 24 runtime and rejects unknown operations.

```sh
./scripts/signaltrail-ops.mjs install
./scripts/signaltrail-ops.mjs check dashboard
./scripts/signaltrail-ops.mjs dashboard browser
```

The browser fixture requires the workspace's pinned Chromium installation:

```sh
./scripts/signaltrail-ops.mjs browser install
```

The explorer fixture owns an ephemeral loopback server and Chromium instance;
it does not require cloud credentials or development databases. It writes
reports/screenshots and failure traces under ignored `test-results/`.
Package checks and browser checks are separate; do not run builds that clean the
same package outputs concurrently.

Other package, broker, monitoring and isolated load operations are documented in
[the operations skill](.agents/skills/signaltrail-operations/SKILL.md). Integration
probes require Docker and remove only their owned test resources. They must not
be substituted with outage experiments against development services.

## Project documentation

- [Current implementation, evidence and next steps](docs/PROJECT_STATUS.md)
- [Open questions and provisional decisions](docs/OPEN_QUESTIONS.md)
- [Query API reference](docs/api/analytics.openapi.json)
- [Private Clerk setup](docs/setup/clerk.md)
- [Licensing scope](docs/LICENSING.md)

## License

The platform is **FSL-1.1-ALv2**: source-available with the competing-use restriction
in [LICENSE.md](LICENSE.md), converting per version to Apache 2.0 after two years.
The [browser SDK](packages/browser-sdk/LICENSE.md) and
[shared contracts](packages/contracts/LICENSE.md) are **MIT** licensed.
Third-party components retain their own licenses. See the
[licensing guide](docs/LICENSING.md) for the precise directory boundaries.
