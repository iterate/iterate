---
state: active
priority: high
size: large
tags: [os, mcp, grok, oauth, preview, auth]
updated: 2026-07-02
pr: https://github.com/iterate/iterate/pull/1588
preview: preview_4
---

# OS MCP Grok Voice Debug Log

This is the consolidated working log for the Grok Voice Builder failure against
the deployed Iterate OS MCP server.

Current preview:

- PR: https://github.com/iterate/iterate/pull/1588
- Branch: `wholesale-education`
- Latest deployed commit: `d16e607211cf366e1b2367481cc17af37867f284`
- Short commit: `d16e607`
- Preview lease: `preview_4`
- Auth URL: `https://auth.iterate-preview-4.com`
- OS URL: `https://os.iterate-preview-4.com`
- MCP URL: `https://mcp.iterate-preview-4.com`
- Main MCP endpoint: `https://mcp.iterate-preview-4.com/api/mcp`
- Worker tail log used during this session: `/tmp/os-preview-4-grok-tail.log`

## Executive Summary

The original production symptom was:

- Grok Voice Builder can reach the MCP server.
- Grok can fetch protected-resource metadata.
- The browser OAuth flow appears to complete.
- Grok then says it cannot list tools.
- OS sees `401 Missing or invalid bearer token` or rejects the bearer token.

The strongest current finding is:

- Grok sometimes sends no bearer token at all on the first post-OAuth MCP
  `initialize`.
- Grok then retries with a bearer token.
- The token Grok sends is not JWT-shaped. It is a 32-character opaque token.
- The existing OS verifier only accepted JWT-shaped access tokens, so it could
  never accept that token.
- A preview fallback was added that asks the auth worker to look up opaque
  OAuth access tokens directly in its `oauthAccessToken` table.
- On the fresh `d16e607` preview, that fallback returns `not_found` for the
  token Grok presents.
- That means the latest blocker is no longer just "OS cannot parse an opaque
  token"; the token Grok presents is not found in the auth worker token table
  that OS is asking.

Latest observed failing trace on `2026-07-02T15:56Z`:

- URL tested by user:
  `https://mcp.iterate-preview-4.com/debug/oauth-verify-mcp-base`
- Grok first request:
  - method: `POST`
  - JSON-RPC method: `initialize`
  - no `Authorization` header
  - OS returns `401`
- Grok later retry:
  - method: `POST`
  - bearer token present
  - token shape: `{ length: 32, partCount: 1, looksJwt: false }`
  - normal JWT verification fails
  - internal opaque-token lookup returns `{ active: false, reason: "not_found" }`
  - OS returns `401`

## Original Production Evidence

Original research lived in:

`/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/tasks/os-mcp-grok-voice-tool-loading.md`

Production traces around `2026-07-02T12:44Z` showed:

- `POST https://mcp.iterate.com/`
  - status: `401`
  - user agent: `grok-connectors-manager/0.1.0`
  - ray: `a14dbd5a4b3a319e`
  - trace: `d0d0264174ec7bb7000cef175757a4e0`
- `POST https://os.iterate.com/api/mcp`
  - status: `401`
  - user agent: `grok-connectors-manager/0.1.0`
  - ray: `a14dbda7f8cbe5e4`
  - trace: `002dd530f5f1175b7203603381a49852`
- Protected-resource metadata fetches around the same time returned `200`.
- More `POST https://os.iterate.com/api/mcp` requests returned `401`.

Production behavior implied:

- Grok can reach OS.
- Grok can discover protected-resource metadata.
- Grok does not complete an authenticated `initialize` plus `tools/list` flow.
- Observability redacts `Authorization`, so we originally could not know
  whether there was no bearer token or a bad bearer token.

The unauthenticated production response was:

```http
HTTP/2 401
www-authenticate: Bearer resource_metadata="https://mcp.iterate.com/.well-known/oauth-protected-resource"
```

Body:

```text
Missing or invalid bearer token
```

Production metadata returned:

```json
{
  "resource": "https://mcp.iterate.com",
  "authorization_servers": ["https://auth.iterate.com/api/auth"],
  "scopes_supported": ["openid", "profile", "email", "offline_access", "project"],
  "bearer_methods_supported": ["header"]
}
```

## Reference Server That Works

Working comparison repo:

`/Users/jonastemplestein/src/tries/2026-07-02-zero-trust-mcp`

Known working deployed URL:

`https://zero-trust-mcp.templestein.workers.dev/mcp`

Key properties of the working server:

- It uses `@modelcontextprotocol/server@2.0.0-beta.1`.
- It uses the newer/default MCP server package transport shape.
- It uses one path per integration/resource.
- Protected-resource metadata is served at root/suffix paths with:
  `pathname.startsWith("/.well-known/oauth-protected-resource")`.
- Auth-server metadata is same-origin and path-scoped:
  `/.well-known/oauth-authorization-server/<id>`.
- It supports dynamic client registration.
- It uses PKCE.
- It returns JSON OAuth errors.
- Its `WWW-Authenticate` includes `error` and `error_description`.
- It does not rely on Better Auth stateful access-token lookup. Access tokens
  are sealed self-contained opaque blobs.
