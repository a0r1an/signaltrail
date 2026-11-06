# Private dashboard authentication

The dashboard uses Clerk sessions plus a server-side owner-ID restriction.
It accepts session tokens only, checks the configured issuer and owner, and does
not treat an email address, public ingestion key, or client-provided user ID as
proof of access. Clerk authentication does not replace project membership checks.
The initial dashboard page confirms access; the protected analytics server route
also requires organization membership. See [data setup](dashboard-data.md).

## Clerk account configuration

Perform these steps independently for development and production instances.
No account, application, invitation or user is created by installing the SDK.

1. Create/select a Clerk application. Enable email/password sign-in and keep other
   sign-in methods disabled for this initial private deployment.
2. In Access mode, select **Invite-only** and save. Hiding a sign-up link is not
   sufficient. Do not enable open registration or send additional invitations.
3. Under Users, manually create your application account with your email and a
   password. Enter the password directly in Clerk; never put it in the repository,
   scripts or chat. This application account is separate from your Clerk admin
   dashboard account.
4. Copy the resulting `user_...` identifier for the owner restriction. A different
   account, including one accidentally created later, is denied by the app.
5. Copy `apps/dashboard/.env.example` to ignored `.env.local` in that directory.
   Fill its matching publishable/secret keys, owner ID, Clerk issuer origin and
   application origin locally. Never commit real values or print secret keys.
   The issuer must match this instance's session JWT `iss` claim; obtain it from
   Clerk's instance/session-token configuration, not untrusted request input.
6. Use the exact app origin, e.g. `http://localhost:3000` locally. Production uses
   HTTPS. Do not add arbitrary redirect hosts or wildcard authorized parties.
   Production keys, issuer and user IDs differ from development.

The application deliberately has no owner bootstrap endpoint, default account,
fixture credentials, sign-up route, or bypass when configuration is missing.
Clerk's sign-in component follows instance settings; confirm invite-only mode in
Clerk before exposure. There is no automatic expiry of the owner restriction after
90 days: widening access requires an explicit later change.

## Verification

```sh
./scripts/signaltrail-ops.mjs check dashboard
./scripts/signaltrail-ops.mjs dashboard auth-smoke
```

`auth-smoke` starts only an owned production Next process on an ephemeral loopback
port. It explicitly blanks auth configuration, verifies protected resources return
503/no-store, tests forged request headers, checks the sign-in setup state, and
stops that process before recording success. It does not use a real Clerk account
or prove valid-password, recovery, logout, or active-session revocation behavior.
Reports are in ignored `test-results/dashboard-auth/`.

With the real development instance configured, verify manually before deployment:

- Signed out: dashboard redirects to `/sign-in`; `/api/session` returns 401.
- Owner: sign-in succeeds; `/api/session` returns 200 with only an authorization
  status, and `/dashboard` confirms private access.
- Non-owner (if an existing test account is available): API returns 403 and the
  page denies access. Do not create paid resources or real users just for a probe.
- Sign out: subsequent protected requests deny access. Review Clerk's session
  token lifetime/revocation semantics before promising instantaneous revocation.
- Public registration is blocked by Clerk's backend, not merely absent from UI.

Resource-level checks use `readOwnerAccess()` on every request without a shared
session cache. Future analytics routes must also verify organization/project
membership. Unconfigured auth returns 503; the sign-in page shows an unavailable
state. The middleware restricts authorized parties to the configured app origin.

References: [access modes](https://clerk.com/docs/guides/secure/restricting-access),
[user creation](https://clerk.com/docs/guides/users/managing),
[Next.js sessions](https://clerk.com/docs/reference/nextjs/app-router/auth), and
[Next.js proxy](https://clerk.com/docs/reference/nextjs/clerk-middleware).

Owner verification has a five-second response deadline. At most 32 underlying
Clerk verification calls may be outstanding per warm process. Timed-out provider
work retains its slot until it actually settles; overload fails closed. These
are provisional resource limits, not measured authentication capacity. The guard
does not promise instantaneous vendor-session revocation or cancel unsupported
provider work. Sessions and prior successful grants are not cached by this guard.
