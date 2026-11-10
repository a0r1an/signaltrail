# Processor fetch batching

The batch-capable event processor collects broker fetches toward 64 KiB of source
data for at most 200 ms before passing returned records to its existing partition
batch processor. Redpanda holds the records during collection. No extra application
queue is introduced. Existing bounds remain: 1 MiB per partition fetch, 2 MiB per
fetch response, and chunks of at most 100 records / 1 MiB of source payload.
Storage writer validation and its separate encoded-payload bound remain in effect.

`SIGNALTRAIL_PROCESSOR_BATCH_WAIT_MS` configures the entrypoint. Default 0 (opt-in); allowed
integer range 0–1000. Zero restores minimum fetch bytes=1 and KafkaJS's 5000-ms
maximum wait for an empty fetch. That preserves immediate return when a record is
available; zero does not mean busy-polling an empty broker. Invalid/empty values
fail configuration without echoing their contents.

Direct `createRedpandaEventConsumer` callers can set `batchWaitMs`. If omitted,
all callers retain zero-wait collection until this candidate is qualified. A positive wait requires a batch writer. Values above zero set minBytes=65536
and maxWaitTimeInMs to the configured value. The value bounds broker collection,
not total event-to-storage latency; network, processing, queueing and retries add
time. It is not a guaranteed minimum batch size: a fetch may return fewer records,
and partition distribution splits a fetch into separate storage chunks.

This changes collection at the fetch boundary; it does not sleep inside eachBatch
hoping that its already-fetched array will grow. Existing batch ownership/staleness
checks, heartbeats, storage-acknowledgment-before-commit, retries, DLQ handling and
shutdown cancellation remain in their established path. A fetched batch stays
uncommitted until storage/DLQ acknowledgment. Replays may duplicate writes after
ambiguous outcomes, so stable IDs and downstream replacement remain necessary.

Test-first configuration/consumer checks and the existing processor safety suite
cover the change. Use `./scripts/signaltrail-ops.mjs check processor` and the isolated
`load pipeline` recovery probe. For measured comparison:

- `load capacity-4gb-memory-trace-heap`: explicit zero-wait baseline.
- `load capacity-4gb-memory-trace-heap-batched`: explicit 200-ms candidate.
- `load capacity-4gb-memory-trace-heap-batched-smoke`: 30-second capability probe.

Both long profiles run 900 seconds at 100 EPS, the same four-GiB allocation/CPU/
admission limits and analytical/heap observation, followed by three-minute idle.
Historical memory profiles explicitly retain zero wait so prior names do not
silently change collection behavior. Actual profile configuration is saved in
result.applicationLimits.workerBatchWaitMs and inspected in the fixture environment.
Never compare runs without checking their effective settings and result/errors.
No running development/production service is restarted by these changes.

Collection semantics: [KafkaJS consumer options](https://kafka.js.org/docs/consuming#options).
Load comparison results are recorded separately from implementation verification.

The initial short probe passed, but the long candidate encountered broad scheduling
stalls and failed capacity checks despite lower memory. Collection is therefore
opt-in in the final implementation; setting the environment to 200 explicitly
enables the tested candidate. No deployment or running-service restart occurred.

Measured outcomes, failed long-trial limits and exact next step:
[batching comparison](../performance/4gb-worker-batching.md).