- Its MCP resource exactly matches the endpoint:
  `https://zero-trust-mcp.templestein.workers.dev/<id>/mcp`.

Important lesson from that repo:

- Current MCP clients reliably handle basic OAuth discovery, dynamic client
  registration, PKCE, refresh, and `invalid_grant` reauthorization.
- More advanced step-up scope behavior is not reliable across clients.

## Initial Hypotheses

The main hypotheses at the start were:

1. Grok completes browser OAuth but does not forward a bearer token to its
   server-side tool-listing process.
2. Grok mints/stores the token for `https://os.iterate.com/api/mcp`, while OS
   validates only `https://mcp.iterate.com`.
3. Grok does not correctly use the `scopes_supported` metadata if the
   `WWW-Authenticate` challenge lacks an explicit `scope`.
4. Grok expects root/suffix protected-resource metadata paths and does not like
   endpoint-relative metadata only.
5. Grok mishandles a pathful split authorization server issuer:
   `https://auth.iterate.com/api/auth`.
6. Grok is sensitive to older MCP SDK transport behavior.
7. Better Auth opaque token handling differs from the JWT verifier used by OS.

The current evidence has ruled in parts of 1 and 7 and mostly weakened 2:

- We have observed no-bearer-token requests.
- We have observed bearer-token requests.
- Bearer tokens are opaque, not JWT.
- Audience variants did not fix the issue.
- Internal auth lookup now says the opaque token is not found.

## Preview Environment Setup

The user explicitly asked not to use preview slot 2. A new lease was taken on
`preview_4`.

Preview lease:

- Doppler config: `preview_4`
- Lease id: `708427ca-8e69-4365-a36c-a6504073ce28`
- Latest lease expiry observed after redeploy: `1783011221680`

Preview URLs:

- Auth: `https://auth.iterate-preview-4.com`
- OS: `https://os.iterate-preview-4.com`
- MCP: `https://mcp.iterate-preview-4.com`

Deploy command used:

```sh
GITHUB_TOKEN="$(gh auth token)" \
  doppler run --preserve-env=GITHUB_TOKEN --project _shared --config prd -- \
  pnpm preview deploy --pull-request-number 1588
```

Latest preview deploy result:

```text
auth status: awaiting-tests
os status: awaiting-tests
headSha: d16e607211cf366e1b2367481cc17af37867f284
shortSha: d16e607
```

## Code Changes Made So Far

### 1. MCP SDK Beta

Changed `apps/os` to use the beta MCP server package:

- `@modelcontextprotocol/server@2.0.0-beta.1`

Reason:

- The working zero-trust MCP server uses this package.
- The user suspected the beta server libs are better.
- The beta SDK shape made it easy to create vanilla debug servers that match
  the working reference more closely.

### 2. Debug MCP Handler

Added:

`apps/os/src/domains/inbound-mcp-server/mcp-debug-handler.ts`

Purpose:

- Serve multiple minimal MCP endpoints under the deployed MCP host.
- Compare no-auth, optional-auth, required-auth, token-verify, and
  project-grant behavior in Grok.
- Log safe diagnostics before asking the user to retry.

Dummy tools exposed by debug endpoints:

- `ping`
- `echo_json`

Safe logging includes:

- method
- public URL
- user agent
- debug variant
- auth mode
- bearer-token presence
- token shape
- decoded JWT metadata only if token is JWT-shaped
- accepted audiences
- scopes
- project count

It does not log raw bearer token values.

### 3. Real MCP Auth Logging

Updated:

`apps/os/src/domains/inbound-mcp-server/mcp-handler.ts`

Purpose:

- Log Grok-only auth failure branches:
  - `iterate_auth_not_configured`
  - `no_bearer_token`
  - `token_decode_or_verify_failed`
  - `audience_mismatch`
  - `no_project_grants`
  - `opaque_internal_introspection_inactive`
  - `opaque_internal_introspection_error`
- Log Grok-only auth success:
  - verification mode
  - scopes
  - project count
  - safe token metadata

### 4. Protected Resource Metadata Compatibility

Added/centralized metadata helpers:

`apps/os/src/domains/inbound-mcp-server/mcp-auth-metadata.ts`

Behavior:

- Advertise MCP protected-resource metadata consistently.
- Accept MCP base resource variants.
- Include `scope` and OAuth error fields in challenges where appropriate.
- Keep CORS headers compatible with Streamable HTTP.

### 5. Debug Endpoint Variants

The debug endpoints added or used include:

- `https://mcp.iterate-preview-4.com/debug/public`
- `https://mcp.iterate-preview-4.com/debug/oauth-optional`
- `https://mcp.iterate-preview-4.com/debug/oauth-required`
- `https://mcp.iterate-preview-4.com/debug/oauth-required-scope-empty`
- `https://mcp.iterate-preview-4.com/debug/oauth-verify-token`
- `https://mcp.iterate-preview-4.com/debug/oauth-project-grants`
- `https://mcp.iterate-preview-4.com/debug/oauth-verify-mcp-base`
- `https://mcp.iterate-preview-4.com/debug/oauth-project-grants-mcp-base`
- `https://mcp.iterate-preview-4.com/debug/oauth-verify-debug-accept-mcp-base`
- `https://mcp.iterate-preview-4.com/debug/oauth-project-grants-debug-accept-mcp-base`

