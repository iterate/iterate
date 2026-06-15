# Architecture And Operations

This document collects the operational details that should not live in the
short README.

## Runtime Shape

OS deploys as many small Workers (see [worker-topology.md](./worker-topology.md)):
a tiny ingress router owns all routes, the dashboard app is its own worker,
and every Durable Object class is its own worker. Three kinds of traffic are
dispatched on hostname and path:

1. Infrastructure routes that bypass the app entirely: the captun tunnel relay
   at `/__iterate/captun` and admin-token debug routes.
2. Project ingress: requests to project hosts (`<slug>.iterate.app`, custom
   hostnames) route to the project's callable, never the dashboard.
3. The OS dashboard: a TanStack Start app (SSR + oRPC API).

The ingress worker (`src/workers/ingress.ts`) forwards the MCP hostname to
the MCP worker and ingress-rule matches to the project worker; everything
else lands on the app worker (`src/workers/app.ts`), whose evlog-wrapped
pipeline tries handlers in order before falling through to TanStack Start:
docs markdown, project stream RPC, `/api/itx`, and the `/__durable-objects`
debug proxy. Runtime config is parsed from `env` per
request (never at module scope — isolates can outlive binding-only deploys).

The TanStack handler receives a `RequestContext` (`src/request-context.ts`)
with request-scoped state only: `config`, `db` (sqlfu over D1), `log`,
`rawRequest`, `waitUntil`, `workerExports`. Worker bindings are NOT threaded
through context — server code imports `env` from `cloudflare:workers`.

Authentication uses the Iterate Auth Worker (no Clerk; see
[ADR 0001](../../docs/adr/0001-replace-clerk-with-auth-worker.md)).
`iterateAuthMiddleware` (`src/auth/middleware.ts`, registered as Start request
middleware in `src/start.ts`) serves the auth-worker callback routes and
resolves the caller into a `principal`: the admin API secret, an OAuth bearer
token, or a session cookie. Users without an organization are redirected to
the auth worker's project-access flow.

Project-scoped oRPC procedures stay thin. The worker authenticates the caller,
resolves project slug or ID to the stable Project ID, checks project access
(signed Auth project claims; admin API callers bypass for operator work), and
calls the Project Durable Object for lifecycle behavior. D1 tables such as
`projects` and ingress rules are queryable projections, not the lifecycle
authority.

## API And Routing

The main app routes (`src/routes/`):

```text
/                                  redirects: project-host slug or single
                                   project -> /projects/:projectSlug,
                                   otherwise -> /projects
/projects
/projects/:projectSlug             ProjectHomePage (lifecycle state + stream view)
/projects/:projectSlug/codemode-sessions[/new, /:name]
/projects/:projectSlug/streams[/*]
/projects/:projectSlug/agents, /repos, /secrets, /integrations, /mcp, /repl, /settings
/new-project
/sign-in, /sign-up
```

There are no organization routes; organization membership and selection live
in the auth worker.

The browser talks to oRPC at `/api/orpc` (and `/api/orpc-ws` for WebSocket).
The same router is served as OpenAPI under `/api`, with Scalar docs at
`/api/docs` and the spec at `/api/openapi.json`. The unauthenticated
`__internal.*` operator subtree (health, publicConfig, CLI procedure listing)
is served at `/api/__internal/*` and is what `pnpm cli rpc` discovers.

Project-scoped procedures live under the singular `project` router; the plural
`projects` router is for collection operations. Project-scoped procedures
accept `projectSlugOrId` — a globally unique slug for curlable requests or a
stable Project ID:

```text
os.projects.list()
os.projects.create(...)
os.project.get({ projectSlugOrId })
os.project.streams.read({ projectSlugOrId, streamPath: "/" })
os.project.codemode.listSessions({ projectSlugOrId })
os.project.inboundMcpServer.listSessions({ projectSlugOrId })
```

