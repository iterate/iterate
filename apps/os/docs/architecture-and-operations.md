# Architecture And Operations

This document collects the operational details that should not live in the
short README.

## Runtime Shape

OS deploys as ten small Workers (see [worker-topology.md](./worker-topology.md)):
a tiny ingress router owns all routes, the dashboard app and the engine API
are their own workers, and every Durable Object class is its own worker.
Traffic is dispatched on hostname and path:

1. Engine lanes: `/api/itx[...]`, `/__itx_e2e/*`, `/prj_<id>/...`, and project
   platform hosts (`<slug>.iterate.app`, `<slug>.localhost:<port>`) forward to
   the api worker (`src/next/workers/api.ts`). Project-host requests route to
   the project's seeded worker, never the dashboard.
2. The MCP hostname (`mcp.iterate.com`) rewrites to the app worker's
   `/api/mcp` route.
3. Everything else on the OS host lands on the app worker
   (`src/workers/app.ts`): the TanStack Start dashboard (SSR, server
   functions, assets) wrapped in one evlog "wide event" per request.

The routing decision is one shared function (`src/next/ingress.ts`), run by
the ingress worker in production and by the app worker in local dev (where the
browser talks to vite directly). Runtime config is parsed from `env` per
request, never at module scope — isolates can outlive binding-only deploys.

The TanStack handler receives a `RequestContext` (`src/request-context.ts`)
with request-scoped state only: `config`, `log`, `rawRequest`, `waitUntil`.
Worker bindings are NOT threaded through context — server code imports `env`
from `cloudflare:workers`.

## Authentication

Authentication uses the Iterate Auth Worker (no Clerk; see
[ADR 0001](../../../docs/adr/0001-replace-clerk-with-auth-worker.md)).
`iterateAuthMiddleware` (`src/auth/middleware.ts`, registered as Start request
middleware in `src/start.ts`) serves the auth-worker callback routes and
resolves the caller into a `principal`: the admin API secret, an OAuth bearer
token, or a session cookie. Users without an organization are redirected to
the auth worker's project-access flow.

The engine has its own auth adapter (`src/next/auth.ts`) behind
`authenticate()` on `/api/itx` — credential lanes and the project-directory
claims fallback are described in [src/next/README.md](../src/next/README.md).

## The Project Directory

OS has no database. The auth worker is the source of truth for which projects
exist, their slugs, and who can access them; OS fronts it with the
`PROJECT_DIRECTORY` KV namespace (`src/next/project-directory.ts`) so hot
paths — project-host ingress, dashboard slug resolution — never pay an
auth-worker roundtrip on a cache hit. Project creation registers with the auth
worker and primes the cache. Everything else durable lives in Durable Object
SQLite, as event streams.

## API And Routing

The main app routes (`src/routes/`):

```text
/                                  redirects: project-host slug or single
                                   project -> /projects/:projectSlug,
                                   otherwise -> /projects
/projects
/projects/:projectSlug             ProjectHomePage (lifecycle state + agent chat)
/projects/:projectSlug/agents[/streams/*], /reactivity, /repl, /repos,
                                   /secrets, /settings, /streams[/*]
/itx-repl
/new-project
/admin[/projects, /repl, /streams]
/sign-in, /sign-up
```

There are no organization routes; organization membership and selection live
in the auth worker.

The browser talks to the engine over `/api/itx`: one Cap'n Web WebSocket per
context, managed by `src/itx/itx-react.tsx` (`useItx`/`useItxQuery`/
`useItxEffect`). `POST /api/itx` serves one-shot HTTP batch sessions (used by
the project-create server function and MCP `exec_js`).
`/api/itx/admin-cookie` is the browser admin-auth bridge (WebSockets cannot
set headers). The app worker keeps only `/api/mcp` and `/api/health`; the
catch-all `src/routes/api.$.ts` returns 404 (integration callbacks return
with the integrations domain).

## Streams

`StreamDurableObject` (`src/next/domains/streams/`) is addressed by
`{ projectId, path }`; stream paths are project-local, such as
`/agents/default`. `projectId: null` (encoded as the reserved `global.iterate`
DO-name host) is for deployment-wide streams.

The stream explorer lives at `/projects/:projectSlug/streams`. Detail pages
are splat routes: `/streams/foo/bar` opens stream path `/foo/bar` inside the
resolved Project ID. The browser keeps a local mirror of subscribed streams
(OPFS-backed; `src/next/domains/streams/client-libraries/browser/`) running
the same `StreamProcessor` contracts as the server.

## MCP Directionality

OS has two MCP flows:

- Inbound MCP: the app worker's TanStack Start route at `/api/mcp` is the MCP
  server (`src/next/domains/inbound-mcp-server/`). `APP_CONFIG_MCP__BASE_URL`
  is the canonical OAuth resource URL and can point at a dedicated MCP
  hostname (for example `https://mcp.iterate.com`), which ingress rewrites to
  the same route. The OS app-host `/api/mcp` route is also valid. The handler
  authenticates each request, creates a fresh in-memory MCP server, and
  exposes `exec_js`, which runs the code through the engine over a one-shot
  capnweb batch.
