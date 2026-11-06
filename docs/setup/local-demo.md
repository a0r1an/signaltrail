# Local capture demo

Use the existing local Compose services and configured development Clerk owner.
This workflow is local development, not production hosting or a capacity claim.

```sh
./scripts/signaltrail-ops.mjs metadata configure-local
./scripts/signaltrail-ops.mjs pipeline start-local
```

The configuration command retains the existing owner/project/key. It also creates
a separate PostgreSQL key-column reader for ingestion and a separate ClickHouse
INSERT-only processor user. Passwords remain in the ignored private setup state.
The dashboard reader is separate and cannot read ingestion keys or change data.

The foreground pipeline owns only its ingestion/processor/demo child processes:

- Demo store: `http://localhost:3001`.
- Stored-key ingestion: `127.0.0.1:4102`; metrics on `127.0.0.1:9467`.
- Broker/storage: existing Compose services. Analytics and local DLQ topics use
  the idempotent topic initializer; incompatible existing settings fail startup.

Port 4100 was already occupied during setup and was left untouched. Startup
refuses occupied demo ports; it does not kill other services. Ctrl+C forwards
shutdown only to owned child processes, with a bounded termination fallback.
No Compose volumes are removed. Pipeline supervision is development-only.

The public browser key is supplied only to the demo process; database credentials
are supplied only to the relevant server child. Clerk secrets are not passed to
these children. The store uses the public SDK's persistent identity and queue.
Click a product to capture `demo_product_viewed`. There is no automatic page-view
event, checkout or replay recording. Queue success is not a durable server ack;
the SDK's normal batching and retry behavior performs delivery.

The demo uses Next.js's supported Webpack path because Turbopack worker socket
creation failed in this environment even after escalation. Lint, type checks and
the optimized Webpack build pass through `check demo`.

## Verification

While the pipeline is running, a separate terminal can run:

```sh
./scripts/signaltrail-ops.mjs pipeline probe-local
```

This sends one labeled `local_pipeline_probe` event using the low-level SDK's
Node memory fallback and confirms both server acceptance and the exact stored ID
through the restricted analytics reader. It leaves that event in the local project
and saves a report under ignored `test-results/local-pipeline/`. A failed response
may still have been accepted; inspect the event rather than assuming loss. This
probe does not establish native-browser persistence, a real product click, or
authenticated dashboard rendering. Those are separate checks.

`./scripts/signaltrail-ops.mjs pipeline status-local` performs read-only counts
of product clicks and CLI probes in the project's last 24 hours. It sends no
events and does not claim browser automation or authenticated UI verification.

For the real browser check, open the demo, click a product, then open the signed-in
dashboard. Include the current time in its UTC filters. The dashboard's Refresh
button reloads the selected window; it does not automatically move the window's
end time forward. Look for `demo_product_viewed` and distinguish it from CLI probes.
