# OS App

Minimal full-stack app: TanStack Start + oRPC over OpenAPI/HTTP + sqlfu, running on Cloudflare Workers.

## Stack

- **API:** oRPC over OpenAPI/HTTP at `/api`
- **Frontend:** TanStack Start in SPA mode + TanStack Router + TanStack Query
- **Auth:** Clerk sessions for the app, Clerk OAuth Applications for remote MCP clients
- **DB:** sqlfu + Cloudflare D1. SQL definitions, migrations, and typed query wrappers live under `src/db`.
- **Observability:** Workers use the shared `withEvlog()` runtime wrapper; shared `useEvlog()` only enriches a request-scoped log
- **Runtime config:** optional `APP_CONFIG` JSON env var plus `APP_CONFIG_*` nested overrides, with frontend-visible fields annotated in the schema and exposed through the typed `__internal.publicConfig` oRPC procedure

## Local rules

- Follow `jonasland/RULES.md` at all times when working in `apps/os2`.

## Key files

- `src/app.ts` — app manifest plus app config schema
- `src/entry.workerd.ts` — Cloudflare Workers runtime entry: D1, request context, websocket upgrade handling
- `src/orpc/orpc.ts` — oRPC composition point plus `activeOrganizationMiddleware`
- `src/orpc/root.ts` — concrete procedure handlers (composed from `orpc/routers/*`)
- `src/orpc/client.ts` — isomorphic oRPC client plus TanStack Query client factory/query utils
- `src/db/definitions.sql` — sqlfu schema source of truth
- `src/db/migrations` — SQL migrations consumed by Alchemy for D1
- `src/db/queries` — checked-in SQL queries plus generated typed wrappers
- `src/context.ts` — Start request context + oRPC context types
- `src/router.tsx` — TanStack Router setup plus SSR Query integration
- `src/routes/api.$.ts` — OpenAPI oRPC catch-all route mounted at `/api`
- `src/routes/__root.tsx` — root route with SSR-loaded public config, shared app providers, Clerk provider, and devtools
- `src/routes/_app/orgs.$organizationSlug.tsx` — authenticated organization app shell with Clerk org/user controls
- `vite.config.ts` — Cloudflare dev/build (uses Alchemy plugin)
- PostHog source maps are not configured for this minimal app.
- `runtime-smoke.test.ts` — sqlfu asset check plus optional Cloudflare runtime smoke checks

## Runtime architecture

The OS2 app has no public product pages. Browser users without a Clerk session
are sent to `/sign-in`; signed-in users without an active Clerk Organization are
sent to `/organization` to create or select one. The app shell uses Clerk's
`OrganizationSwitcher` with `hidePersonal` and `UserButton` in the sidebar.

The browser talks to `/api` over OpenAPI/HTTP. SSR uses `createRouterClient`
for in-process calls with the same typed router. Runtime app context
(`manifest`, `config`, `db`, `log`) is attached in `entry.workerd.ts`; API
routes and SSR oRPC calls add Clerk `auth()` before invoking protected
procedures. Runtime auth checks are implemented as oRPC middleware:
`activeOrganizationMiddleware` rejects unauthenticated or personal-account
requests and injects `context.activeOrganization` for handlers.

Project-scoped oRPC procedures should stay thin. The TanStack Start app owns
HTTP routing, Clerk organization context, form/API shape, and response mapping;
the Project Durable Object owns project lifecycle behavior. When an operation
changes project-owned ingress, destinations, MCP setup, or other project-owned
runtime state, the oRPC handler should resolve the stable Project ID and call
the Project Durable Object's control surface rather than duplicating lifecycle
logic in the app worker.

Project creation should use a domain command named `createProject`, not
`initializeProject`. The app worker authenticates the caller, validates the
requested slug, allocates the Project ID, gets the Project Durable Object by
that Project ID, and calls `createProject(...)`. The Project Durable Object then
writes local lifecycle state plus D1 projections before the RPC caller returns
and redirects to the Project detail page. Follow-up work such as DNS,
Cloudflare custom-hostname setup, and certificate provisioning can continue from
the durable desired state.

Project creation and lifecycle commands should also write the app-level D1
`projects` row from the Project Durable Object. That row is a listing and route
projection, not the lifecycle authority. It is separate from the shared
Durable Object catalog tables created by `withD1ObjectCatalog`, which track
initialized Durable Objects for discovery, inspection, and repair workflows.