### 6. Audience Variants

The following resource/audience strategies were tried:

- Debug path as resource.
- MCP base as resource.
- Accept debug path plus MCP base.
- Accept:
  - `https://mcp.iterate-preview-4.com`
  - `https://mcp.iterate-preview-4.com/`
  - `https://os.iterate-preview-4.com/api/mcp`
  - relevant debug-path resources

Result:

- Audience changes did not fix tool loading.
- Once Grok sent a bearer token, the token was opaque and failed before normal
  JWT audience validation could matter.

### 7. Internal Opaque Token Introspection Fallback

Added a service-token protected internal endpoint in auth:

Contract:

`apps/auth-contract/src/index.ts`

Route:

`/internal/oauth/introspect-access-token`

Implementation:

`apps/auth/src/server/orpc/routers/internal.ts`

SQL:

`apps/auth/src/server/db/queries/oauth-client.sql`

Generated query:

`getOAuthAccessTokenForInternalIntrospection`

Purpose:

- OS first tries the normal JWT bearer verifier.
- If that fails and a bearer token exists, OS calls auth internal service API.
- Auth directly looks up the opaque token in `oauthAccessToken`.
- Auth checks:
  - token exists
  - token has not expired
  - OAuth client is not disabled
  - user id exists
  - session has not expired if a session id exists
- Auth reconstructs Iterate-style access-token claims:
  - `sub`
  - `sid`
  - `iss`
  - `aud`
  - `iat`
  - `exp`
  - `scope`
  - `scopes`
  - organizations
  - projects
  - platform admin role

Important semantic detail:

- If a token has the `project` scope but no valid stored project-selection
  reference, the reconstructed projects list is empty.
- This mirrors current Better Auth token-minting semantics.
- It avoids accidentally granting all projects when the project-selection page
  never ran.

Limitation:

- Better Auth 1.6.9 does not appear to persist OAuth `resource`/`audience` for
  opaque access tokens.
- The internal endpoint validates the token and assigns the accepted audience
  passed by OS.
- This is diagnostic/compatibility behavior, not a complete proof that Better
  Auth originally minted the token for that MCP resource.

### 8. SQL Generation Fix for Auth

While adding the auth token lookup query, `pnpm --dir apps/auth db:generate`
failed:

```text
No Miniflare v3 root found ...
```

Auth's `sqlfu.config.ts` used `findMiniflareD1Path("auth-dev-auth-db")`, unlike
OS and semaphore, which read Alchemy's local wrangler config and open D1 through
Miniflare.

Fix:

- Updated `apps/auth/sqlfu.config.ts` to follow the OS/semaphore pattern.
- Added `miniflare` as an auth dev dependency.
- Regenerated auth SQL query bindings.

### 9. Contract Typecheck Fix

`apps/auth-contract` typecheck failed because existing source iterates
`new Headers(initHeaders)`, but tsconfig did not include `dom.iterable`.

Fix:

- Added `dom.iterable` to `apps/auth-contract/tsconfig.json`.

### 10. Contract Package Lint Fix

Initial contract shape imported runtime Zod schemas from
`@iterate-com/shared/auth-claims`.

Lint rejected that:

```text
iterate(contract-package-imports): Forbidden runtime import "@iterate-com/shared/auth-claims"
```

Fix:

- Kept contract package lightweight.
- Inlined the small access-token organization/project claim schemas in
  `apps/auth-contract/src/index.ts`.

## User-Tested Endpoint Results

### Initial Vanilla Debug Endpoints

The user reported that the simple vanilla endpoints worked.

Observed/reported behavior:

- At least one endpoint worked without asking for OAuth.
- At least one endpoint worked, asked for OAuth, did not ask to select/create
  projects, and returned the dummy `Ping` and `Echo JSON` tools.
- Another endpoint behaved the same.

Interpretation:

- Grok can connect to Streamable HTTP MCP on preview 4.
- Grok can list tools from the beta SDK debug server.
- Grok can complete at least some OAuth flow against Iterate Auth.
- Tool-listing failure is not caused by basic transport, CORS, or the beta MCP
  server package alone.
- The lack of project selection is suspicious because the real OS MCP endpoint
  requires project grants.

### `oauth-verify-token`

User result:

```text
https://mcp.iterate-preview-4.com/debug/oauth-verify-token couldn't load tools
```

Observed logs:

- OAuth flow succeeded.
- Grok presented an opaque 32-character bearer token.
- Token was not JWT-shaped.
- Normal verifier failed.

Interpretation:

- Verification fails before project-grant logic.

### `oauth-project-grants`

User result:

```text
https://mcp.iterate-preview-4.com/debug/oauth-project-grants couldn't load tools
```

Observed logs:

- OAuth flow succeeded.
- Token was opaque.
- Normal verifier failed.

Interpretation:

- Project grants were not actually evaluated because token verification failed
  first.

### `oauth-verify-mcp-base`

User result before opaque fallback:

```text
https://mcp.iterate-preview-4.com/debug/oauth-verify-mcp-base couldn't load tools
```

