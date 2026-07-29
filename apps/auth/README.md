# Auth

Iterate's identity provider and organization/project directory. One Cloudflare
Worker per environment (`auth-prd`, `auth-dev-global`, `auth-preview-N`), served at
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
| oRPC service API       | `/api/orpc/*` on the public hostname          | The auth UI, CLI, deploy-time Node scripts         | Session cookie, bearer token, or `x-iterate-service-token` |
| Workers RPC            | Cloudflare `AUTH` service binding             | OS workers only                                    | Possession of the same-account binding                     |

The entrypoint that ties them together is in `src/server/worker.ts`. The
default `AuthWorker extends WorkerEntrypoint` delegates `fetch` to the Hono app
and implements the Workers RPC methods. Public requests can invoke only
`fetch`; OS receives an RPC stub because its deployment holds the required
same-account `AUTH` service binding. The binding intentionally omits an
`entrypoint` selector, which targets the worker's default export.

Using the default entrypoint is deliberate. Auth has one internal capability
role, and every OS caller holding `AUTH` receives the same complete typed
contract. A named entrypoint would add another exported surface and a binding
selector without narrowing that authority. Cloudflare explicitly supports
[`fetch` alongside RPC methods on a default `WorkerEntrypoint`](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/),
with [`fetch` reserved for HTTP dispatch](https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/).
If Auth later needs independently grantable RPC roles, that is the point to
split them into named entrypoints. Project-controlled workers never receive
`AUTH`; their generated bindings expose only project-scoped capabilities such
as `ITX`.

Static assets + SSR still work: asset routing happens at the edge before `fetch` is invoked, and
`run_worker_first: ["/api/*"]` (in the generated `wrangler.jsonc`) sends API
paths to the worker.

### 1. OIDC / OAuth2 provider — `/api/auth/*`

better-auth's `oauthProvider` plugin (configured in `src/server/auth-plugins.ts`)
serves discovery, `authorize`, `token`, `jwks`, `userinfo`, revocation, and
device-authorization under the `/api/auth` issuer path. This is the **only**
surface most consumers see, and it must stay on the public hostname —
browsers, the CLI, and third-party OAuth/MCP clients cannot hold service
bindings.

Relying parties consume it through **`@iterate-com/auth/server`**, the narrow
public surface declared in `src/lib/server-public.ts`.
It runs _inside the relying party's worker_ (apps/os, apps/auth-example), does
the authorization-code + PKCE dance, verifies JWTs, refreshes tokens
(single-flighted per worker isolate to collapse concurrent use of one refresh token), and
manages the session cookie. See the concise
[`relying-party auth guide`](docs/relying-party-auth.md) and the working example
app below.

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
(apps/auth-contract) and implemented in `src/server/orpc/`. It carries every
call into the auth worker that isn't the OIDC protocol or a browser page:

- **The auth UI itself** (session cookie) — org/project CRUD, `user.myOrganizations`, the project-access selection store.
- **The `iterate` CLI** (bearer token from the device/OAuth flow) — `user.myOrganizations`.
- **Deploy-time Node scripts** (`x-iterate-service-token`) — the `internal.oauth.*` client-provisioning procedures and the `internal.user`/`internal.organization` test-seeding procedures.

Two role namespaces run through the middlewares in `src/server/orpc/orpc.ts`;
they are easy to confuse, so they're documented there:

- `session.user.role === "admin"` is the **platform** admin (better-auth admin
  plugin) — bypasses every membership check.
- `membership.role` is scoped to one organization — `owner | admin | member`.

### 4. Workers RPC — the `AUTH` service binding

OS's runtime-only privileged operations are RPC methods on auth's default
`AuthWorker`: project creation, slug lookup, user-project membership,
project-id minting, project-app session issuance/validation, and opaque OAuth
token introspection. Its shared base class
is the `/worker` export of `@iterate-com/auth-contract`; implementation lives in
`src/server/project-directory.ts` and `src/server/oauth-token-introspection.ts`.

There is deliberately no HTTP route or bearer-token fallback for these
methods. Every OS environment declares a required binding to the matching auth
worker in its generated Wrangler config. Cloudflare creates the RPC stub only
for a worker deployment carrying that binding, so the binding is both
transport and credential. Inputs are still parsed because OS and auth versions
can be briefly skewed during rollout.

## How it fits with apps/os

OS has no database. It leans on the auth worker in three distinct ways:

