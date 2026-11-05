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
separate work. Per-field bounds do not guarantee a maximum-sized 100-row page fits a single
response. The reader reduces oversized pages within one deadline and returns a
cursor. Cursor wire encoding has its own independently verified bound.

Run `./scripts/signaltrail-ops.mjs check contracts` for contract verification.

## Campaign context

Analytics events may include optional `context.campaign` with only the five
standard UTM fields. Values are nonempty valid UTF-8 text of at most 1 KiB each,
without control characters. Unknown keys and malformed values invalidate that
event; batch siblings remain independently valid. Existing events without the
field remain accepted. Update ingestion and processor contracts before using new
SDK campaign capture: older readers can strip unrecognized optional context.
Campaign context describes the captured event, not a visitor identity or a
first/last-touch attribution decision.