itx — the capability handle system — has its own endpoints: `/api/itx`
(global handle), `/api/itx/:projectIdOrSlug` (project handle, capnweb over
WebSocket), and `POST /api/itx/run` (run an itx script in a loader isolate).
See [`../src/itx/README.md`](../src/itx/README.md) and
[itx-next.md](./itx-next.md).

## Project Ingress

OS classifies hostnames before TanStack Start and dashboard authentication:

```text
request hostname
  -> D1 exact-host ingress lookup (src/ingress/lookup.ts, scoped by
     APP_CONFIG_PROJECT_HOSTNAME_BASES)
    -> project-host itx handling (src/itx/fetch.ts)
    -> dispatch the rule's Fetch Callable (src/ingress/host-routing.ts)
  -> OS app fallback
```

Project-owned ingress mutations go through the Project Durable Object: it
records desired state locally and writes global D1 projection rows for the hot
Worker path. Durable Object SQLite and D1 are not one atomic transaction, so
repair/reconciliation is explicit follow-up work.

`ProjectMcpServerEntrypoint` still exists as a named export but is a
tombstone: it returns `410 Gone` because project MCP hostnames moved to the
canonical MCP endpoint (below).

## Streams

`StreamDurableObject` is supplied by the OS streams domain. It knows about
`namespace` and `path`, not projects. OS uses the stable Project ID as the
stream namespace, which means OS stream paths are project-local, such as
`/codemode-sessions/<id>`.

The stream explorer lives at `/projects/:projectSlug/streams`. Detail pages
are splat routes: `/streams/foo/bar` opens stream path `/foo/bar` inside the
project-bound namespace.

OS deploys the stream Durable Object from the main worker script and binds
`STREAM` to that local namespace.

## Durable Object Utilities

Durable Objects should use the shared Iterate Durable Object base from
`@iterate-com/shared/durable-object-utils/iterate-durable-object` unless there
is a specific reason not to. That base composes the runtime core adapters,
lifecycle hooks, D1 object catalog projection, local SQLite inspector, and
local KV inspector.

The worker exposes an admin-token-gated debug proxy that forwards into a
Durable Object's fetch handler:

```text
/__durable-objects/<kind>/<name>/<path>
```

where `<kind>` is one of `project`, `codemode-session`,
`project-mcp-server-connection`, `stream` (`src/debug-routes.ts`). Other debug
routes there: `/__debug/append-chain`, `/__debug/seed-iterate-config-base`,
and `/api/itx/openapi-fixture`.

## MCP Directionality

OS has two MCP flows:

- Inbound MCP: external MCP clients connect to the canonical MCP endpoint.
  `handleMcpFetch` (`src/domains/inbound-mcp-server/mcp-handler.ts`) matches
  the URL from `APP_CONFIG_MCP__BASE_URL` (for example
  `https://mcp.iterate.com`; fully-local dev defaults to
  `<baseUrl>/api/__mcp`) and delegates session state to the
  `ProjectMcpServerConnection` Durable Object via `McpAgent.serve`.
- Outbound MCP: a codemode session uses an external MCP server as a Tool
  Provider. `OutboundMcpFromOurClientCapability` owns the client connection
  and exposes `executeCodemodeFunctionCall(...)`.

Keep these separate in naming and code. Inbound MCP may execute codemode, but
it is not itself a codemode Tool Provider.

Inbound MCP requests authenticate two ways, tried in order:

1. The platform admin API secret — full access to every project in the
   deployment (`authType: "admin_api_secret"`).
2. An Iterate Auth OAuth bearer token — project access is the intersection of
   the token's `projects` claim and its `project:<id>` scope entries.

The MCP endpoint exposes RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource`, pointing clients at the Iterate Auth
issuer (`iterateAuth.issuer`, default `https://auth.iterate.com/api/auth`) as
the authorization server.

## Codemode

Codemode executes JavaScript in isolated dynamic Worker sandboxes through oRPC
or MCP.

Primary surfaces:

- UI: project codemode session pages.
- oRPC: `project.codemode.createSession`, `project.codemode.executeScript`,
  and `project.streams` reads.