Cloudflare Workers wrap requests with the shared `withEvlog()` helper. The
runtime entrypoint still assembles app-specific deps, but request logger
creation, ALS scoping, pretty/raw formatting, filtering, and request-final flush
now live in one shared place. The shared `useEvlog()` oRPC middleware still does
not create or emit logs; it only adds app/RPC context to the log it receives.

Known caveat: the current shared wrapper still flushes in `finally`, so
long-lived streamed responses such as SSE can have later request-scoped
`log.info()` calls omitted from the final emitted request event. Stream-close
aware finalization is a follow-up improvement.

## MCP Directionality

OS2 has two MCP flows that must stay separate in naming and code:

- **Inbound MCP:** external MCP clients connect to a project MCP hostname. The
  request enters `ProjectMcpServerEntrypoint`, which authenticates the MCP
  request and delegates session state to `ProjectMcpServerConnection`. This is a
  real fetch-based Worker entrypoint for project ingress. It may execute
  codemode, but it is not itself a codemode Tool Provider.
- **Outbound MCP:** a codemode session uses an external MCP server as a Tool
  Provider. `OutboundMcpFromOurClientCapability` is the Durable Object wrapper
  that opens and caches our MCP client connection, and it exposes
  `executeCodemodeFunctionCall(...)` for codemode RPC provider calls. Remote
  tool discovery should be a normal codemode call such as
  `ctx.cloudflareDocs.listTools()`, not a special provider-description protocol.

`config.logs` is consumed by the shared runtime logging wrapper:

- `stdoutFormat` chooses between shared pretty stdout rendering and shared raw
  structured output
- `filtering.rules` lets an app override default request-log filters
- successful `/posthog-proxy/**` requests are suppressed by default unless the
  app config opts back into logging them

Each request-final evlog event still adds a short summary `message` while
keeping the structured wide event fields as the source of truth.

## Project Ingress

OS2 has two request-routing levels.

Level 1 runs in the main OS2 Worker before TanStack Start and before dashboard
authentication. It is an ingress route-table match:

- if the request hostname is owned by a Project, the Worker delegates the
  request to `ProjectIngressEntrypoint` with the Project ID in loopback props
- if the request hostname is not owned by a Project, the Worker continues into
  the current TanStack Start OS2 App

Level 2 runs inside the Project Durable Object. The Project Durable Object owns
the project-local ingress route table, including which hostnames and paths are
public and which require project-scoped authentication. This is deliberately
less efficient than routing everything in the horizontally-scaled Worker, but it
keeps the Project Durable Object authoritative while the model settles. Later,
the Worker can cache route projections derived from the Project Durable Object.

Both levels should use the same conceptual route table:

1. Match an HTTP request against ordered ingress routing rules.
2. Resolve the match to a fetch-capable destination.
3. Proxy the request to that destination with `fetch(request)`.

The matcher should be packaged as a pure library. Its dependencies are:

- an HTTP request, where matching only considers request URL host/path and
  request headers
- a route lookup abstraction, so the first implementation can use D1 and later
  implementations can use KV or another cache without changing matching
  semantics
- caller-provided fallback rules, such as "route everything else to the OS2 App"

Each stored ingress routing rule should have a stable TypeID-style ID, priority,
optional notes/comments, match data, and a top-level `callable` target.
Fallback rules are not seed data and do not need to be inserted into D1.

The first stored rule shape should be intentionally SQL-friendly:

```ts
type ExactHostIngressRule = {
  id: string;
  priority: number;
  host: string;
  notes: string | null;
  callable: FetchCallable;
};
```

Matching this rule class should compile to a direct indexed lookup by normalized
hostname. Richer matching over paths, headers, methods, or wildcard hostnames is
future work.

The route-table model should be capable of growing toward Caddy/nginx-style
matching over hostnames, paths, methods, headers, and other request properties.
The first implementation can stay much narrower, but it should not bake in a
special one-off "hostname lookup means project" abstraction.

### Worker Shape

The preferred long-term shape is still a skinny public OS2 Ingress Worker in
front of private implementation workers:

- the OS2 Ingress Worker owns public routes and workers.dev exposure
- the OS2 App Worker runs TanStack Start and oRPC but does not need a public
  route
- Codemode Session and Project MCP Server Connection Durable Object owners can
  remain separate worker scripts behind bindings
- public traffic enters through the OS2 Ingress Worker and is forwarded to a
  fetch-capable destination

This keeps the public entrypoint small and makes it explicit that project
ingress is resolved before dashboard authentication.