- Outbound MCP: `itx.mcp.connect(...)` connects to an external MCP server and
  exposes that remote server's tools as capability methods.

Keep these separate in naming and code. Inbound MCP may execute itx scripts
through `exec_js`, but it is not itself an outbound MCP capability.

Inbound MCP requests authenticate two ways, tried in order:

1. The platform admin API secret — full access to every project in the
   deployment (`authType: "admin_api_secret"`).
2. An Iterate Auth OAuth bearer token — project access is the intersection of
   the token's `projects` claim and its `project:<id>` scope entries.

The MCP endpoint exposes RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource`, pointing clients at the Iterate Auth
issuer (`iterateAuth.issuer`, default `https://auth.iterate.com/api/auth`) as
the authorization server.

## itx Scripts

The engine executes JavaScript in isolated dynamic Worker sandboxes through
`itx.runScript(...)` — reached from the browser REPL, agents, the CLI
(`pnpm cli itx run`), and MCP `exec_js`. Every runtime accepts the same
script shape: a body that runs with `itx` (and `vars`) in scope and ends with
an explicit `return` (see `src/itx/examples.ts`, the catalogue that doubles
as the REPL Examples panel and the cross-runtime e2e matrix).

Capabilities are visible through `itx.describe()`. The built-ins
(`itx.streams`, `itx.repos`, `itx.secrets`, `itx.agents`, `itx.workers`,
`itx.worker`, `itx.egress`, `itx.mcp`, `itx.openapi`, `itx.ai`; `itx.agent` /
`itx.chat` on agent scopes) plus mounted capabilities are catalogued in
[`src/next/types.ts`](../src/next/types.ts).

## Runtime Config

Runtime config is parsed by `src/config.ts` from optional base JSON in
`APP_CONFIG` plus nested `APP_CONFIG_*` overrides. Overrides use `__` as the
nesting separator and are converted to the schema's camelCase shape.

Examples:

```text
APP_CONFIG_BASE_URL=https://os.iterate.com
APP_CONFIG_MCP__BASE_URL=https://mcp.iterate.com
APP_CONFIG_ITERATE_AUTH__ISSUER=https://auth.iterate.com/api/auth
APP_CONFIG_ITERATE_AUTH__CLIENT_ID=...
APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET=...
APP_CONFIG_ADMIN_API_SECRET=...
APP_CONFIG_OPEN_AI_API_KEY=...
APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate.app"]
APP_CONFIG_LOGS__STDOUT_FORMAT=pretty
```

Fields marked `redacted(...)` in the schema parse into `Redacted` wrappers
that must be unwrapped with `.exposeSecret()` and never serialize. Fields
marked `publicValue(...)` are the only ones exposed to the browser, through
the TanStack server function in `src/lib/public-route-config.ts`.

Slack/Google integration config returns with the integrations domain
(itx-v4 migration Phase 12).

## Auth Client Sync

OAuth clients in the Iterate Auth Worker and the matching Doppler values are
managed by `scripts/sync-auth-clients.ts` (`pnpm auth:sync-clients`). For each
target Doppler config (`dev_<name>`, `preview_1`–`preview_9`, `prd`) it
ensures two OAuth clients (web + MCP/CLI) via the auth contract's
`internal.oauth.ensureClient`, then writes `APP_CONFIG_BASE_URL`,
`APP_CONFIG_MCP__BASE_URL`, `APP_CONFIG_PROJECT_HOSTNAME_BASES`, and the
`ITERATE_OAUTH_*` / `ITERATE_MCP_OAUTH_*` values back to Doppler.

It requires `SERVICE_AUTH_TOKEN` (run through Doppler for the auth project).
`AUTH_CLIENT_SYNC_TARGETS` filters targets;
`ROTATE_AUTH_CLIENT_SECRETS=1` rotates client secrets.

## Deployment

`alchemy.run.ts` defines the deployment: the full worker topology
([worker-topology.md](./worker-topology.md)), the Durable Object namespaces
(each owned by its worker, bound cross-script everywhere else), the
`PROJECT_DIRECTORY` KV namespace, a `WorkerLoader`, the Workers AI binding,
Cloudflare Artifacts for repos, and routes on the ingress worker for the app
base URL, the MCP base URL, and each project hostname base. Fresh stages
bootstrap with an automatic two-pass deploy (cross-script bindings to
not-yet-existing scripts are wired by the second pass). Deploys must name the
Doppler config explicitly, for example
`doppler run --project os --config preview_2 -- pnpm run deploy` or
`doppler run --project os --config prd -- pnpm run deploy`.

## Smoke Tests

Preview worker smoke:

```bash
doppler run --project os --config preview_2 -- pnpm e2e -t "OS preview smoke"
```

Engine e2e against a deployed preview:

```bash
doppler run --project os --config preview_2 -- pnpm e2e e2e/engine/
```

One-turn real agent smoke ([agent-smoke-testing.md](./agent-smoke-testing.md)):

```bash
doppler run --project os --config preview_2 -- pnpm cli itx agent-smoke \
  --project <prj_id> --agent-path /agents/onboarding --message "Reply with exactly: pong"
```

Browser smoke with `agent-browser`:

- [Preview Agent Browser Smoke](./preview-agent-browser-smoke.md)
