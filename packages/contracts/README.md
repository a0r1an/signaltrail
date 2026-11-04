# Shared analytics contracts

`AnalyticsEventSchema` validates analytics events independently within a batch.
Request/project authentication stays outside the event envelope. Ingestion
publishes only parsed valid events, preserving valid siblings when others fail.

`eventId`, `eventName`, and `sessionId` must contain a non-whitespace character,
represent valid Unicode scalar values, and fit 4,096 UTF-8 bytes each. The exported
`MAX_ANALYTICS_IDENTIFIER_BYTES` names this bound. Values are preserved exactly;
there is no trimming or normalization. The byte counter uses standard JavaScript
Unicode iteration, without Node globals or browser storage dependencies.

This matches the private event-summary reader's existing per-field bounds.
It tightens the private pre-release version-1 contract: newly ingested oversized
or lone-surrogate identifiers are rejected per event as `INVALID_EVENT`. Existing
broker records failing the stricter schema follow the processor's acknowledged
`INVALID_RECORD` dead-letter path. Existing ClickHouse rows are not rewritten.
Deploying mixed schema versions or handling historical invalid records requires
an explicit rollout/recovery plan before production.

The low-level SDK queue accepts typed complete events and does not automatically
run this schema on enqueue. JavaScript integrations can call `safeParse` before
enqueue; ingestion always validates independently. A public capture API remains
separate work. Per-field bounds do not guarantee a maximum-sized 100-row page
fits the reader's independent response byte cap, and cursor wire encoding has
its own bound.

Run `./scripts/signaltrail-ops.mjs check contracts` for contract verification.
