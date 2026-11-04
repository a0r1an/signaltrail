# Private analytics query reference

[analytics.openapi.json](analytics.openapi.json) describes the implemented count
and event-summary routes using OpenAPI 3.1.1. Import it into an OpenAPI-aware
viewer or use it as input for a future dashboard client. No documentation server
or public API route is installed by this file.

The `query.invalid` server is a documentation placeholder. The required bearer
scheme describes the locally tested, injected verified-session fixture binding.
It does not configure production authentication or imply JWTs. Before mounting a
service, choose the real provider and header/cookie transport, update its security
scheme and server URL, and supply the actual identity/membership resolver. Public
ingestion project keys must never authorize either read route.

Runtime checks exceed what plain JSON Schema expresses: UInt64 decimal bounds,
valid UTF-8 byte lengths, actual calendar dates, window duration, and cursor scope
remain enforced by the implementation. Clients must retain decimal values as
strings, preserve cursor bytes, and follow `hasMore` rather than assuming the
requested page size is returned. The cursor is not a snapshot or authorization
token. Received-time replacement semantics remain provisional product behavior.

The analytics unit suite validates the document with `@readme/openapi-parser`,
checks that references stay inside the document, and disables external reference
resolution. This is part of the existing runner and CI package tests:

```sh
./scripts/signaltrail-ops.mjs check analytics
```

Test-only AJV validators also check actual handler response shapes, both page
variants, exact decimal strings, error codes, cache/content headers, and exclusion
of extra private fields. The owned `load authorized-analytics` probe applies the
same response checks over real HTTP and storage. JSON Schema date-time format
validation is disabled in this helper; UTC patterns, shapes, and types are checked,
while byte limits, UInt64 numeric bounds, calendar validity, and scope invariants
remain covered by the runtime reader tests. This is not exhaustive request/response
or production session-provider validation. Generated dashboard types remain
follow-up work. Both validators are development dependencies only.

Reference: [OpenAPI 3.1.1 specification](https://spec.openapis.org/oas/v3.1.1.html).