User result after opaque fallback deploy:

```text
https://mcp.iterate-preview-4.com/debug/oauth-verify-mcp-base didn't work
```

Fresh logs after `d16e607`:

- First request:
  - `POST`
  - URL:
    `https://mcp.iterate-preview-4.com/api/mcp/debug/oauth-verify-mcp-base`
  - user agent: `grok-connectors-manager/0.1.0`
  - event: `auth_challenge`
  - no auth header
  - body method: `initialize`
  - status: `401`
- Follow-up `GET`:
  - user agent: `Grok`
  - no auth header
  - status: `401`
- Later retry:
  - event: `token_verify_attempt`
  - accepted audiences:
    - `https://mcp.iterate-preview-4.com`
    - `https://mcp.iterate-preview-4.com/`
    - `https://os.iterate-preview-4.com/api/mcp`
  - token shape:
    - length: `32`
    - part count: `1`
    - looks JWT: `false`
  - event: `opaque_internal_introspection_inactive`
  - reason: `not_found`
  - event: `token_verify_failed`
  - status: `401`

Interpretation:

- Grok does eventually send a bearer token.
- The token is opaque.
- The token is not found by the auth worker internal lookup.
- This is now the most important clue.

### `oauth-project-grants-mcp-base`

User result:

```text
https://mcp.iterate-preview-4.com/debug/oauth-project-grants-mcp-base also couldn't load tools
```

Observed before opaque fallback:

- OAuth succeeded.
- No project creation/selection UI.
- Token was opaque.
- Verification failed.

Interpretation:

- The project-grants check never ran because token verification failed.

### `oauth-verify-debug-accept-mcp-base`

User result:

```text
Couldn't load tools after OAuth success.
OAuth flow didn't ask me to create/select projects.
```

Interpretation:

- Accepting both debug path and MCP base audience did not fix the issue.
- This further weakens the audience-mismatch hypothesis.

### `oauth-project-grants-debug-accept-mcp-base`

User result:

```text
Exactly, exactly the same.
```

Fresh logs after `d16e607`:

- URL:
  `https://mcp.iterate-preview-4.com/api/mcp/debug/oauth-project-grants-debug-accept-mcp-base`
- user agent: `grok-connectors-manager/0.1.0`
- event: `token_verify_attempt`
- accepted audiences:
  - `https://mcp.iterate-preview-4.com/debug/oauth-project-grants-debug-accept-mcp-base`
  - `https://mcp.iterate-preview-4.com`
  - `https://mcp.iterate-preview-4.com/`
  - `https://os.iterate-preview-4.com/api/mcp`
- token shape:
  - length: `32`
  - part count: `1`
  - looks JWT: `false`
- event: `opaque_internal_introspection_inactive`
- reason: `not_found`
- event: `token_verify_failed`
- status: `401`

Interpretation:

- Even when all relevant audiences are accepted, Grok's token cannot be found.

## Better Auth Findings

Installed versions:

- `better-auth`: `1.6.9`
- `@better-auth/oauth-provider`: `1.6.9`

Discovery on preview 4:

```sh
curl -sS https://auth.iterate-preview-4.com/api/auth/.well-known/openid-configuration
```

Important returned fields:

```json
{
  "issuer": "https://auth.iterate-preview-4.com/api/auth",
  "token_endpoint": "https://auth.iterate-preview-4.com/api/auth/oauth2/token",
  "userinfo_endpoint": "https://auth.iterate-preview-4.com/api/auth/oauth2/userinfo",
  "introspection_endpoint": "https://auth.iterate-preview-4.com/api/auth/oauth2/introspect",
  "introspection_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
  "revocation_endpoint": "https://auth.iterate-preview-4.com/api/auth/oauth2/revoke"
}
```

Better Auth source inspection showed:

- `@better-auth/oauth-provider@1.6.9` supports opaque access tokens.
- Opaque access tokens are stored in `oauthAccessToken`.
- Stock introspection calls a validator with the introspecting client id.
- In 1.6.9, that appears likely to enforce same-client validation.
- Better Auth 1.6.9 opaque-token introspection does not include `aud`.
- It reconstructs custom claims from stored token/user/scopes/reference id.
- It does not pass `resource` into opaque custom-claim reconstruction.

Important implication:

- OS using its own OAuth client credentials to introspect Grok's dynamically
  registered-client token through the stock introspection endpoint might return
  inactive.
- That is why the preview change used an internal service-token endpoint that
  directly looks up the token without the same-client restriction.

New implication after `not_found`:

- The token Grok sends is not merely blocked by same-client introspection.
- It is not found by direct lookup in the auth database by token value.

Possible explanations for `not_found`:

1. Grok is not sending the access token from Iterate Auth. It may be sending
   its own connector/session token.
2. Better Auth stores a transformed/hashed token value while the raw presented
   token differs. This needs verification against Better Auth source and DB
   rows.
3. Grok is sending a refresh token, authorization code, device code, or another
   opaque artifact in the `Authorization` header rather than an access token.
4. Token issuance is happening against a different auth environment than OS
   is introspecting.
5. The token expired or was deleted before lookup, though the timing makes this
   less likely.
