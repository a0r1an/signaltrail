# Event explorer foundation

The model takes a fixed selected project and an injected bounded query client.
Filters cannot override project scope. It preserves exact count strings, carries
opaque cursors, and supports next/first-page navigation without unbounded cursor
history. Applying filters cancels obsolete requests and resets pagination; late
results and late denial errors cannot overwrite the current query.

Session/membership denial immediately clears displayed data and cancels sibling
work. A count-only failure can leave valid events usable. Private exception details
are reduced to display categories. `cancel()` supports React effect cleanup/replay;
`close()` permanently disposes the model. Neither closes the shared query client.

The React view and native fixture are the next slice. This feature is not mounted
on a live dashboard route and supplies no session provider or authorization default.
Run `./scripts/signaltrail-ops.mjs check dashboard` for models, lint, route types,
TypeScript and the optimized production build.
