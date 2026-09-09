# Auth: one identity provider, one lane, ready for real login (2026-09-09)

Jonas's ask: the email input is where Google login will go; every MCP server — the control plane's
`/mcp` and a project's own `itx.serveMcp()` mount — must go through that flow today; the e2e lane
needs a simple way in ("maybe just an admin token, look at apps/os"); delete `open` mode; and can the
Cloudflare OAuth provider live under `/oauth`? Below: what apps/os does, what to copy in shape, the
proposal, and its counted cost.

## 1. What apps/os does today

The production platform splits identity into two workers and four credentials.

| Piece | Where | Shape |
|---|---|---|
| The identity provider | `apps/auth` — better-auth + `@better-auth/oauth-provider`, TanStack UI, D1 | Google + email OTP sign-in; an OIDC issuer at `https://auth.iterate.com/api/auth` (`/login`, `/consent`, `/project-access`, `/device`); owns users, orgs, projects; the sole minter of `prj_` ids |
| The relying party | `apps/os` via `@iterate-com/auth/server` | the authorization-code + PKCE dance, JWT verification against the issuer's JWKS, the `iterate_session` cookie, single-flighted refresh |
| The admin secret | `APP_CONFIG_ADMIN_API_SECRET`, `apps/os/src/auth/admin.ts` | `Authorization: Bearer <secret>` on `/api` ⇒ the admin principal (may reach any project). The CLI, the e2e lane and tooling use it; the e2e client's one line is `auth: { type: "admin-secret", secret }` |
| The impersonate lane | `apps/os/src/auth.ts` `ItxAuthCredentials` | admin-secret-gated fake principal `{ type: "user", principal, projectScopes }` so suites test user-vs-user confinement without minting users |
| Minted sessions | `scripts/auth/mint-session.ts` (`pnpm auth:mint`) | signs a JWT pair offline with the environment's forge key — be any user instantly; claims frozen at mint |
| The project's own key | born readable at `/secrets/project-api-key` | `{ type: "project-secret", projectSlug, secret }`: a headless app acts AS the project; compared inside the Secret DO |
| The user-on-project token | `iterate-project-auth` cookie on a project host | HS256, 15 minutes, verified locally — one user on one project; a reverse-proxied app forwards it |
| The inbound MCP server | `apps/os/src/domains/inbound-mcp-server/mcp-handler.ts` at `/api/mcp` | a resource server ONLY: 401 + `WWW-Authenticate: Bearer resource_metadata=…`, serves `/.well-known/oauth-protected-resource`, names auth's issuer in `authorization_servers`, verifies the bearer as a JWT against JWKS (or introspects an opaque token over the AUTH binding); the token's scopes carry the granted projects |

Two facts decide the shape of what follows. First, in production the **MCP server is not an
authorization server** — it is a resource that points clients at the one identity provider and
verifies what comes back. Second, the e2e lane never logs in: it bears the admin secret, and when
a test needs a specific user it impersonates one behind that same secret.

The clean room's `@cloudflare/workers-oauth-provider` has no counterpart in production. apps/os
does use it, but only as a client of *other* servers' OAuth (`itx.mcp.beginOAuth`, the connect
flows). There, it is the right tool: a self-contained AS for a worker that has no identity
provider behind it. Here, it is a placeholder for auth.iterate.com.

## 2. The proposal

**One identity provider, one lane.** The control plane's `/oauth/*` IS the identity provider for
this deployment (the placeholder for auth.iterate.com); every MCP server, the platform's and each
project's, is a resource server that points at it. Nothing else authenticates a human.

### 2.1 The provider moves under `/oauth`

Yes, and it is the common shape (the provider's own README uses `/oauth/token` and
`/oauth/register`). The endpoints are config: `authorizeEndpoint: "/oauth/authorize"`,
`tokenEndpoint: "/oauth/token"`, `clientRegistrationEndpoint: "/oauth/register"`. Two things stay
at the root by RFC, and clients find everything through them: `/.well-known/oauth-authorization-server`
(RFC 8414, lists the three endpoints) and `/.well-known/oauth-protected-resource[/<path>]`
(RFC 9728, names the authorization server). The provider serves both; nothing to build.

### 2.2 The login page is the one login page

`/login` stays the email form. It is the ONE page that establishes "who": the console, the OAuth
consent (`/oauth/authorize` requires a console session, then approve / switch account) and — through
the consent — every MCP client. When Google arrives it replaces the form's `POST /login` with the
provider's callback and nothing above it changes: the session cookie is minted the same way and the
consent reads the same cookie. `open` mode goes: the anonymous seeded user and the `/mcp` short-circuit
with it. A deployment with no login is a deployment nobody can use, which is correct.