```text
public hostname
  -> OS2 Ingress Worker
    -> ProjectIngressEntrypoint loopback entrypoint (Project Ingress Entry Point)
      -> Project Durable Object ingress RPC
    -> ProjectMcpServerEntrypoint loopback entrypoint (Project MCP Server Entry Point)
    -> OS2 App Worker fetch destination
    -> future fetch destinations
```

For now, the Project Durable Object should be exported from the main OS2 Worker,
not from a separate worker script. That is a deliberate near-term exception to
the usual Durable Object deployment boundary because Cloudflare loopback
bindings (`ctx.exports`) are the mechanism that can pass dynamic `props` to
named entrypoints. The entrypoints should live in `src/entrypoints/`, next to
`src/durable-objects/`.

The two first named Worker entry points are:

- `ProjectIngressEntrypoint`, the Project Ingress Entry Point, a
  `WorkerEntrypoint` with props `{ projectId: string }`. Its `fetch(request)`
  method resolves the Project Durable Object stub using the Project ID as the
  Durable Object name and returns `stub.ingressFetch(request)`.
- `ProjectMcpServerEntrypoint`, the Project MCP Server Entry Point, a
  `WorkerEntrypoint` with props `{ projectId: string }`. It is the
  project-scoped MCP server fetch destination used by project-local MCP routes
  such as `mcp.mycustomer.com`.

The Durable Object behind MCP client connections is
`ProjectMcpServerConnection`. It describes one external MCP client connected to
OS2's project-scoped MCP server, and it stays distinct from
`OutboundMcpFromOurClientCapability`, where OS2 is the client of an external MCP
server and the Durable Object is used as a codemode Tool Provider.

Entrypoint props should use stable Project IDs only in v1. Project slugs are
mutable route identity for the OS2 control plane; slug-to-ID resolution should
happen before writing global ingress rules or before invoking a codemode/MCP
control-plane command. Hot ingress should not perform a second slug lookup.

For v1, global ingress rules should target the `ProjectIngressEntrypoint`
loopback entry point. Project-local MCP rules should target the
`ProjectMcpServerEntrypoint` loopback entry point:

```ts
type FetchCallable = Extract<Callable, { type: "fetch" }>;

const projectIngressFetchCallable = {
  type: "fetch",
  via: {
    type: "loopback-binding",
    bindingType: "service",
    exportName: "ProjectIngressEntrypoint",
    props: { projectId },
  },
} satisfies FetchCallable;

const projectStreamsFetchCallable = {
  type: "fetch",
  via: {
    type: "url",
    url: "https://events.iterate.com",
  },
  fetchRequest: {
    headers: {
      "x-iterate-project-id": projectId,
    },
  },
} satisfies FetchCallable;
```

The existing experiment in `experiments/channel-agent-poc/nested-facets` is the
rough prototype for this shape: its Worker parses the hostname, dispatches
project/app traffic to a project Durable Object, and lets the project Durable
Object route to editor/app facets.

### Hostname Examples

Each Project can have several rootable Project Ingress Hosts:

- Slug Project Ingress Host: `<project-slug>.iterate.app`
- Stable Project Ingress Host: `<project-id>.iterate.app`
- Custom Project Ingress Host: an optional user-owned hostname such as
  `mycustomer.com`

The Default Project Ingress Host is the hostname OS2 uses when generating
ordinary public URLs. It is the custom host when a Project has one; otherwise it
is the slug platform host. The stable ID host should still work, but it is not
the default user-facing URL.

A Project Dashboard Host such as `iterate.<project-ingress-host>` can route a
project-owned hostname back to the OS2 dashboard for that Project. This is a
project-local route destination, not the global OS2 dashboard host. It is useful
for future custom-host flows such as `iterate.mycustomer.com`.

| Hostname                      | Level 1 result                                     | Level 2 owner | Example destination                        |
| ----------------------------- | -------------------------------------------------- | ------------- | ------------------------------------------ |
| `os.iterate2.com`             | OS2 App                                            | none          | Dashboard, oRPC, sign-in                   |
| `os2-prd.iterate.workers.dev` | OS2 App                                            | none          | Deployment/debug entry                     |
| `demo.iterate.app`            | Project Ingress by slug platform host              | Project DO    | Project default route                      |
| `proj_01abc.iterate.app`      | Project Ingress by stable ID platform host         | Project DO    | Project default route                      |
| `mycustomer.com`              | Project Ingress by custom hostname lookup          | Project DO    | Public website apex                        |
| `mcp.mycustomer.com`          | Project Ingress by custom hostname lookup          | Project DO    | Project MCP Server Entry Point             |
| `mcp__demo.iterate.app`       | Project Ingress by slug platform alias             | Project DO    | MCP fallback while deep DNS propagates     |
| `streams.mycustomer.com`      | Project Ingress by custom hostname lookup          | Project DO    | Events app proxy with Project ID header    |
| `streams__demo.iterate.app`   | Project Ingress by slug platform alias             | Project DO    | Streams fallback while deep DNS propagates |
| `iterate.mycustomer.com`      | Project Ingress by custom hostname lookup          | Project DO    | Project dashboard destination              |
| `unknown.example.com`         | OS2 App or 404, depending on Worker route coverage | none          | Not project-owned                          |

