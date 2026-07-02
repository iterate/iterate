# apps/auth

The platform's identity provider and organization/project directory, deployed
as one Cloudflare Worker per stage (`auth-prd`, `auth-dev`, `auth-preview-N`)
at `auth.iterate.com` / `auth.iterate-dev.com` / `auth.iterate-preview-N.com`.
Built on [better-auth](https://better-auth.com) with the
[`@better-auth/oauth-provider`](https://github.com/better-auth/oauth-provider)
plugin, D1 for storage (via [sqlfu](https://github.com/mmkal/sqlfu)), and a
TanStack Start UI.

## The four surfaces

One worker, four ways in — each with its own credential:

| Surface                | Path / transport                     | Callers                                        | Credential                                                 |
| ---------------------- | ------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------- |
| OIDC / OAuth2 provider | `/api/auth/*` (public hostname)      | Browsers, OS login, `iterate` CLI, MCP clients | The protocol's own (auth codes, PKCE, client secrets)      |
| UI                     | all other paths (TanStack Start SSR) | Humans                                         | Session cookie                                             |
| oRPC service API       | `/api/orpc/*`                        | Auth's own UI, CLI, deploy-time Node scripts   | Session cookie, bearer token, or `x-iterate-service-token` |
| Workers RPC            | service binding (no URL)             | OS workers at runtime                          | Holding the binding                                        |

- **OIDC provider** — better-auth's `oauthProvider` plugin serves discovery,
  authorize, token, JWKS, userinfo under the `/api/auth` issuer path
  (`src/server/worker.ts`, `src/server/auth-plugins.ts`). Relying parties (OS,
  the example app) consume it through `@iterate-com/auth/server`
  (`src/lib/server.ts`), which this package exports and which runs _inside
  the relying party's worker_. This surface must stay on the public hostname:
  browsers and third-party OAuth/MCP clients cannot hold bindings.
- **UI** — routes in `src/routes/` (login, device authorization, consent,
  project access, account, org/project management, admin OAuth clients). SSR
  via TanStack Start; the Hono app in `worker.ts` falls through to it.
- **oRPC** — contract in `@iterate-com/auth-contract`
  (apps/auth-contract), implementation in `src/server/orpc/`. The `internal.*`
  procedures are deploy-time-only (OAuth client seeding/ensuring) and
  authenticate with `SERVICE_AUTH_TOKEN`, because their callers are Node
  processes that cannot hold service bindings.
- **Workers RPC** — the default export of `src/server/worker.ts` extends
  `WorkerEntrypoint` and implements `AuthWorkerRpc` (also declared in
  `@iterate-com/auth-contract`): project directory lookups, project creation,
  `prj_` id minting (`src/server/project-directory.ts`). OS binds it as `AUTH`
  in `apps/os/alchemy.run.ts`; in OS local dev it is a _remote_ binding that
  proxies to the deployed worker.
  [Service bindings + RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/),
  [remote bindings](https://developers.cloudflare.com/workers/local-development/#remote-bindings).

## Trust model

- A **session cookie** identifies a human; oRPC middlewares layer org/project
  membership checks on top (`src/server/orpc/orpc.ts` — note the two distinct
  role namespaces documented there).
- The **service token** (`SERVICE_AUTH_TOKEN`) is a deploy-time-only shared
  secret. It doubles as the seeded bootstrap admin's password
  (`scripts/render-admin-seed.ts`), which is how deploy scripts reach
  better-auth admin APIs that insist on a session.
- The **service binding is itself the credential** for runtime OS→auth calls:
  bindings can only be attached by deploys into the same Cloudflare account,
  so no secret ships in OS worker config. Authorization for _whose_ project
  gets created happens in OS against verified JWT claims before the RPC call.

## Identity model

- **Users** sign in with Google or email OTP (dev/preview and prod behind
  `VITE_ENABLE_EMAIL_OTP_SIGNIN`); password signup is disabled. Signup is
  gated by `SIGNUP_ALLOWLIST`; `ADMIN_ALLOWLIST` promotes matching emails to
  platform admin (`src/server/platform-admin.ts` documents the full model).
- **Organizations & projects** live in auth's D1 and are the durable source of
  truth; OS keeps per-environment rows and re-adopts from auth after resets
  (`src/server/project-slugs.ts` explains the adoption/conflict rules).
- **Tokens** carry custom claims (orgs, projects, admin flag) declared in
  `@iterate-com/shared/auth-claims` and minted in `src/server/auth-plugins.ts`.
  Project-scoped tokens go through the `/project-access` selection flow —
  `src/server/oauth-project-selection.ts` documents the three-step handoff.
- **JWT verification** in relying parties uses a JWKS baked at deploy time
  (see `apps/os/alchemy.run.ts`), so key rotation requires an OS redeploy.

## Development

```bash
pnpm dev              # doppler(auth/dev) + alchemy dev, serves on :7101
pnpm routes:generate  # regenerate src/routeTree.gen.ts after adding routes
pnpm db:generate      # regenerate sqlfu query types after editing db/queries/*.sql
pnpm typecheck        # routes:check + tsgo
```

Deploys run `alchemy.run.ts`: D1 migrations + admin seed, the worker, DNS for
`WORKER_ROUTES` hostnames, then the declarative OAuth client seed
(`scripts/seed-oauth-clients.ts`, driven by `AUTH_SEED_OAUTH_CLIENTS`).

Gotchas that have bitten before:

- The worker needs the `global_fetch_strictly_public` compatibility flag —
  same-zone SSR self-fetches otherwise bypass Worker routes and hang ~20s
  (see the comment in `alchemy.run.ts`).
- OAuth client secrets are stored SHA-256-hashed (the oauth-provider plugin's
  scheme), so "read back an existing secret" is impossible by design — that
  asymmetry drives the whole `ensureClient`/`setClient` split
  (`src/server/orpc/routers/internal.ts`).
- Never return the raw better-auth session from a TanStack server function or
  loader: `session.token` is the bearer-equivalent of the HttpOnly cookie and
  would be serialized into the page (`src/routes/_auth.tsx`).