6. The OAuth flow reports success in Grok but the token exchange did not
   actually mint/store an access token in auth.

## Project Selection Findings

Across the failing OAuth debug endpoints, the user repeatedly observed:

- OAuth completed.
- The flow did not ask to select an organization.
- The flow did not ask to create/select a project.

Current auth behavior:

- The `project` scope triggers the `/project-access` post-login page.
- If the user has no organizations, auth should redirect into project/org
  onboarding.
- If `project` scope is not requested, project selection is skipped.
- If `project` scope is requested but no selection reference is stored,
  token custom claims contain zero project grants.

Interpretation:

- Grok might not be requesting the `project` scope, despite metadata listing it.
- Grok might be requesting scopes differently than expected.
- Grok might skip or not support post-login project-selection UX.
- However, for the current failures we have not yet reached project-grant
  evaluation because token verification/lookup fails first.

## Issues Encountered During Debugging

### Preview Slot

- The user asked not to use preview 2.
- We used preview 4 instead.

### Cloudflare Tail Session

- A `wrangler tail` tmux session was used to capture logs:
  `os-preview-4-grok-tail`.
- It exited at least once and had to be restarted.
- Latest logs were still available in `/tmp/os-preview-4-grok-tail.log`.

### SQL Generation

`apps/auth` SQL generation initially failed:

```text
No Miniflare v3 root found ...
```

Fixed by making `apps/auth/sqlfu.config.ts` use the Alchemy local wrangler
config pattern already used by OS and semaphore.

### TypeScript

`apps/auth-contract` standalone typecheck initially failed:

```text
Type 'Headers' must have a '[Symbol.iterator]()' method
```

Fixed by adding `dom.iterable` to the tsconfig lib array.

### Lint

Contract-package import lint rejected a runtime import from shared:

```text
Forbidden runtime import "@iterate-com/shared/auth-claims" in a contract package.
```

Fixed by inlining tiny schemas in the contract package.

### Deploy Warnings

Preview deploy showed existing app-config warnings unrelated to this MCP work:

- Unknown config key `integrations.github`
- Unknown config key `xAiApiKey`
- Unknown config key `geminiApiKey`

Deployment completed successfully despite those warnings.

## Verification Commands Run

Focused typechecks:

```sh
pnpm --dir apps/auth-contract exec tsc --noEmit --pretty false
pnpm --dir apps/auth exec tsc --noEmit --pretty false
pnpm --dir apps/os exec tsc --noEmit --pretty false
```

Focused lint:

```sh
pnpm exec oxlint \
  apps/auth-contract/src/index.ts \
  apps/auth/sqlfu.config.ts \
  apps/auth/src/server/orpc/routers/internal.ts \
  apps/os/src/domains/inbound-mcp-server/mcp-handler.ts \
  apps/os/src/domains/inbound-mcp-server/mcp-debug-handler.ts \
  --deny-warnings
```

Focused tests:

```sh
pnpm --dir apps/os exec vitest run \
  src/domains/inbound-mcp-server/mcp-handler.test.ts \
  src/workers/ingress.test.ts
```

All passed before the `d16e607` deploy.

Preview metadata smoke check:

```sh
curl -sS -D /tmp/mcp-preview4-headers.txt \
  https://mcp.iterate-preview-4.com/.well-known/oauth-protected-resource/debug/oauth-verify-mcp-base \
  -o /tmp/mcp-preview4-metadata.json
```

Returned `200` with:

```json
{
  "resource": "https://mcp.iterate-preview-4.com",
  "authorization_servers": ["https://auth.iterate-preview-4.com/api/auth"],
  "scopes_supported": ["openid", "profile", "email", "offline_access", "project"],
  "bearer_methods_supported": ["header"],
  "resource_name": "os-mcp-debug-oauth-verify-mcp-base"
}
```

## What We Have Learned

1. The beta MCP server package and basic Streamable HTTP transport are not the
   core blocker. Simple debug endpoints work in Grok.
2. Grok can fetch protected-resource metadata.
3. Grok can complete at least some OAuth flow.
4. Grok does not reliably send a bearer token on the first MCP initialize after
   OAuth.
5. Grok later sends a bearer token.
6. The bearer token is opaque, not JWT.
7. OS's original verifier could not handle opaque tokens.
8. An internal opaque-token fallback was implemented.
9. The token Grok sends is not found by that fallback.
10. Audience/resource variants did not solve the issue.
11. Project selection remains suspicious, but it is not yet the active blocker
    for the failing verify endpoints.

## 2026-07-02T17:05Z Update: Hypothesis B CONFIRMED — tokens are stored hashed

Confirmed from installed `@better-auth/oauth-provider@1.6.9` source:

- `dist/index.mjs:2735` — the plugin defaults to `storeTokens: "hashed"`.
- `dist/utils-B9Pj9EPf.mjs:232` — `storeToken()` applies `defaultHasher` to
  opaque tokens before insert; `getStoredToken()` hashes before lookup.
- `defaultHasher` = `base64url(sha256(value))` with no padding (43 chars).