Initially, only the hostname decides the first fork. Paths are interpreted after
that by either the OS2 App or the Project Durable Object.

MCP project routing should use project ingress routes, not a hard-coded `/mcp`
path on the custom hostname apex. For a custom hostname, `mcp.mycustomer.com`
can be a project-local route whose destination is the Project MCP Server Entry
Point. `mycustomer.com/mcp` is just a path under the custom hostname apex and
should be handled by the Project Durable Object's normal apex route.

Project MCP routes are host-routed in v1. Once the Project Durable Object
matches an MCP hostname, it should delegate every path on that hostname to
`ProjectMcpServerEntrypoint`. That entry point owns MCP protocol paths, OAuth
protected-resource metadata, browser setup instructions, and unsupported-path
404s. The TanStack Start app does not need to render the MCP instructions page;
the entry point can return static HTML directly for browser requests that are
not MCP client connections.

Project platform MCP routes also get single-label fallback aliases such as
`mcp__demo.iterate.app` and `mcp__proj_01abc.iterate.app`. These are not the
canonical URLs; they are there so `*.iterate.app` wildcard DNS can work while
deeper hostnames such as `mcp.demo.iterate.app` are unavailable or propagating.

Project stream routes are host-routed in v1. For a custom hostname,
`streams.mycustomer.com` should route through the Project Durable Object to a
shared fetch callable targeting `https://events.iterate.com`. The callable
preserves the incoming path and query string and injects
`x-iterate-project-id: <project-id>` before fetching the Events app.

Project platform streams routes also get single-label fallback aliases such as
`streams__demo.iterate.app` and `streams__proj_01abc.iterate.app` for the same
wildcard-DNS propagation case.

### Authentication Placement

OS2 App authentication protects dashboard/control-plane routes after the
hostname classifier has decided the request is not Project Ingress.

Project Ingress authentication belongs to the Project Durable Object. A single
Project can have both public and protected destinations:

- `https://mycustomer.com/` can be a public website served by a runtime-loaded
  fetch callable
- `https://mcp.mycustomer.com` can require Clerk OAuth as a project MCP server
  route
- `https://demo.iterate.app/_admin` can require an OS2 user with access to the
  owning Clerk Organization

This means the main Worker must not require a Clerk session before the hostname
fork, otherwise public custom-hostname traffic would be impossible.

Do not add destination-specific authorization RPCs to the Project Durable
Object, such as `authorizeMcpServerConnection(...)`. MCP is one Project Route
Destination among many future project-local apps. The future Project DO auth
surface should be generic, for example evaluating whether a principal may access
a Project Route Destination. V1 can keep the MCP wrinkle simple:
`ProjectMcpServerEntrypoint` owns Clerk OAuth protocol verification, then asks
the Project Durable Object to perform a generic Project Access Check. That check
can read the app-level D1 `projects` projection to verify that the verified
Clerk Organization owns or can access the Project. Full destination-specific
Project Route Authorization remains follow-up work.

### Ingress Route Registry

The first implementation should use D1 as the level-1 ingress lookup registry.
A D1 lookup indexed by exact normalized hostname can resolve a Project-owned
hostname to the Project Durable Object fetch destination. This avoids KV
consistency concerns while the model is still changing, but D1 is still a
projection of Project Durable Object desired state, not the lifecycle authority.

The global D1 registry stores project-owned exact-host rules only. It should not
store rows for `os.iterate2.com`, workers.dev, or other OS2 App entrypoints.
Anything that does not match a stored global ingress rule falls through to the
OS2 App Worker, which can then handle or reject the request however TanStack
Start and the OS2 control plane decide.

Project-owned global ingress rules should store `project_id` as a first-class
column as well as inside the fetch callable props. The `callable`
describes how to execute the route target; `project_id` describes the data
scope and supports SQL queries such as listing every ingress hostname for a
Project.

