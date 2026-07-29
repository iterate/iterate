# Operator Sessions

Operator sessions let someone who has an environment's
`APP_CONFIG_ADMIN_API_SECRET` open OS in a browser without putting that shared
deployment secret in browser storage, JavaScript, a URL, or a cookie. Doppler
selects the deployment URL and its matching secret together.

The normal operation is **open one project**. OS creates a synthetic operator
principal with project-admin authority over exactly the resolved project. The
operator does not become a customer user and does not inherit that user's
organizations, other projects, access tokens, preferences, or integrations.

The exceptional operation is **open the platform administration UI**. It is a
separate, explicit `--admin` mode with deployment-wide authority. Prefer a
project-scoped session whenever the work concerns one project.

## Quick Reference

Run these commands from `apps/os`:

```bash
# Open one project in the environment selected by your local Doppler setup.
pnpm cli session create --project <slug-or-prj-id> --open

# Open one project in a specific preview environment.
doppler run --config preview_3 -- pnpm cli session create \
  --project <slug-or-prj-id> --open

# Open one project in production.
doppler run --config prd -- pnpm cli session create \
  --project <slug-or-prj-id> --open

# Open the production platform administration UI. This is deliberately
# separate from project access and should be used only for platform work.
doppler run --config prd -- pnpm cli session create --admin --open
```

`--project` accepts either the human-readable project slug or its stable
`prj_...` ID. `--open` launches the one-shot URL in the default browser. Omit
`--open` to print the URL for another browser, Playwright, or an agent.

## Common User Stories

### Open A Project Created By An E2E Test Or Agent

An E2E run or an agent often creates a project in a preview slot and prints its
slug or project ID. Open it directly; no auth-worker user, forge key, OTP, or
customer account is needed:

```bash
cd apps/os
doppler run --config preview_8 -- pnpm cli session create \
  --project prj_01JEXAMPLE123 \
  --open
```

If the test output gives a slug instead, pass the slug:

```bash
doppler run --config preview_8 -- pnpm cli session create \
  --project e2e-example-project \
  --open
```

If you know the preview slot but not the project reference, list that
deployment's project directory with the existing admin-secret CLI, then pass
the selected `id` or `slug` to `session create`:

```bash
doppler run --config preview_8 -- pnpm cli itx run \
  --eval 'return await itx.projects.list({ scope: "deployment" })'

doppler run --config preview_8 -- pnpm cli session create \
  --project <id-or-slug-from-the-list> \
  --open
```

The preview Doppler config supplies both `APP_CONFIG_BASE_URL` and that
preview's `APP_CONFIG_ADMIN_API_SECRET`. A production secret cannot mint a
preview session, and a preview grant cannot be redeemed by production because
the signed grant is bound to the issuing origin.

For browser automation, omit `--open` and add pnpm's `--silent` flag so stdout
contains exactly the URL rather than pnpm's script banner:

```bash
doppler run --config preview_8 -- pnpm --silent cli session create \
  --project e2e-example-project
```

Navigate to that URL immediately. It is a short-lived bearer capability, so do
not put it in a test artifact, issue comment, or long-lived log.

### Open A Customer Project In Production

Opening a customer's project does not require impersonating the customer. The
operator needs project-level access to inspect the dashboard and operate that
project, not the customer's complete identity:

```bash
cd apps/os
doppler run --config prd -- pnpm cli session create \
  --project customer-project-slug \
  --open
```

The resulting browser session exposes only that project. Cross-project access
checks do not consult or widen from the normal user membership directory for
operator grants, so navigating to another project's route or capability does
not add access. The synthetic principal uses a project-specific synthetic
organization ID rather than the customer's real organization ID; this keeps
organization membership and stale-claim route fallbacks from authorizing a
sibling project. The account menu labels the browser as "Project-scoped
operator access" so it cannot be mistaken for the customer's login.

By default, the CLI records the first available value from
`OPERATOR_IDENTITY`, `GITHUB_ACTOR`, or `USER` as audit attribution. Override
it when a shared shell, CI process, or support procedure needs a clearer actor:

```bash
doppler run --config prd -- pnpm cli session create \
  --project customer-project-slug \
  --operator incident-1234/jonas \
  --open
```

`--operator` labels the Iterate employee or automation responsible for the
session. It is not an email or ID of the customer being viewed, and changing it
does not change the grant's authority.

When the work is complete, choose **End operator session** in the account menu.
OS deletes the operator cookie and reloads the dashboard; if the browser
already had an ordinary Iterate login, that underlying session becomes active
again. Otherwise the normal sign-in flow is shown. Operator access also ends
automatically when the signed grant expires.

This mechanism intentionally does not reproduce behavior that depends on one
specific customer's OAuth identity, personal preferences, or complete
organization memberships. Use the auth forge only in non-production when a
test genuinely needs that auth-session shape. Production support should use
project-scoped operator access.

### Hand A Session To Another Browser Or Agent

Without `--open`, the command prints the one-shot redemption URL. Use
`pnpm --silent` when another process needs stdout to contain only that URL:

```bash
doppler run --config preview_8 -- pnpm --silent cli session create \
  --project e2e-example-project
```

Navigate the intended browser to that URL. The signed grant is after the URL
fragment (`#`), so it is not included in the initial HTTP request, edge request
URL, or `Referer`. The redemption page removes the fragment before posting it
to the same origin and installing the HttpOnly cookie.

The default lifetime is 15 minutes. Use `--ttl-seconds` for a value from 60
through 3600 seconds, and keep it as short as the task allows:

```bash
doppler run --config preview_8 -- pnpm cli session create \
  --project e2e-example-project \
  --ttl-seconds 300
```

### Open Platform Administration

Use platform-wide authority only when the task cannot be performed in one
project, such as inspecting global streams or the deployment project list:

```bash
doppler run --config prd -- pnpm cli session create --admin --open
```

`--admin` and `--project` are mutually exclusive. Omitting both is an error;
the CLI never infers platform authority from a missing project reference.

## CLI Options

`pnpm cli session create` accepts:

- `--project <slug-or-prj-id>`: resolve and grant access to exactly one project.
- `--admin`: grant explicit platform-wide operator authority and default to
  `/admin`.
- `--operator <label>`: audit attribution for the human or automation creating
  the session. It does not select a customer identity.
- `--open`: launch the redemption URL in the default browser instead of
  printing it.
- `--ttl-seconds <60..3600>`: grant lifetime; defaults to 900 seconds.
- `--return-to </same-origin-path>`: route opened after redemption. Project
  sessions default to `/projects/<slug>` and platform sessions to `/admin`.
- `--base-url <url>`: explicit OS deployment URL. Normally Doppler provides
  `APP_CONFIG_BASE_URL`, so use this only for a deliberate local override.

The CLI sends `APP_CONFIG_ADMIN_API_SECRET` only as the issuance request's
`Authorization` bearer. The secret remains in the Node process. It is never
placed in the returned grant or passed to the browser-opening command.

The ordinary `pnpm cli itx` commands are different: they authenticate directly
with the selected environment's admin secret and therefore retain deployment
authority even when `--context` selects a project handle. Use `session create`
for the project-confined browser workflow described here.

## HTTP API

Controlled automation can call `POST /api/operator-sessions` directly. The
request must include the matching deployment secret and JSON content type:

```http
POST /api/operator-sessions HTTP/1.1
Authorization: Bearer <APP_CONFIG_ADMIN_API_SECRET>
Content-Type: application/json
```

Project-scoped request:

```json
{
  "kind": "project",
  "operatorId": "incident-1234/jonas",
  "project": "customer-project-slug",
  "ttlSeconds": 900,
  "returnTo": "/projects/customer-project-slug"
}
```

Platform-wide request:

```json
{
  "kind": "admin",
  "operatorId": "deployment-maintenance/jonas",
  "ttlSeconds": 900,
  "returnTo": "/admin"
}
```