So the `oauthAccessToken.token` column holds hashes, never raw tokens. Our
internal introspection endpoint looked up the raw 32-char bearer value, which
can never match. The 32-char opaque token Grok sends is almost certainly a
genuine Better Auth access token; `not_found` was our lookup bug, not Grok.

Fix (commit `706de08c4`): `apps/auth/src/server/orpc/routers/internal.ts`
hashes the presented token with the same base64url-sha256 helper the file
already used for client secrets (renamed `hashOAuthStoredValue`) before the
`getOAuthAccessTokenForInternalIntrospection` lookup.

Parallel workstream: a background agent is building
`/Users/jonastemplestein/src/tries/2026-07-02-zero-trust-mcp-preview4-auth` —
the known-good zero-trust MCP resource server, modified to advertise
`https://auth.iterate-preview-4.com/api/auth` as its authorization server and
validate bearers via the Better Auth userinfo endpoint. Testing that in Grok
isolates Grok × Better Auth interop from our OS resource-server code.

Likely next blocker once tokens verify: project grants. Grok's OAuth flow
never showed project selection, so either Grok omits the `project` scope
(introspection then returns ALL user projects, no `project:<id>` scope
entries) or the selection reference is missing (empty projects). Watch the
auth tail (`/tmp/auth-preview-4-grok-tail.log`) for the scopes Grok requests
at `/authorize`.

## 2026-07-02T17:25Z Update: hash fix verified via synthetic token; second bug found and fixed

Verification without Grok: inserted a synthetic `oauthAccessToken` row into
the preview-4 auth DB with `token = base64url(sha256(<known raw value>))`,
reusing the clientId/userId/referenceId/scopes of Grok's most recent real
token row, then POSTed an MCP `initialize` with the raw value as bearer.

- Before the hash fix the lookup returned `not_found`.
- After deploying `706de08` (auth at that sha), the tail showed the token
  IS found — `not_found` is gone.
- New failure: `opaque_internal_introspection_error: "Output validation
failed"` — the oRPC contract declares `sid: z.string().optional()` but the
  handler returned `sid: null` (synthetic row has no session; the session FK
  is on-delete-set-null so real tokens can hit this too).
- Fix: `sid: token.sessionId ?? undefined` in
  `apps/auth/src/server/orpc/routers/internal.ts`.

Also confirmed from the DB rows: Grok's earlier tokens are fully healthy —
scopes `["openid","profile","email","offline_access","project"]` and a valid
`iterate-project-selection-v1` referenceId selecting
`prj_e774914d27304b9b82532351c467e0ac`, all for the same user. So project
selection DID run, Grok requests the project scope, and once introspection
passes, project grants should reconstruct correctly. Hypotheses A, C, D, and
E are all dead: the token Grok sends is a genuine preview-4 Better Auth
access token.

Parallel bisect deployment ready for Grok testing:
`https://zero-trust-mcp-preview4.templestein.workers.dev/mcp` — the
known-good zero-trust resource server advertising preview-4 Better Auth as
its authorization server, validating bearers via the userinfo endpoint
(tools: ping, echo_json, whoami). Source:
`/Users/jonastemplestein/src/tries/2026-07-02-zero-trust-mcp-preview4-auth`.
Tail: `cd` there and `bunx wrangler tail zero-trust-mcp-preview4 --format pretty`.

## 2026-07-02T17:40Z RESOLVED (pending Grok retest): full e2e green with opaque token

Deployed `3ed0ba4` to preview-4 (auth + os). Synthetic-opaque-token
verification now passes the ENTIRE path, including the real production MCP
endpoint:

- `POST https://mcp.iterate-preview-4.com/debug/oauth-verify-mcp-base`
  `initialize` → 200; `tools/list` → `ping`, `echo_json`.
- `POST https://mcp.iterate-preview-4.com/` (the real endpoint)
  `initialize` → 200; `tools/list` → `exec_js` with project grants resolved
  from the selection referenceId.

Root cause was two OS/auth-side bugs in the new internal introspection path,
not Grok:

1. Raw-value token lookup vs hashed storage (fixed `706de08`).
2. `sid: null` violating the oRPC output schema (`z.string().optional()`)
   for session-less tokens (fixed `3ed0ba4`).

Test artifact: a synthetic `oauthAccessToken` row (id
`PmMHJXvm1zWWm99IGqPuqnu1z2tPOdDC`) in the preview-4 auth DB, raw value known
locally, expires 2026-07-02T19:16:48Z. Self-cleans on expiry.

Next: retest in Grok Voice Builder against
`https://mcp.iterate-preview-4.com/api/mcp`. Note Grok's cached tokens from
earlier attempts have 30-minute expiries, so it may need a fresh OAuth
round-trip; expired tokens now return a clean `invalid_token` challenge with
reason `expired` rather than `not_found`. Optionally also test the
reverse-bisect server
`https://zero-trust-mcp-preview4.templestein.workers.dev/mcp`. Tail running:
`/tmp/os-tail-live.log` (os-preview-4-app).

Follow-ups before merging PR 1588 to prd:

- Decide whether the debug endpoints/verbose Grok logging stay or get
  stripped.
- Consider whether OS should keep the JWT-first verifier + internal opaque
  fallback, or whether auth should mint JWT access tokens for MCP clients.