### 2.3 Every MCP server is a resource server of that provider

- The control plane's `/mcp` already is (the provider's `apiRoute`). Unchanged.
- A project's `itx.serveMcp()` on `mcp--<projectId>.<base>` becomes one: the ingress (the lane that
  already stamps the principal) verifies the bearer as an OAuth access token — the provider exposes
  the check the `apiRoute` uses; if it does not, the token's own grant lookup in `OAUTH_KV` is a few
  lines — and answers 401 with `WWW-Authenticate: Bearer resource_metadata="https://mcp--<p>.<base>/.well-known/oauth-protected-resource"`
  when there is none; that metadata document names the platform host as the authorization server.
  An MCP client then runs the same consent flow a client of `/mcp` runs, and lands on the project
  host with a token whose props are the user. The email-mode `serveMcp` red pin closes by construction.
- Scopes: one, `project` (already declared). The consent page grants it; the token's props carry
  `{ sub, email }`; membership is checked where it is today — the directory, at the door.

### 2.4 Project tokens stay, minted by the control plane

The short-lived user-on-project token (`principal.ts`) is apps/os's `iterate-project-auth` in shape
and stays the browser lane for project hosts (`/.itx/session`) and the bearer lane for scripts. What
is missing is a minter: `Session.projects.get(id).mintToken({ ttlSeconds? })` on `/api`, membership
checked, ≈ 25 lines. Today only the e2e support can mint one, from the signing secret.

### 2.5 The e2e lane: the admin secret, exactly as apps/os

`APP_CONFIG_ADMIN_API_SECRET` (a wrangler secret; a var in the lanes). `authenticate({ adminSecret })`
on `/api` ⇒ a session whose principal is `admin` and may reach any project; `Authorization: Bearer
<secret>` on `/expression` and on a project host ⇒ the same. For confinement tests the apps/os
impersonate shape, one field: `authenticate({ adminSecret, as: { sub, email } })` ⇒ that user's
session without a login. That is the whole mechanism the lane needs; `open` mode was doing this job
badly (everyone anonymous, nothing confined).

## 3. What changes, counted

| Change | Lines | Kind |
|---|---:|---|
| `open` mode: the `LoginMode` type and var, `ANONYMOUS`, the `/mcp` short-circuit, the seeded row in the schema, the mode branches in `laneIdentityOf`, `authenticate`, the `/expression` admission, the console | ≈ −60 | DELETE |
| The provider under `/oauth` (three config strings; the console's link) | ±0 | MOVE |
| The admin secret: one config var, one check in `authenticate` and in `laneIdentityOf`, the impersonate field | ≈ +35 | ADD |
| `projects.get(id).mintToken` | ≈ +25 | ADD |
| A project host verifies an OAuth bearer and answers the 401 challenge; the protected-resource metadata for project hosts | ≈ +40 | ADD |
| The e2e support: `authenticate({ adminSecret })` replaces the minted token in `principal.ts`; the lanes set the var | ≈ −10 | REPLACE |
| Tests: the open-mode rows in `control-plane.test.ts` and `session.e2e` go; the serveMcp red pin turns green; one row per new door | ≈ +40 / −60 | |

Net ≈ +10 lines and one concept fewer (`open` mode), one hole closed, and the shape production
already has. What it does NOT do: replace the email form with a real login (that is the Google step,
on the same page), or introduce the auth worker (this deployment stays one worker; the provider is
its own identity provider until auth.iterate.com is wired in as the issuer instead).

## 4. Not copied, and why

- **Minted sessions (`auth:mint`, the forge key).** The admin secret plus impersonate covers every
  test need in ≈ 35 lines; a forge key is a second master secret.
- **The project's born API key.** The project token (2.4) is the same authority with an expiry; a
  long-lived born key is a later decision, and its "compare inside the Secret DO" needs the secrets
  layer to grow first.
- **JWT access tokens + JWKS.** The provider's tokens are opaque and verified in KV; JWTs matter
  once a SECOND worker must verify without a hop. One worker, no need yet.
- **The auth worker as a separate deployment.** Out of scope for the clean room; the design keeps
  the seam (the issuer URL is one string in the metadata) so swapping it in is a config change.

## 5. Order

1. Delete `open` mode; add the admin secret + impersonate; move the e2e lane onto it. (One commit;
   the deployed proof needs the new wrangler secret first.)
2. Move the provider under `/oauth`; add `mintToken`.
3. Project hosts as resource servers; the serveMcp pin turns green.