`operatorId` is required in the HTTP API because the server cannot infer which
human owns a bearer request. `project` is resolved in the selected deployment
before the grant is signed. `returnTo` must be a same-origin absolute path.
Unknown fields are rejected.

The response contains:

```json
{
  "browserUrl": "https://os.example/api/operator-sessions/redeem#token=...",
  "expiresAt": "2030-01-01T00:00:00.000Z",
  "kind": "project",
  "project": { "id": "prj_...", "slug": "customer-project-slug" },
  "token": "..."
}
```

Use `browserUrl` for browser redemption. A controlled non-browser Cap'n Web
client may present the returned token explicitly as
`{ type: "operator-session", token }`. Ambient cookie authentication remains
same-origin only.

## End-To-End Flow

1. The operator selects a Doppler environment and runs the CLI.
2. The CLI sends the matching admin secret to `POST /api/operator-sessions`.
3. OS verifies the secret, resolves the requested project, creates a synthetic
   operator principal, and signs a short-lived grant with HMAC-SHA256.
4. The CLI opens or prints a URL whose fragment contains that grant.
5. The redemption page reads and removes the fragment, posts the grant to the
   same origin, and receives an HttpOnly, host-only, `SameSite=Strict` cookie.
6. Browser middleware and Cap'n Web authentication verify the cookie on every
   request and reconstruct only the signed authority.
7. Project grants bypass membership-directory widening and stay limited to the
   one signed project ID until expiry.
8. **End operator session** calls the same-origin
   `DELETE /api/operator-sessions/current` endpoint and expires the operator
   cookie without signing out an underlying customer or employee login.

## Security Properties

- The deployment admin secret is accepted only on the issuance request. The
  former raw-secret browser cookie endpoint no longer exists.
- Grants are signed, versioned, limited to one hour, and bound to the exact
  deployment origin. Rotation of `APP_CONFIG_ADMIN_API_SECRET` immediately
  invalidates every outstanding operator grant and cookie in that environment.
- A project reference must resolve before signing. The grant contains exactly
  one stable project ID; it cannot list, open, or acquire another project.
- A project operator is a synthetic principal, not an impersonated customer.
  Its generated `@operator.invalid` email exists only to satisfy the ordinary
  authenticated UI shape.
- Platform authority is a distinct grant kind selected by `--admin`. It is not
  inferred from absent or invalid project input.
- Browser cookie authentication rejects an `Origin` that differs from the OS
  origin. Redemption is frame-denied, `no-store`, protected by a strict CSP,
  and limited to a path embedded in the signed grant.
- Issuance and redemption logs contain only `operatorId`, grant kind, session
  ID, expiry, and optional project ID. They never contain the admin secret or
  signed grant.

Operator grants are stateless bearer capabilities and cannot be individually
revoked before expiry. Use the short default TTL. Rotate the environment's
admin secret when immediate environment-wide revocation is required.

## Compatibility And Ownership

There is intentionally no compatibility layer for the former
`/api/admin-cookie` endpoint, `iterate-admin-auth` cookie, `--as` CLI option, or
`subject`/`email` issuance fields. Old cookies and old request shapes fail
closed. The current contract uses `operatorId` strictly as audit attribution.

Implementation ownership:

- `scripts/session.ts`: Doppler-aware CLI, audit identity defaults, and browser
  launcher.
- `src/auth/operator-session.ts`: strict request/grant schemas, project
  resolution, signing, redemption, cookies, public session shape, and logs.
- `src/auth.ts`: explicit and ambient Cap'n Web credential verification plus
  the no-directory-widening rule for scoped grants.
- `src/auth/middleware.ts`: ordinary HTTP route principal selection.
- `src/components/app-sidebar.tsx`: scope labeling and the operator-specific
  session-ending action.
- `src/ingress.ts`: routes the issuance and redemption endpoints before the
  dashboard application.

`pnpm auth:mint` remains a separate non-production auth-testing tool. It forges
a complete auth-worker identity and requires `AUTH_FORGE_ES256_PRIVATE_JWK`; it is
not the production support path for opening a project.