- MCP: `exec_js` on the canonical MCP endpoint.

Sessions are seeded with capabilities at context creation (see
`SEEDED_CAPS` in
`src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts`
and the agent defaults in
`src/domains/agents/durable-objects/agent-durable-object.ts`): `itx.ai`,
`itx.gmail`, and for agents also `itx.slack`, `itx.agents`, `itx.workspace`,
and more.

Slack and other event-mediated providers can append function-call completions
from outside the codemode processor. RPC providers return through
`executeCodemodeFunctionCall(...)`.

## Database

sqlfu is the database source of truth:

- `src/db/definitions.sql` declares the desired schema.
- `src/db/migrations/*.sql` is the migration history.
- `src/db/queries/*.sql` contains checked-in application queries.
- `src/db/queries/.generated` and `src/db/migrations/.generated` are generated
  by `pnpm sqlfu:generate`.

Use sqlfu for schema changes and migrations. Do not hand-write migration
history outside the sqlfu workflow.

Persisted records should make scope explicit with first-class columns (for
example a project ID column), not hide ownership or routing scope inside JSON
metadata or callable props.

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
APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate.app"]
APP_CONFIG_LOGS__STDOUT_FORMAT=pretty
APP_CONFIG_SLACK_BOT_TOKEN=xoxb-...
APP_CONFIG_INTEGRATIONS__SLACK='{"oauthClientId":"123.456","oauthClientSecret":"...","webhookSigningSecret":"..."}'
APP_CONFIG_INTEGRATIONS__GOOGLE='{"oauthClientId":"...","oauthClientSecret":"..."}'
```

Fields marked `redacted(...)` in the schema parse into `Redacted` wrappers
that must be unwrapped with `.exposeSecret()` and never serialize. Fields
marked `publicValue(...)` are the only ones exposed to the browser, through
the unauthenticated `__internal.publicConfig` oRPC procedure.

`integrations.slack` and `integrations.google` are grouped JSON values in
Doppler so each provider's OAuth client values update atomically. Slack uses
one OAuth client for OS; the Slack team ID claimed during OAuth decides which
project receives signed Slack webhooks.

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
([worker-topology.md](./worker-topology.md)) sharing one D1 (`os-db`), the
Durable Object namespaces (each owned by its worker, bound cross-script
everywhere else), a `WorkerLoader`, the Workers AI binding, and routes on the
ingress worker for the app base URL, the MCP base URL, the event-docs host,
and each project hostname base. Fresh stages bootstrap with an automatic
two-pass deploy (cross-script bindings to not-yet-existing scripts are wired
by the second pass). The ambient Doppler config selects the stage: `pnpm cf:deploy`
deploys to whatever stage your environment points at; `pnpm deploy` is the
production wrapper (`doppler run --config prd`).

## Smoke Tests

Preview worker smoke:

```bash
doppler run --project os --config preview_2 -- pnpm e2e -t "OS preview smoke"
```

Browser smoke with `agent-browser`:

- [Preview Agent Browser Smoke](./preview-agent-browser-smoke.md)

Codemode MCP provider-stack smoke:

```bash
OS_E2E_MCP_URL=https://mcp.iterate-preview-2.com \
doppler run --project os --config preview_2 -- pnpm e2e -t "project MCP exec_js"
```

The MCP smoke accepts either:

- `OS_E2E_MCP_BEARER_TOKEN`: an Iterate Auth OAuth access token for a user
  with access to the project.
- `OS_E2E_ADMIN_API_SECRET`, `OS_ADMIN_API_SECRET`, or
  `APP_CONFIG_ADMIN_API_SECRET`: an OS admin token for deployment-level smoke
  tests that do not need user/project membership setup.

When `APP_CONFIG_SLACK_BOT_TOKEN` is present in the test process, the codemode
MCP test discovers `#slack-agent-e2e-test` and includes a real
`ctx.slack.chat.postMessage(...)` call.
