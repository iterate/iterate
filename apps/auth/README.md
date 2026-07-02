# Auth

Iterate's identity provider and organization/project directory. One Cloudflare
Worker per environment (`auth-prd`, `auth-dev`, `auth-preview-N`), served at
`auth.iterate.com` / `auth.iterate-dev.com` / `auth.iterate-preview-N.com`.

Built on [better-auth](https://better-auth.com) with the
[`@better-auth/oauth-provider`](https://github.com/better-auth/oauth-provider)
plugin (so Iterate _is_ an OAuth2/OIDC provider — apps/os and the CLI are just
relying parties), D1 for storage (via [sqlfu](https://github.com/mmkal/sqlfu)),
and a TanStack Start UI for the sign-in / consent / account screens.

It answers three questions for the rest of the platform:

- **Who is this?** — sign-in (Google, email OTP) and OIDC tokens with Iterate's
  custom claims.
- **What can they reach?** — organizations, projects, and the OAuth-time
  "which projects may this token touch" selection.
- **Does this project exist / what's its id?** — auth owns the org/project
  tables and is the sole minter of the `prj_` id space; OS has no database of
  its own and treats auth as its project directory.

## The four surfaces

One worker, four ways in — each with its own credential. Keeping them straight
is the single most important thing to understand about this app.

| Surface                | Transport                                     | Callers                                            | Credential                                                 |
| ---------------------- | --------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| OIDC / OAuth2 provider | `/api/auth/*` on the public hostname          | Browsers, OS login, the `iterate` CLI, MCP clients | The protocol's own (auth codes, PKCE, client secrets)      |
| UI                     | all other paths (TanStack Start SSR + assets) | Humans                                             | better-auth session cookie                                 |
| oRPC service API       | `/api/orpc/*` on the public hostname          | The auth UI, the CLI, deploy-time Node scripts     | Session cookie, bearer token, or `x-iterate-service-token` |
| Workers RPC            | service binding (no URL)                      | OS workers at runtime                              | Holding the `AUTH` binding                                 |

The entrypoint that ties them together is `src/server/worker.ts` — a
`WorkerEntrypoint` class whose `fetch` runs the Hono app (surfaces 1–3) and
whose named methods are surface 4:

```ts
export default class AuthWorker extends WorkerEntrypoint<CloudflareEnv> implements AuthWorkerRpc {
  override fetch(request: Request) { return app.fetch(request, this.env, this.ctx); }
  createProjectForOrganization(input) { ... }   // Workers RPC — see below
  getProjectBySlug(input) { ... }
  listProjectsForUser(input) { ... }
  mintProjectId() { ... }
}
```

Extending `WorkerEntrypoint` is what makes the RPC methods callable over a
binding — a plain `export default { fetch }` object cannot expose RPC. Static
assets + SSR still work: asset routing happens at the edge before `fetch` is
invoked, and `run_worker_first: ["/api/*"]` (in `alchemy.run.ts`) sends the API
paths to the worker.
[Service bindings + RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/).

### 1. OIDC / OAuth2 provider — `/api/auth/*`

better-auth's `oauthProvider` plugin (configured in `src/server/auth-plugins.ts`)
serves discovery, `authorize`, `token`, `jwks`, `userinfo`, revocation, and
device-authorization under the `/api/auth` issuer path. This is the **only**
surface most consumers see, and it must stay on the public hostname —
browsers, the CLI, and third-party OAuth/MCP clients cannot hold service
bindings.

Relying parties consume it through **`@iterate-com/auth/server`**
(`src/lib/server.ts`), a small OIDC relying-party library this package exports.
It runs _inside the relying party's worker_ (apps/os, apps/auth-example), does
the authorization-code + PKCE dance, verifies JWTs, refreshes tokens
(single-flighted so a rotated refresh token is never presented twice), and
manages the session cookie. See "How it fits with apps/os" and "The auth
example app" below.

### 2. UI — everything else

TanStack Start (SSR on Workers) renders the human-facing screens; the Hono app
in `worker.ts` falls through to it for any path that isn't `/api/*`. Routes
live in `src/routes/`:

| Route                                       | Purpose                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`                                    | Google / email-OTP sign-in; also the "continue as / switch account" step inside an OAuth authorize flow (the `sig` search param marks that flow). |
| `/consent`                                  | "Allow _App_ to use your account?" scope grant.                                                                                                   |
| `/project-access`                           | The OAuth-time project-selection flow (see "Identity model").                                                                                     |
| `/` (`_auth/index`)                         | Account page + authorized-apps list.                                                                                                              |
| `/projects` + `/projects/$organizationSlug` | Organization & project management (deep-linkable).                                                                                                |
| `/device`                                   | CLI device-authorization approval.                                                                                                                |
| `/admin/clients`                            | Platform-admin OAuth client management.                                                                                                           |

The router (`src/router.tsx`) follows the same conventions as apps/os:
registered router for typed navigation, scroll restoration, shared
error/not-found components, and a `routes:check` in `pnpm typecheck` that fails
if the checked-in `routeTree.gen.ts` is stale. Route files never return the raw
better-auth session to the client — `session.token` is the bearer-equivalent of
the HttpOnly cookie, so server functions expose only display fields
(`src/routes/_auth.tsx`).

### 3. oRPC service API — `/api/orpc/*`

Typed API defined by the contract in **`@iterate-com/auth-contract`**
(apps/auth-contract) and implemented in `src/server/orpc/`. It exists for
callers that can only speak HTTP:

- **The auth UI itself** (session cookie) — org/project CRUD, `user.myOrganizations`, the project-access selection store.
- **The `iterate` CLI** (bearer token from the device/OAuth flow) — `user.myOrganizations`.
- **Deploy-time Node scripts** (`x-iterate-service-token`) — the `internal.oauth.*` procedures that provision OAuth clients.

Two role namespaces run through the middlewares in `src/server/orpc/orpc.ts`;
they are easy to confuse, so they're documented there:

- `session.user.role === "admin"` is the **platform** admin (better-auth admin
  plugin) — bypasses every membership check.
- `membership.role` is scoped to one organization — `owner | admin | member`.

### 4. Workers RPC — the `AUTH` service binding

The methods on the `AuthWorker` entrypoint, called by OS workers over a
Cloudflare service binding instead of the public internet. The contract is the
**`AuthWorkerRpc`** interface (also in `@iterate-com/auth-contract`); the
implementation is `src/server/project-directory.ts`:

- `getProjectBySlug` — slug → project record, for OS ingress host resolution and directory reads.
- `createProjectForOrganization` — create (or re-adopt) a project owned by an org; auth mints the `prj_` id.
- `listProjectsForUser` — every project a user can reach via org membership; OS uses it for the stale-claims window right after a create.
- `mintProjectId` — a bare `prj_` id with no owning org, for OS operator/recovery creates.

**Trust model:** a service binding can only be attached by a deploy into the
same Cloudflare account, so _holding the binding is the authorization_ — there
is no token on these calls (they replaced HTTP calls that carried
`x-iterate-service-token`, minus the secret to leak). Callers do their own
user-level authorization first: OS decides _which_ organization may own a new
project from the caller's verified JWT claims, then asks auth to create it.

## How it fits with apps/os

OS has no database. It leans on the auth worker in four distinct ways, over two
transports:

```
                         apps/os worker(s)
      ┌───────────────────────┼──────────────────────────┐
      │ (a) OIDC protocol      │ (d) Workers RPC           │
      │  @iterate-com/auth/    │  env.AUTH.getProjectBySlug │
      │  server, public host   │  ...createProjectFor...    │
      ▼                        │  ...listProjectsForUser    │
  auth.iterate.com/api/auth    │  ...mintProjectId          │
   authorize/token/jwks/       ▼
   userinfo/revoke        auth-<stage> (service binding, no hostname)
```

**(a) Login & tokens — OIDC on the public hostname.** OS is an OAuth client of
auth. `apps/os/src/auth/iterate-auth-client.ts` wires `@iterate-com/auth/server`
with the issuer/clientId/clientSecret from OS's config; login redirects go to
`auth.iterate.com/api/auth/oauth2/authorize`, and OS's middleware verifies the
resulting session/bearer tokens. Users with no organization are redirected to
auth's `/project-access` page. The MCP server advertises auth as its
authorization server.

**(b) JWT verification — a JWKS baked at OS deploy time.** OS verifies
auth-issued tokens against a JWKS. To avoid a runtime round-trip on every cold
isolate, `apps/os/alchemy.run.ts` fetches `${issuer}/jwks` at _deploy_ time and
bakes it into OS's config (falling back to a runtime remote-JWKS fetch if that
fails). **Consequence: rotating auth's signing keys requires an OS redeploy.**
The forge public key (for `pnpm auth:mint`) is merged into this baked JWKS.

**(c) The project directory — RPC behind a KV cache.** OS ingress resolves
every project host (`<slug>.iterate.app`) to a project id. `getProjectBySlug`
is the source of truth; `apps/os/src/project-directory.ts` puts a
`PROJECT_DIRECTORY` KV cache in front so the hot path rarely pays the RPC.
Project creation (`createProjectForOrganization` / `mintProjectId`) and the
stale-claims membership check (`listProjectsForUser`, in
`apps/os/src/auth.ts` — using the same query the token's project claims are
minted from) go over the same binding.

**(d) The binding is required.** OS cannot log anyone in or resolve a project
host without a live auth worker, so `apps/os/alchemy.run.ts` binds `auth-<stage>`
as `AUTH` on **every** OS worker with no fallback. A brand-new environment must
therefore **deploy auth before OS** — if `auth-<stage>` doesn't exist,
Cloudflare rejects the OS deploy, which is the intended loud failure. In OS
_local_ dev the binding is a
[remote binding](https://developers.cloudflare.com/workers/local-development/#remote-bindings):
the code still calls `env.AUTH.method()`, but wrangler/vite proxy the call
(fetch _and_ RPC) to the deployed auth worker for the stage. Running
`apps/auth` locally (a loopback issuer) instead resolves the binding through
the local dev registry. This required a small extension to the repo's alchemy
patch (`patches/alchemy@0.83.3.patch`) so generated wrangler configs emit
`remote: true` for a service binding carrying `dev.remote`.

The OS↔auth code lives in `apps/os/src/auth/auth-worker-service.ts` (the
`authWorker()` binding accessor) and `apps/os/src/auth/iterate-auth-client.ts`
(the OIDC relying-party wiring). OS's own README has more on how the auth worker
sits in its architecture.

## Trust model

- A **session cookie** identifies a human; oRPC middlewares layer org/project
  membership checks on top.
- The **service token** (`SERVICE_AUTH_TOKEN`) is a deploy-time-only shared
  secret. It also doubles as the seeded bootstrap admin's password
  (`scripts/render-admin-seed.ts` writes that credential row), which is how
  deploy scripts reach better-auth admin APIs that insist on a session.
- The **service binding is itself the credential** for runtime OS→auth calls —
  no secret ships in OS worker config.

## Identity model

- **Users** sign in with Google or email OTP (dev/preview always; prod behind
  `VITE_ENABLE_EMAIL_OTP_SIGNIN`); password signup is disabled. `SIGNUP_ALLOWLIST`
  gates who may sign up; `ADMIN_ALLOWLIST` (default `*@nustom.com`) promotes
  matching emails to platform admin. The full model is documented in
  `src/server/platform-admin.ts`.
- **Organizations & projects** live in auth's D1 and are the durable source of
  truth. OS keeps per-environment rows and re-adopts from auth after a reset;
  `src/server/project-slugs.ts` documents the adoption/conflict rules (same
  slug + same org = adopt; same slug + other org = conflict; slugs never get
  random suffixes so OS can recreate the exact slug).
- **Tokens** carry Iterate's custom claims (orgs, projects, admin flag),
  declared in `@iterate-com/shared/auth-claims` and minted in
  `src/server/auth-plugins.ts`. Access tokens are authorized against by
  resource servers (OS); ID tokens + userinfo carry login-time identity.
- **Project-scoped tokens.** When a client requests the `project` scope, the
  user picks which projects the token may reach on `/project-access`. That
  choice makes a three-step trip from UI to token minting — documented in full
  in `src/server/oauth-project-selection.ts`.

## OAuth client provisioning

Client secrets are stored SHA-256-hashed (the oauth-provider plugin's scheme),
so "read back an existing secret" is impossible by design. That asymmetry
drives the two `internal.oauth.*` procedures in
`src/server/orpc/routers/internal.ts`:

- **`ensureClient`** — server generates/rotates the secret; identified by a
  stable `referenceId` (e.g. `os:dev_jonas:web`). If the caller still holds a
  valid secret and nothing changed, it's a no-op; otherwise it rotates. Used by
  the OS dev-stage bootstrap (`apps/os/src/auth/dev-oauth-client-bootstrap.ts`)
  and the Doppler sync script (`apps/os/scripts/sync-auth-clients.ts`). Note the
  documented dev-referenceId special case — a dev client is only _kept_ when
  matched by the caller's own client id, else it rotates, otherwise a db reset
  would hand back a clientId paired with an unrelated (unverifiable) secret.
- **`setClient`** — caller-provided credentials; the caller's Doppler config is
  the source of truth, so re-running is a no-op and nothing ever rotates a
  seeded client. Used by the post-deploy seed (`scripts/seed-oauth-clients.ts`).

## Development

```bash
pnpm dev              # doppler(auth/dev) + alchemy dev, serves on :7101
pnpm routes:generate  # regenerate src/routeTree.gen.ts after adding a route
pnpm db:generate      # regenerate sqlfu query types after editing db/queries/*.sql
pnpm typecheck        # routes:check + tsgo
```

`src/server/db/` holds the sqlfu schema (`definitions.sql`), raw SQL queries
(`queries/*.sql`, codegen'd into `.generated/`), and migrations. Regenerate
after any schema/query edit.

## Deployment

`alchemy.run.ts` runs, in order: D1 migrations + the admin-seed SQL, the worker,
proxied DNS for every `WORKER_ROUTES` hostname, then the declarative OAuth
client seed (`scripts/seed-oauth-clients.ts`, driven by
`AUTH_SEED_OAUTH_CLIENTS`) against the immediately-live workers.dev URL.

Each preview slot needs its own auth worker (`auth-preview-N`) — no pipeline
deploys it; it's a manual `pnpm alchemy:up` with the slot's stage/route/secret
env. See the repo's preview-slot notes.

**Gotchas that have bitten before:**

- The worker needs the `global_fetch_strictly_public` compatibility flag —
  same-zone SSR self-fetches otherwise bypass Worker routes and hang ~20s (see
  the comment in `alchemy.run.ts`).
- Never return the raw better-auth session from a TanStack server function or
  loader (`session.token` leak — `src/routes/_auth.tsx`).
- OAuth client secrets are hashed at rest — hence the `ensureClient`/`setClient`
  split above.

## The auth example app

`apps/auth-example` is a ~30-line reference relying party (`src/worker.ts`): a
Hono worker that mounts `@iterate-com/auth/server`'s handler at
`/api/iterate-auth/*` and a `/api/protected` route that calls `.authenticate()`.
It exercises the exact same OIDC surface OS uses, so it's the cheapest end-to-end
check that a change to the auth worker didn't break relying parties. It talks
_only_ to surface 1 (the public OIDC provider) — nothing in it depends on the
service binding or the oRPC API. Deployed at `auth-example.iterate.app`
(and `auth-example.iterate-preview-N.app` per slot); configure it with an OAuth
client minted at `/admin/clients` (see `.env.example`).