```
                         apps/os worker
                    ┌──────────┴──────────┐
      public OIDC    │                     │ private Workers RPC
      issuer         ▼                     ▼ AUTH binding
  auth host `/api/auth/*`             auth default `AuthWorker`
  authorize/token/jwks                project directory +
  userinfo/revoke                     token introspection
```

**(a) Login & tokens — OIDC on the public hostname.** OS is an OAuth client of
auth. `apps/os/src/auth/iterate-auth-client.ts` wires `@iterate-com/auth/server`
with the issuer/clientId/clientSecret from OS's config; login redirects go to
`auth.iterate.com/api/auth/oauth2/authorize`, and OS's middleware verifies the
resulting session/bearer tokens. Users with no organization are redirected to
auth's `/project-access` page. The MCP server advertises auth as its
authorization server.

**(b) JWT verification — one Doppler-owned signing key.** Auth's Better Auth
JWT adapter signs with `AUTH_FORGE_PRIVATE_JWK`. OS, Semaphore, and Streams
derive only its public half during deploy and verify locally; they neither wait
for Auth's live JWKS nor fall back to it at runtime. `pnpm auth:mint` uses the
same private key, so minted and Auth-issued tokens have one trust path.

**(c) Runtime authority — Workers RPC behind a KV cache.** OS ingress resolves
every project host (`<slug>.iterate.app`) to a project id. The
`AUTH.getProjectBySlug()` binding method is the source of truth;
`apps/os/src/project-directory.ts` puts a `PROJECT_DIRECTORY` KV cache in front
so the hot path rarely pays the round-trip. Project creation and the stale-
claims membership check use the same binding, while MCP uses it to introspect
opaque access tokens. OS decides _which_ organization may own a new project
from the caller's verified claims before calling auth. These RPC methods trust
the OS binding and intentionally perform no second user authorization step.

## Trust model

- A **session cookie** identifies a human; oRPC middlewares layer org/project
  membership checks on top.
- The **`AUTH` service binding** is the credential for OS runtime calls. OS does
  not receive `APP_CONFIG_SERVICE_AUTH_TOKEN` or an equivalent auth-wide secret.
- The auth-side **service token** (`APP_CONFIG_SERVICE_AUTH_TOKEN` in Doppler)
  remains a shared secret for public `internal.*` oRPC procedures used by
  deploy and test-seeding scripts, which cannot hold a Workers binding. It also
  doubles as the seeded bootstrap admin's password
  (`scripts/render-admin-seed.ts` writes that credential row), allowing those
  scripts to reach better-auth admin APIs that insist on a session.

## Identity model

- **Users** sign in with Google or email OTP (enabled by default in every
  stage; `APP_CONFIG_EMAIL_OTP_ENABLED=false` is the rollback switch);
  password signup is disabled.
  `APP_CONFIG_SIGNUP_ALLOWLIST` gates who may sign up;
  `APP_CONFIG_ADMIN_ALLOWLIST` (default `*@nustom.com`) promotes matching emails
  to platform admin. `APP_CONFIG_FIXED_TEST_OTP_ENABLED` controls the fixed
  `424242` OTP for `+test@nustom.com` automation addresses; production sets it
  to false in `envs.ts`. The full model is documented in
  `src/server/platform-admin.ts`.
- **Organizations & projects** live in auth's D1 and are the durable source of
  truth. OS keeps per-environment rows and re-adopts from auth after a reset;
  `src/server/project-directory.ts` implements the adoption/conflict rules (same
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
  the Doppler sync script (`apps/os/scripts/sync-auth-clients.ts`). Note the
  documented dev-referenceId special case — a dev client is only _kept_ when
  matched by the caller's own client id, else it rotates, otherwise a db reset
  would hand back a clientId paired with an unrelated (unverifiable) secret.
- **`setClient`** — caller-provided credentials; the caller's Doppler config is
  the source of truth, so re-running is a no-op and nothing ever rotates a
  seeded client. Used by the post-deploy seed (`scripts/seed-oauth-clients.ts`).

## Development

```bash
pnpm dev              # doppler(auth/dev) + vite dev, serves on :7101
pnpm routes:generate  # regenerate src/routeTree.gen.ts after adding a route
pnpm db:generate      # regenerate sqlfu query types after editing db/queries/*.sql
pnpm typecheck        # routes:check + tsgo
```

`src/server/db/` holds the sqlfu schema (`definitions.sql`), raw SQL queries
(`queries/*.sql`, codegen'd into `.generated/`), and migrations. Regenerate
after any schema/query edit.

### Configuration

Auth uses the same typed-config mechanism as apps/os. `src/config.ts` declares
an `AppConfig` zod schema (`redacted()` secrets, `publicValue()` browser-safe
fields); the worker's `APP_CONFIG_*` bindings are the env's Doppler secret
names verbatim (e.g. `APP_CONFIG_BETTER_AUTH_SECRET`) plus env-shaped vars
generated from the root `envs.ts` (e.g. `APP_CONFIG_AUTH_APP_ORIGIN`). Server
code reads `config.*` (from `server/env.ts`'s `parseConfig(env)`), never raw
`env.*`. The browser bundle's own origin is inlined from
`APP_CONFIG_AUTH_APP_ORIGIN` at build time.
Email OTP sends through the Cloudflare Email Service `EMAIL` binding; the
sender domain comes from `APP_CONFIG_EMAIL_SENDER_DOMAIN`, which must be
onboarded/verified in Email Service (deploys fail fast when it is missing
while OTP is enabled).

## Deployment

`pnpm run deploy --env <name>` (`scripts/deploy.ts`) runs, in order: D1
migrations + the admin-seed SQL, `vite build`, `wrangler deploy` with the env's
Doppler secrets shipped atomically via `--secrets-file`, a JWKS smoke probe,
then the declarative OAuth client seed (`scripts/seed-oauth-clients.ts`, driven
by `AUTH_SEED_OAUTH_CLIENTS`).

Each preview slot has its own auth worker (`auth-preview-N`). The preview
orchestrator expands relying-party changes to include auth, then deploys every
selected app concurrently. A local manual deployment is still available with
`pnpm run deploy --env preview_N`, but it is not the normal preview path.

For the first deployment of a brand-new environment, create Auth before OS so
Cloudflare can resolve OS's service binding. Once both workers exist, the fixed
signing key removes JWT deployment sequencing. Breaking RPC interface changes
still need their own coordinated rollout; additive changes do not.

Production uses `.depot/workflows/deploy-os.yml` as the single coordinated
Cloudflare platform rollout. It checks out one revision, reconciles the Alchemy
stack once, then deploys Auth, Semaphore, and OS in order. Every dispatch uses
one fixed, non-cancelling concurrency group because the stack and Workers are
the same even when the requested Git ref differs.
`.depot/workflows/deploy-auth.yml` owns only the shared development Auth
worker. Do not add a second production job: independent workflows can race
Alchemy applies or leave OS bound to an incompatible revision.

Every OS deploy now treats the removed
`APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN` as a forbidden invariant. Before any
sidecar or OS version is uploaded, it fails unless the resolved Doppler config
and the current Worker's secret bindings both omit that name. This check is
deliberately non-mutating: an operator must remove resurrected credential state
explicitly and then retry. After deployment, OS forces a fresh project-host
lookup through `AUTH`; the random slug bypasses KV and in-isolate negative
caches, and the probe requires OS's exact JSON 404 body, so an edge-level 404
cannot produce a false green.

The one-release preview-fleet cutover completed on 2026-07-14. All nine slots
deployed Auth before OS, passed fresh RPC lookup probes, and finished with the
retired OS token absent from both the live Worker bindings and Doppler. The
temporary fleet workflow and global concurrency gate were removed after that
verification. Normal preview deploy and cleanup jobs are again serialized per
PR, and ordinary slot acquisition never force-evicts another lifecycle's
lease. The preview CI workflow retains `scripts/preview/deployment-epoch` as a
pre-deploy floor: a stale PR branch fails before Auth can be rolled back and
must rebase. A direct manual deployment from an old checkout bypasses that CI
guard and is unsupported; operators must deploy previews from current `main`.
Config provisioning and OAuth-client sync do not mutate forbidden credential
state.

The coordinated workflow sets `ALLOW_REMOTE_PRODUCTION_AUTH_RPC=1` while
generating OS's complete Wrangler config. A manual production OS deployment
must set the same explicit guard; local processes otherwise fail closed rather
than acquiring production write authority from a Doppler issuer accidentally.

This migration shipped without compatibility routes, token fallback, or a
dual-read period. The first production rollout was a short maintenance cutover:
Auth deployed first, then the coordinated job immediately replaced the old OS
revision that could no longer call the removed HTTP procedures. Future
additive RPC methods can deploy Auth first without interrupting the previous
OS revision.

**Gotchas that have bitten before:**

- The worker needs the `global_fetch_strictly_public` compatibility flag —
  same-zone SSR self-fetches otherwise bypass Worker routes and hang ~20s (see
  the comment in `scripts/generate-wrangler-config.ts`).
- Never return the raw better-auth session from a TanStack server function or
  loader (`session.token` leak — `src/routes/_auth.tsx`).
- OAuth client secrets are hashed at rest — hence the `ensureClient`/`setClient`
  split above.

## The auth example app

`apps/auth-example` is a small reference relying party (`src/worker.ts`): a
Hono worker that composes `@iterate-com/auth/server` through the same
`auth.fetch(request)` partial-fetch method used by first-party request
middleware, then protects `/api/protected` with `.authenticateSession()`. It
applies the returned response headers so refresh-token rotation is atomic from
the browser's perspective.
It exercises the exact same OIDC surface OS uses, so it's the cheapest end-to-end
check that a change to the auth worker didn't break relying parties. It talks
_only_ to surface 1 (the public OIDC provider) — nothing in it depends on the
oRPC service API. Deployed at `auth-example.iterate.app`
(and `auth-example.iterate-preview-N.app` per slot); configure it with an OAuth
client minted at `/admin/clients` (see `.env.example`).