Project-owned ingress mutations should go through the Project Durable Object.
The Project Durable Object records desired state locally and writes global D1
rows as queryable projections for the hot Worker path. V1 can write those
projections synchronously for conceptual simplicity, but Durable Object SQLite
and D1 are not one atomic transaction; reconciliation is explicit follow-up
work rather than hidden complexity in the first implementation.

Future versions can cache this registry in the main Worker or KV, but cache
entries must be treated as projections of the Project Durable Object's desired
state, not as the source of truth.

Project Durable Objects should store their own project-local ingress route
tables in Durable Object SQLite. These route tables can include runtime-loaded
destinations, OS2-packaged destinations such as the MCP server, and public
custom-hostname destinations such as a website served from the custom hostname
apex.

When a Project is created, OS2 should create both the slug and stable platform
hosts, plus matching MCP hosts such as `mcp.<project-slug>.iterate.app` and
`mcp.<project-id>.iterate.app`. When a custom host is added, OS2 should also add
the custom host's MCP route. For example, a project with `mycustomer.com` should
have `mcp.mycustomer.com` pointing at the `ProjectMcpServerEntrypoint` loopback
fetch callable. Stream hosts such as `streams.mycustomer.com` should point at
the Events app URL fetch callable. Slug changes should update slug-derived routes at the same
time; alias lifecycle is future work.

## Contract

`apps/os2-contract` owns the typed RPC surface. `src/orpc/orpc.ts` binds implementation to contract.

## Database

sqlfu is the database source of truth:

- `src/db/definitions.sql` declares the desired schema
- `src/db/migrations/*.sql` is the migration history
- `src/db/queries/*.sql` contains checked-in application queries
- `src/db/queries/.generated` and `src/db/migrations/.generated` are regenerated with `pnpm sqlfu:generate`

OS2 data model design should make record scope explicit. Persisted records are
scoped by one of:

- Project
- Clerk Organization
- Clerk User
- Global

That scope should be represented by first-class queryable columns, not only
inside JSON blobs, metadata, or callable props. For example, a global ingress
rule that routes to a Project should store `project_id` as a column even though
the executable `callable_json` also contains the Project ID. The column is
what powers ownership checks, indexed listing, repair jobs, and "show me all
routes for this Project" views.

There are two different D1-backed tracking concepts:

- App-level projection tables, such as `projects` and ingress rules, are product
  query state derived from Project Durable Object lifecycle commands.
- Shared Durable Object catalog tables, owned by the durable-object-utils
  mixins, track initialized Durable Objects independently of product tables.

Durable Objects should use the shared Iterate Durable Object base from
`@iterate-com/shared/durable-object-utils/iterate-durable-object` unless they
have a specific reason not to. That base stacks runtime core adapters,
lifecycle hooks, D1 object catalog projection, the DO-local SQLite inspector,
and the DO-local KV inspector.

The OS2 Worker entrypoint should mount the shared Durable Object utility routes
needed to initialize, inspect, list, or repair those objects. These are
infrastructure routes, not TanStack product routes, and should stay distinct
from the app-level project D1 table.

For now the main worker exposes direct Durable Object debug fetch URLs:

- `/__durable-objects/project/<name>/__outerbase`
- `/__durable-objects/project/<name>/__kv`
- `/__durable-objects/codemode-session/<name>/__outerbase`
- `/__durable-objects/project-mcp-server-connection/<name>/__kv`

The worker strips `/__durable-objects/<kind>/<name>` and forwards the remaining
path to the named Durable Object stub's `fetch()`.

The current domain table is `projects`: `id`, `slug`, `clerk_org_id`,
`created_by_clerk_user_id`, `custom_hostname`, `metadata`, `created_at`, and
`updated_at`. A project belongs to exactly one Clerk Organization. Project IDs
are generated in TypeScript with the shared TypeID helper using local prefix
`proj` and app config `typeIdPrefix`.

`created_at` defaults in SQL. `updated_at` is set by the app's update queries
instead of a SQLite trigger because the Cloudflare D1 migration API rejected the
trigger migration with `SQL_INPUT_ERROR`/`incomplete input`, while Alchemy also
needs to apply the same plain migration files during deploy.

`alchemy.run.ts` points the Cloudflare D1 binding at `./src/db/migrations`, so
`pnpm cf:dev` and `pnpm cf:deploy` apply the same SQL migrations that sqlfu
tracks. `sqlfu.config.ts` uses sqlfu's D1 migration preset against Alchemy's
local Miniflare D1, so `pnpm sqlfu:check` and `pnpm sqlfu:migrate` use the same
D1 migration table shape as Alchemy/Wrangler once `.alchemy/local/wrangler.jsonc`
has been materialized.

## Clerk Auth

