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

The React view supports UTC ranges, exact filters, counts, event summaries,
paging, refresh, and denial/error states. Project/session scope changes remount
the model and clear old data; hosts must rotate `scopeKey` when the verified
principal or query-client lifetime changes. Initial query props initialize each
scope only. React effect replay does not start abandoned requests.

`./scripts/signaltrail-ops.mjs dashboard browser` runs an owned native Chromium
fixture with the real query client and portable handler, synthetic data and a
fixture-only HttpOnly cookie. It verifies rendering, paging, filters, partial
failures, safe text, project switches and denial clearing. Reports/screenshots
and failure traces live in ignored `test-results/event-explorer-browser/`.
It does not supply production authentication or real database integration.

The protected `/dashboard` server page now mounts `ConnectedExplorer` for a
selected project UUID. Its client uses same-origin occurrence-time API methods;
owner/session verification and fresh membership checks live on the server.
`ExplorerClient` uses date-basis-neutral `countEvents` / `listEvents` methods.
The injected component defaults to received-time diagnostics; the connected app
explicitly uses event time and displays receipt diagnostics alongside it. Date
basis, project and session scope changes remount private state. Live Clerk login
and provisioned data credentials remain unverified; the fixture supplies no
production authentication or fallback.
Run `./scripts/signaltrail-ops.mjs check dashboard` for models, lint, route types,
TypeScript and the optimized production build.

The optional `countVisitors` reader adds an exact visitor total. It is refreshed
with filters/totals rather than each cursor page. Visitor-only failures preserve
usable events; a denial from any sibling request clears all private data. The
connected application uses project-scoped identity resolution for this total.