- The `sid`/hash fixes are needed regardless.

## 2026-07-02T18:05Z Update: Grok works; project-selection skip diagnosed and fixed

User confirmed Grok now lists tools from
`https://mcp.iterate-preview-4.com/api/mcp` (run-script tool present). New
question: why was the user never asked to select/create a project.

Diagnosis:

- The user WAS asked once, at 13:34Z (first OAuth round of the day). One
  `oauthProjectSelection` row was created then and never deleted.
- The intended one-shot consumption lives in `customAccessTokenClaims`, but
  the oauth-provider does not invoke that hook when minting OPAQUE tokens
  (claims are reconstructed at introspection time) — so the row survived ~10
  mints.
- `resolveStoredProjectSelection` looked rows up by USER id
  (`getLatestOAuthProjectSelectionByUserId`), while the table is keyed
  `(session_id, client_id)`. Grok registers a new dynamic client per
  connection, so every new client silently inherited the first client's
  selection and `postLogin.shouldRedirect` skipped `/project-access` forever.
- Delete-on-read is not an option: better-auth calls `consentReferenceId` up
  to three times within one authorize→consent flow. The postLogin hooks also
  never receive a clientId, so per-client lookup isn't possible.

Fix (deployed to preview-4):

- New query `getFreshOAuthProjectSelectionBySessionId` — lookup scoped to the
  auth browser session with a 10-minute freshness window
  (`OAUTH_PROJECT_SELECTION_MAX_AGE_MS`, generous vs the 600s authorization
  code lifetime). A later connection from a new client re-enters
  `/project-access`.
- Removed the dead mint-time `deleteOAuthProjectSelectionsByUserId` call;
  stale rows are swept opportunistically in `storeOAuthProjectSelection`
  (`deleteStaleOAuthProjectSelections`).
- Deleted the stale 13:34Z selection row from the preview-4 auth DB.

Retest expectation: reconnecting Grok should now show the project
select/create page during OAuth, then list tools scoped to the chosen
project.

## Current Best Hypotheses

### Hypothesis A: Grok Sends The Wrong Token In The Authorization Header

Evidence:

- Token is 32 characters and opaque.
- Direct lookup in Better Auth `oauthAccessToken` returns `not_found`.
- Working zero-trust server uses sealed access tokens and does not rely on
  Better Auth DB lookup.

What to check next:

- Log token fingerprints at the auth token endpoint and OS resource endpoint.
- Never log raw tokens.
- Example: SHA-256 hash prefix of access token values only.
- Compare:
  - token issued by auth `/oauth2/token`
  - token later sent by Grok to MCP

If fingerprints differ, Grok is not sending the access token that auth issued.

### Hypothesis B: Better Auth Stores A Hashed/Transformed Access Token

Evidence:

- Better Auth source needs a final check around storage format.
- The schema column is named `token`, but storage may not equal presented
  token.

What to check next:

- Inspect Better Auth token creation path for opaque tokens.
- Query preview auth DB shape/counts without exposing token values.
- Compare safe hashes from DB rows and request bearer token.

### Hypothesis C: Grok Is Sending A Refresh Token Or Code

Evidence:

- Token is opaque and 32 characters.
- It is not in `oauthAccessToken`.

What to check next:

- Add internal diagnostic lookup against:
  - `oauthAccessToken`
  - `oauthRefreshToken`
  - `oauthConsent`
  - maybe dynamic client rows
- Return/log only safe match type and hash prefix.

### Hypothesis D: Wrong Auth Environment

Evidence:

- OS is introspecting `auth.iterate-preview-4.com`.
- OAuth UI was also expected to be preview 4, but this should be verified from
  auth logs.

What to check next:

- Tail auth worker during Grok OAuth.
- Log dynamic client registration, authorize, token exchange, and token issue
  events with safe correlation/fingerprint.
- Confirm the token endpoint hit is on preview 4 auth.

### Hypothesis E: Grok Did Not Actually Exchange The Code For An Access Token

Evidence:

- User sees "OAuth successful" in Grok UI, but resource call token is not found.
- Grok may treat browser auth redirect success as OAuth success even if token
  exchange failed or used different storage.

What to check next:

- Tail auth worker and inspect `/oauth2/token` calls.
- Add safe token endpoint logging or Better Auth hooks if possible.
- Confirm token issuance occurred after the authorization code flow.

## Recommended Next Debug Steps

### Step 1: Add Safe Token Fingerprint Logging In Auth

Add logs around:

- dynamic client registration
- authorize entry
- consent/post-login/project-access decisions
- token endpoint exchange result
- access-token creation

Safe fields only:

- event name
- client id
- redirect URI origin/path
- requested scopes
- resource parameter if available
- reference id presence/type, not full value
- token fingerprint:
  - `sha256(token).slice(0, 12)` or similar
  - never raw token
- token table id
- user id
- session id presence

Goal:

- Determine whether auth issued the token Grok later sends.

### Step 2: Add Multi-Table Opaque Token Diagnostics

For debug endpoints only, when an opaque bearer token is not found in
`oauthAccessToken`, check safe match presence in:

- `oauthAccessToken`
- `oauthRefreshToken`
- possibly `oauthConsent`

Log only:

- `accessTokenMatch: true/false`
- `refreshTokenMatch: true/false`
- hash prefix

Goal:

- Determine whether Grok is sending a refresh token or another OAuth artifact.

### Step 3: Tail Auth Worker During Repro

Current tailing has focused on OS.

Need to also tail:

- auth preview 4 worker

Goal:

- Correlate OAuth browser flow with later OS MCP calls.
- Confirm token endpoint requests and response status.

### Step 4: Try A Same-Origin Auth Debug Variant

The working reference server has resource server and authorization server on
the same origin/path family.

Possible compatibility experiment:

- Add a debug endpoint whose protected-resource metadata points to an MCP-host
  same-origin authorization-server metadata shim.
- The shim proxies or mirrors `auth.iterate-preview-4.com/api/auth` metadata.

Goal:

- Test whether Grok's token handling breaks with split/pathful issuer.

### Step 5: Try A Stateless Sealed Token Debug Endpoint

Add a debug MCP endpoint that uses the zero-trust pattern:

- same-origin auth
- dynamic registration
- sealed client id
- sealed auth code
- sealed access token
- no auth database
- no Better Auth

Goal:

- Determine whether the problem is Better Auth/Grok interop rather than MCP
  transport.

This is more work, but the working reference strongly suggests it would isolate
the issue.

### Step 6: Inspect Better Auth Upgrade Path

Better Auth docs/source suggested newer versions improve OAuth provider
introspection/resource-server behavior.

Need to evaluate:

- `better-auth` current latest/beta version
- `@better-auth/oauth-provider` current latest/beta version
- migration impact
- whether 1.7 or beta stores/passes resource/audience for opaque tokens
- whether resource-server introspection across clients is supported

Do not upgrade blindly in production. It is reasonable to try on preview.

## Files Changed In PR 1588

Important MCP/auth files:

- `apps/os/src/domains/inbound-mcp-server/mcp-handler.ts`
- `apps/os/src/domains/inbound-mcp-server/mcp-debug-handler.ts`
- `apps/os/src/domains/inbound-mcp-server/mcp-auth-metadata.ts`
- `apps/os/src/domains/inbound-mcp-server/mcp-handler.test.ts`
- `apps/os/src/workers/ingress.test.ts`
- `apps/auth-contract/src/index.ts`
- `apps/auth-contract/tsconfig.json`
- `apps/auth/src/server/orpc/routers/internal.ts`
- `apps/auth/src/server/db/queries/oauth-client.sql`
- `apps/auth/src/server/db/queries/.generated/oauth-client.sql.ts`
- `apps/auth/src/server/db/queries/.generated/queries.ts`
- `apps/auth/sqlfu.config.ts`
- `apps/auth/package.json`
- `pnpm-lock.yaml`

## Useful Log Snippets

Latest `oauth-verify-mcp-base` token attempt after `d16e607`:

```json
{
  "method": "POST",
  "url": "https://mcp.iterate-preview-4.com/api/mcp/debug/oauth-verify-mcp-base",
  "userAgent": "grok-connectors-manager/0.1.0",
  "event": "token_verify_attempt",
  "variant": "oauth-verify-mcp-base",
  "authMode": "verify-bearer",
  "acceptedAudiences": [
    "https://mcp.iterate-preview-4.com",
    "https://mcp.iterate-preview-4.com/",
    "https://os.iterate-preview-4.com/api/mcp"
  ],
  "tokenShape": {
    "length": 32,
    "partCount": 1,
    "looksJwt": false,
    "header": null,
    "jwt": null
  }
}
```

Internal lookup result:

```json
{
  "method": "POST",
  "url": "https://mcp.iterate-preview-4.com/api/mcp/debug/oauth-verify-mcp-base",
  "userAgent": "grok-connectors-manager/0.1.0",
  "event": "opaque_internal_introspection_inactive",
  "variant": "oauth-verify-mcp-base",
  "reason": "not_found"
}
```

Final failure:

```json
{
  "method": "POST",
  "url": "https://mcp.iterate-preview-4.com/api/mcp/debug/oauth-verify-mcp-base",
  "userAgent": "grok-connectors-manager/0.1.0",
  "event": "token_verify_failed",
  "variant": "oauth-verify-mcp-base",
  "authHeaderPresent": true,
  "bearerTokenPresent": true,
  "acceptedAudiences": [
    "https://mcp.iterate-preview-4.com",
    "https://mcp.iterate-preview-4.com/",
    "https://os.iterate-preview-4.com/api/mcp"
  ],
  "tokenShape": {
    "length": 32,
    "partCount": 1,
    "looksJwt": false,
    "header": null,
    "jwt": null
  }
}
```

## Current Status

As of `2026-07-02T15:56Z`:

- Preview 4 is live at `d16e607`.
- Simple MCP debug endpoints work in Grok.
- OAuth-required dummy endpoints can work.
- Verification endpoints still fail.
- Grok sends opaque 32-character bearer tokens.
- Internal auth lookup returns `not_found`.
- The next highest-value work is to instrument auth token issuance and compare
  safe token fingerprints between auth and OS.