First-party references:

- Clerk TanStack Start middleware:
  https://clerk.com/docs/reference/tanstack-react-start/clerk-middleware
- Clerk TanStack Start provider:
  https://clerk.com/docs/tanstack-react-start/reference/components/clerk-provider
- Clerk TanStack Start custom sign-in catch-all route:
  https://clerk.com/docs/tanstack-react-start/guides/development/custom-sign-in-or-up-page
- Clerk redirect URL behavior:
  https://clerk.com/docs/guides/custom-redirects
- Clerk Organization switcher:
  https://clerk.com/docs/tanstack-react-start/reference/components/organization/organization-switcher
- Clerk Organization list:
  https://clerk.com/docs/tanstack-react-start/reference/components/organization/organization-list
- Clerk Organizations:
  https://clerk.com/docs/organizations/overview
- Clerk OAuth token verification:
  https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens
- Clerk OAuth / MCP guide:
  https://clerk.com/docs/nextjs/guides/ai/mcp/build-mcp-server
- Clerk OAuth implementation:
  https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth
- Clerk OAuth application create/update API:
  https://clerk.com/docs/reference/backend/oauth-applications/create and
  https://clerk.com/docs/reference/backend/oauth-applications/update
- Clerk Google social connection:
  https://clerk.com/docs/authentication/social-connections/google
- Clerk CLI:
  https://clerk.com/docs/cli
- Cloudflare `McpAgent` auth props:
  https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent-api/
- oRPC context and middleware:
  https://orpc.dev/docs/context and https://orpc.dev/docs/middleware

Clerk apps and Doppler config are managed by
`apps/os2/scripts/sync-clerk-apps.ts`. Re-run it after changing Clerk auth
shape so every OS2 dev, preview, and prd Doppler config gets the same schema
keys and the matching Clerk app/OAuth app configuration.

Required Clerk setup:

1. Enable Organizations for the Clerk application used by OS2.
2. Configure the app to require organization context for OS2 usage. OS2 also
   hides Clerk Personal Account mode in the sidebar with `hidePersonal`.
3. Copy the Clerk publishable key, secret key, and JWT public key into OS2
   runtime config.
4. Create/update a Clerk OAuth Application for OS2 MCP/CLI clients. Keep token
   format as JWT, enable public/PKCE clients, require consent, add the loopback
   redirect URI for CLI auth, and enable Dynamic Client Registration for MCP
   clients that self-register.
5. The MCP OAuth application only needs Clerk-supported data scopes such as
   `openid`, `email`, and `profile`; OS2 authorization remains org/project
   scoped in app code.
6. Google social login is enabled for dev/preview apps through Clerk's shared
   development credentials. Production Clerk instances require custom Google
   OAuth credentials and the exact Clerk Authorized Redirect URI configured in
   Google Cloud.

Project MCP routes expose a protected OAuth resource on a project-owned MCP
hostname, such as `https://mcp.mycustomer.com`. OS2 publishes RFC 9728 metadata
at `/.well-known/oauth-protected-resource` on that hostname, pointing clients at
Clerk as the authorization server. The Project MCP Server Entry Point verifies
Clerk-issued OAuth bearer tokens with Clerk's SDK using
`acceptsToken: "oauth_token"`. If the token is JWT-formatted, OS2 also reads
Clerk org claims with the configured JWT public key before passing identity
props to the Project MCP Server Connection Durable Object. Opaque OAuth tokens
are valid Clerk OAuth tokens but currently fail OS2's MCP org check unless the
token can still be mapped to an active Clerk Organization.

Project-owned MCP scopes and route-specific authorization belong to the generic
Project Route Authorization model, not to an MCP-specific Project Durable Object
method. Until that model exists, keep the entrypoint implementation small and
explicit: verify Clerk OAuth in `ProjectMcpServerEntrypoint`, call the generic
Project Access Check on the Project Durable Object, then pass verified identity
props to `ProjectMcpServerConnection`.

## Routes

OS2 user-facing app routes are organization-scoped:

- `/orgs/$organizationSlug/projects`
- `/orgs/$organizationSlug/projects/$projectSlug`
- `/orgs/$organizationSlug/projects/$projectSlug/run-code`
- `/orgs/$organizationSlug/projects/$projectSlug/presets`
- `/orgs/$organizationSlug/projects/$projectSlug/settings`

The project root redirects to `run-code`. Project route reads are scoped by the
active Clerk Organization plus project slug; project mutations can still use the
stable project ID returned by the API.

## Middleware Notes

`src/start.ts` installs Clerk's TanStack Start request middleware. Request
logging is owned by the shared `withEvlog()` wrapper in the Worker runtime
entrypoint.

## Codemode

Execute JavaScript in isolated dynamic worker sandboxes via oRPC or MCP.

- **UI:** `/orgs/$organizationSlug/projects/$projectSlug/examples` and
  `/orgs/$organizationSlug/projects/$projectSlug/codemode-sessions/new` create
  project-scoped Codemode Sessions with a streaming event log.
- **oRPC:** `codemode.createSession` creates or attaches to a Codemode Session;
  `codemode.executeScript` starts another Script Execution on a stream; and
  `codemode.streamEvents` reads the session Event Stream Path.
- **MCP:** `run_code` tool on the project MCP route, for example
  `https://mcp.mycustomer.com`

Codemode Tool Providers have one durable registration event:

```ts
{
  type: "events.iterate.com/codemode/tool-provider-registered",
  payload: {
    path: ["petstore"],
    instructions: "Call listOperations() before calling operation IDs.",
    invocation: { kind: "rpc", callable },
    // or: invocation: { kind: "event" },
  },
}
```

Every Tool Function uses the same trace events:

```ts
ctx.petstore.findPetsByStatus({ status: "available" });

// events.iterate.com/codemode/function-call-requested
// events.iterate.com/codemode/function-call-completed
```

That requested/completed pair is invariant. The difference is who appends the
completion:

- For an RPC Tool Provider, the Codemode Processor appends
  `function-call-requested`, invokes `executeCodemodeFunctionCall(...)`, and
  appends `function-call-completed` with `returned` or `threw`.
- For an Event-Mediated Tool Provider, the Codemode Processor appends
  `function-call-requested` and waits; the provider implementation, such as a
  Slack processor or browser extension runner, owns appending the matching
  `function-call-completed` event when it returns or throws.

RPC providers can pass Cloudflare live values such as callback functions and
returned `RpcTarget` handles. A `session-started` singleton event carries the
Session Capability Callable so event-based providers can build a Codemode
Context and call other providers.

Default providers are registered for every session:

- `fetch(...)` / `ctx.fetch(...)` routes through `FetchCapability` and is logged
  as a normal Function Call. Project egress policy belongs inside this
  capability.
- `ctx.streams.append(...)`, `ctx.streams.read(...)`, `ctx.streams.getState(...)`,
  and `ctx.streams.listChildren(...)` route through `StreamCapability`.

The current built-in examples cover Workers AI, OpenAPI, stream append, repo
and workspace live handles, both `ctx.createSubagent().sendMessage(...)` and
`ctx.makeSubagent().doThing(...)`, oRPC discovery generated from contract
schemas, and ordinary `fetch`/`console.log` traces.
Provider-generated type definitions target a shared `CodemodeExecutionContext`
root named `ctx`, so discovery output can include core functions such as
`ctx.fetch` and `ctx.console` while each provider contributes methods nested
under its mounted path, for example `ctx.os` or `ctx.builtin.slack`.

The inbound MCP server deliberately keeps `run_code` small:

```ts
run_code({
  code: `async (ctx) => {
    const agent = await ctx.createSubagent();
    const sent = await agent.sendMessage({ message: "hi", subPath: "bob" });
    const pipelined = await ctx.makeSubagent().doThing({ label: "demo", value: 21 });
    return { sent, pipelined };
  }`,
});
```

The project MCP route auto-loads the static proof provider stack for now; MCP
clients should not pass provider registrations into `run_code`. The explicit
`createSubagent()` handle remains part of the proof surface because it exercises
normal Workers RPC live values. `makeSubagent().doThing(...)` separately proves
that a root unary Tool Provider can return a promise-pipelineable handle.

### Codemode MCP E2E

`apps/os2/e2e/vitest/codemode-mcp-provider-stack.e2e.test.ts` is the
deployment-targeted proof that the static inbound MCP codemode stack works
without mocked internet. Point it at a project MCP route from local Miniflare,
preview, or production:

```bash
OS2_E2E_MCP_URL=https://mcp__demo.iterate-preview-2.app \
OS2_E2E_MCP_BEARER_TOKEN="$ADMIN_OR_MCP_ACCESS_TOKEN" \
pnpm --dir apps/os2 test:e2e:codemode-mcp
```

Set `OS2_E2E_SLACK_CHANNEL_ID=C123...` to include a real
`ctx.slack.chat.postMessage(...)` call. Without that variable, the test still
proves the real project MCP `run_code({ code })` surface, external `fetch`, the
static Petstore OpenAPI provider, Workers AI capability path, repo/workspace
callbacks, explicit and promise-pipelined subagent handles, oRPC discovery and
execution, and stream append/readback.

### Using the MCP server with Claude CLI

After the Clerk OAuth Application is configured with Dynamic Client
Registration, add the OS2 remote MCP endpoint to the project:

```bash
claude mcp add --transport http os2 https://mcp.demo.iterate-dev-jonas.app --scope project
```

Then in any conversation: "Use run_code to compute the first 10 fibonacci
numbers". The client should discover OS2's protected-resource metadata and run
the Clerk OAuth flow.

### Testing oRPC with curl

```bash
# Start code execution (returns the committed script-execution-requested event)
curl 'https://os.iterate-dev-jonas.com/api/codemode/scripts' \
  -X POST -H 'content-type: application/json' \
  -d '{"code":"async () => 1 + 1","providers":[]}'

# Compatibility endpoint (returns SSE event stream)
curl 'https://os.iterate-dev-jonas.com/api/codemode/execute' \
  -X POST -H 'content-type: application/json' \
  -d '{"code":"async () => 1 + 1","providers":[]}'
```

## Dev

```bash
doppler run --config dev -- pnpm alchemy:up    # dev deploy
doppler run --config prd -- pnpm alchemy:up    # production-style deploy
doppler run --config dev -- pnpm alchemy:down  # destroy the dev stack
pnpm dev            # Cloudflare local dev
pnpm cf:deploy      # Deploy to Cloudflare
pnpm sqlfu:generate # Regenerate typed SQL wrappers and bundled migrations
pnpm sqlfu:check    # Check migration history against definitions.sql
pnpm sqlfu:ui       # Start the sqlfu UI bridge, then open https://sqlfu.dev/ui
```

## Runtime config

Runtime config is assembled from:

- optional base JSON in `APP_CONFIG`
- zero or more nested overrides in `APP_CONFIG_*`

The final merged object must satisfy the app schema. If `APP_CONFIG` is
missing, schema defaults and env overrides can still produce a valid config.

Overrides use `__` as the nesting separator and convert env-style keys to the
schema's camelCase shape. For OS:

- `APP_CONFIG_BASE_URL=https://os.iterate2.com` -> `baseUrl`
- `APP_CONFIG_CLERK__PUBLISHABLE_KEY=pk_test_...` -> `clerk.publishableKey`
- `APP_CONFIG_CLERK__SECRET_KEY=sk_test_...` -> `clerk.secretKey`
- `APP_CONFIG_CLERK__JWT_KEY='-----BEGIN PUBLIC KEY-----...'` -> `clerk.jwtKey`
- `APP_CONFIG_CLERK__OAUTH_CLIENT_ID=...` -> `clerk.oauthClientId`
- `APP_CONFIG_CLERK__OAUTH_CLIENT_SECRET=...` -> `clerk.oauthClientSecret`
- `APP_CONFIG_CLERK__MCP_OAUTH_SCOPES=["openid","email","profile"]` ->
  `clerk.mcpOauthScopes`
- `APP_CONFIG_OPEN_AI_API_KEY=sk-...` -> `openAiApiKey`
- `APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate2.app"]` -> `projectHostnameBases`
- `APP_CONFIG_TYPE_ID_PREFIX=os` -> `typeIdPrefix`
- `APP_CONFIG_LOGS__STDOUT_FORMAT=pretty` -> `logs.stdoutFormat`

The root route loads the typed `__internal.publicConfig` procedure over `/api`
during SSR. The app keeps the built-in PostHog proxy route from the source
template, but it does not enable PostHog by default.

## Deployment config

OS2 should stay vanilla for stream deployment: `alchemy.run.ts` exports
`StreamDurableObject` from the main Worker script and binds `STREAM` to that
local namespace. Do not set a stream Durable Object script-name override on OS2.
Other apps, such as Events, may use their own deployment config to bind to the
OS2 Worker script's `StreamDurableObject` export.

OS:

```json
{
  "clerk": {
    "publishableKey": "pk_test_...",
    "secretKey": "sk_test_...",
    "jwtKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "oauthClientId": "...",
    "oauthClientSecret": "..."
  },
  "typeIdPrefix": "os",
  "logs": {
    "stdoutFormat": "raw"
  }
}
```

OS override:

```bash
APP_CONFIG_BASE_URL=https://os.iterate-dev-jonas.com \
APP_CONFIG_PROJECT_HOSTNAME_BASES='["iterate-dev-jonas.app"]'
```
