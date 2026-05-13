---
state: in_progress
priority: high
size: large
dependsOn: []
---

# Project Ingress Architecture

This is the implementation brief for the OS2 Project ingress redesign. It
captures the settled model from the grill-with-docs session and should be the
main reference before writing code.

## Current Status

Status as of 2026-05-05: the first architecture skeleton is implemented, but
not every route/destination has strong end-to-end validation. This task now
tracks the gap between the design target and the current proof-of-concept.

Implemented and validated:

- [x] Main OS2 Worker performs exact-host ingress lookup before TanStack Start
      fallback.
- [x] `ProjectIngressEntrypoint` exists and delegates to the Project Durable
      Object by Project ID.
- [x] `ProjectMcpServerEntrypoint` exists and can render static browser setup
      instructions for an MCP host.
- [x] `ProjectDurableObject` is exported from the main OS2 worker and bound as
      `PROJECT`.
- [x] Project creation goes through `ProjectDurableObject.createProject(...)`.
- [x] Project creation writes local Project state, app-level `projects`
      projection, global `ingress_routes` projection, project-local routes, and
      seeded codemode presets.
- [x] New projects get slug, stable ID, MCP, and streams platform hosts for the
      configured platform hostname base.
- [x] New projects also get single-label MCP and streams aliases such as
      `mcp__<project-slug>.<base>` and `streams__<project-slug>.<base>` for
      wildcard-DNS propagation fallback.
- [x] Global exact-host route rows use first-class metadata columns plus one
      shared fetch `callable_json` target.
- [x] Project-local route rows use the same conceptual shape: metadata columns
      plus one shared fetch callable target.
- [x] MCP browser routing through `mcp.<project-host>` is covered by the project
      ingress Workerd test.
- [x] Shared URL fetch callables can preserve path/query and inject headers;
      this is covered by a focused unit test.
- [x] `ProjectMcpServerConnection` is the class/catalog name for inbound MCP
      server connections.
- [x] Direct Durable Object debug fetch URLs are mounted on the main worker and
      manually verified locally for `__kv` and `__outerbase`.

Implemented but not sufficiently validated:

- [ ] Streams ingress full path:
      `streams.<project-host>` -> global D1 route -> Project DO local route ->
      Events app URL with `x-iterate-project-id`. The callable header injection
      is unit-tested, but the complete ingress path is not.
- [ ] MCP OAuth client path through project host routing. The entrypoint
      authenticates Clerk OAuth tokens and calls `Project.checkAccess(...)`, but
      the host-routed MCP OAuth path is not covered end-to-end.
- [ ] Generic `Project.checkAccess(...)` behavior. The method exists and is
      used by the MCP entrypoint, but it only has indirect coverage.
- [ ] Browser create-project flow redirect. The oRPC route delegates to
      `createProject(...)`, but the UI form and redirect need browser/spec
      validation after the ingress changes.
- [ ] Direct Durable Object debug fetch URLs. Manually verified on localhost,
      but no automated coverage.

Not implemented in this slice:

- [ ] Custom hostname lifecycle and routing for `<custom-host>`,
      `mcp.<custom-host>`, and `streams.<custom-host>`.
- [ ] Cloudflare DNS record creation.
- [ ] Cloudflare custom hostname setup and certificate provisioning.
- [ ] Project-owned dashboard host routing such as
      `iterate.<project-ingress-host>`.
- [ ] Slug change route updates and alias lifecycle.
- [ ] Full Project Route Authorization policy language.
- [ ] Projection repair/reconciliation between Project DO SQLite and D1.
- [ ] KV/cache projections for hot ingress lookup.
- [ ] Separate skinny public OS2 ingress worker script.

Immediate next validation work:

- [ ] Add a Workerd test for `streams.demo.iterate.localhost/...` proving the
      request reaches a mock/events fetch target with path, query, and
      `x-iterate-project-id` intact.
- [ ] Add a Workerd or browser-level test for Project DO debug forwarding.
- [ ] Add a focused test for `Project.checkAccess(...)` success/failure.
- [ ] Add or update a browser/spec flow for creating a project and landing on
      the Project detail page.
- [ ] Decide whether MCP OAuth host-routing needs a dedicated Workerd test or
      can be covered by adapting the existing inbound MCP test.

## Goal

Make the Project Durable Object the lifecycle authority for OS2 Projects, and
make HTTP ingress route to Projects through a small, explicit, host-first
routing model.

The desired first implementation should be conceptually small:

- the public OS2 Worker classifies requests by hostname
- project-owned hostnames route to `ProjectIngressEntrypoint`
- `ProjectIngressEntrypoint` delegates to the `Project` Durable Object
- the `Project` Durable Object owns project lifecycle, project-local routes,
  and project-owned desired state
- D1 tables exist for listing and fast lookup, but are projections
- TanStack/oRPC routes stay thin and proxy project lifecycle commands to the
  Project Durable Object

Backwards compatibility is not required for this proof of concept. Existing
OS2 project/MCP/codemode routes, D1 rows, Durable Object class names, and
deployed proof-of-concept resources can be broken or deleted if that keeps the
system simpler.

## Core Terms

- **Project Durable Object**: the lifecycle authority for one Project.
- **Project Control Surface**: RPC methods on the Project Durable Object.
- **Create Project Command**: domain command named `createProject`, not
  `initializeProject`.
- **Project Listing Projection**: app-level D1 `projects` row used for listing,
  route lookup, and app queries.
- **Durable Object Catalog**: lifecycle-owned D1 tables configured with
  `d1ObjectCatalog`, separate from product tables.
- **Project Ingress Host**: a rootable Project-owned host.
- **Default Project Ingress Host**: the host OS2 uses for ordinary generated
  public URLs.
- **Project Ingress Entry Point**: `ProjectIngressEntrypoint`.
- **Project MCP Server Entry Point**: `ProjectMcpServerEntrypoint`.
- **Project MCP Server Connection**: Durable Object named
  `ProjectMcpServerConnection`; it represents one external MCP client
  connection into OS2's project-scoped MCP server.
- **Project Route Destination**: project-local route target.
- **Project Access Check**: generic v1 Project DO access check.
- **Project Route Authorization**: future generic destination-level policy.

## Data Scope Rule

Every persisted OS2 record should be explicitly scoped by one of:

- Project
- Clerk Organization
- Clerk User
- Global

Scope must be queryable through first-class columns, not only hidden inside
JSON metadata or callable props. For example, a global ingress rule targeting a
Project stores `project_id` as a column even though the serialized
`callable_json` also contains the same value.

## Worker Shape

The main OS2 worker should export named WorkerEntrypoint classes from
`src/entrypoints/`:

- `ProjectIngressEntrypoint`
- `ProjectMcpServerEntrypoint`

For now, the `Project` Durable Object should also be exported from the main OS2
worker. This is a deliberate near-term exception to the usual preference for
tiny dedicated Durable Object worker scripts, because same-worker loopback
bindings (`ctx.exports`) can receive dynamic `props`.

The default fetch path should become mostly:

1. resolve global exact-host ingress route
2. if matched, dispatch its `callable`
3. otherwise fall through to the TanStack Start app

MCP special-casing should move out of default fetch and into
`ProjectMcpServerEntrypoint`.

For debugging, the main worker may expose direct Durable Object fetch URLs that
strip a debug prefix and forward to `stub.fetch()`. The current shape is:

- `/__durable-objects/project/<name>/__outerbase`
- `/__durable-objects/project/<name>/__kv`
- `/__durable-objects/codemode-session/<name>/__outerbase`
- `/__durable-objects/project-mcp-server-connection/<name>/__kv`

These are infrastructure/debug routes on the main worker entrypoint, not
product routes owned by TanStack Start.

## Project Durable Object

Class name and binding:

- class: `ProjectDurableObject`
- namespace binding: `PROJECT`
- Durable Object name: Project ID

Use the shared Iterate Durable Object base from
`@iterate-com/shared/durable-object-utils/iterate-durable-object`. That base
stacks:

- `withDurableObjectCore`
- `withLifecycleHooks`
- lifecycle `d1ObjectCatalog`
- `withOuterbase`
- `withKvInspector`

The inherited lifecycle `initialize(...)` method remains infrastructure. The
domain command should be named `createProject(...)`.

### Create Project Flow

The TanStack/oRPC app worker is responsible for admission:

1. authenticate Clerk user and active Clerk Organization
2. validate requested Project slug
3. allocate Project ID
4. get Project DO by name using Project ID
5. call `projectStub.createProject(...)`

The Project DO is responsible for lifecycle creation:

1. write local Project lifecycle state
2. write app-level `projects` D1 projection
3. write global ingress exact-host projections
4. write project-local route table entries
5. seed Project-owned codemode presets
6. return enough data for the RPC caller to redirect to the Project detail page

After the desired durable state is written, asynchronous work can continue:

- Cloudflare DNS records
- custom hostname setup
- certificate provisioning
- future route repair/reconciliation

Do not block the first UI redirect on all external provisioning completing.

## Ingress Route Tables

Global and project-local route tables should use the shared HTTP route matcher
model from `packages/shared/src/http-route-matcher`. The same model must also
be used by Project Egress rules that match outbound requests to policy or
Secret pipeline targets. V1 only needs exact-host rules.

Suggested stored rule shape until the shared package exists:

```ts
type ExactHostIngressRule = {
  id: string;
  priority: number;
  host: string;
  projectId: string | null;
  notes: string | null;
  callable: FetchCallable;
  createdAt: string;
  updatedAt: string;
};
```

Suggested global D1 table:

```sql
CREATE TABLE ingress_routes (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL UNIQUE,
  project_id TEXT,
  priority INTEGER NOT NULL,
  notes TEXT,
  callable_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL
);

CREATE INDEX ingress_routes_project_id_idx ON ingress_routes(project_id);
CREATE INDEX ingress_routes_host_idx ON ingress_routes(host);
```

The global table stores only project-owned exact-host routes. It does not store
fallback rows for `os.iterate2.com`, workers.dev, or the TanStack Start app.
Fallback to the OS2 app is caller-provided code.

The matcher should move to `packages/shared/src/http-route-matcher`; do not let
Project Ingress and Project Egress grow separate matcher models. It should be a
pure library function over:

- request URL/headers
- a route lookup abstraction
- caller-provided fallback rules

The local `apps/os2/src/ingress/` matcher is only a temporary implementation
gap, not the target architecture. See `shared-http-route-matcher.md`.

## Fetch Callable Shape

V1 needs loopback entrypoint fetch callables and the OS2 app fallback.

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

The property is `callable` directly on the rule. Do not wrap it in an OS2
destination object.

## Project Hosts

Each Project should have several rootable Project Ingress Hosts:

- Slug Project Ingress Host: `<project-slug>.iterate.app`
- Stable Project Ingress Host: `<project-id>.iterate.app`
- Custom Project Ingress Host: optional, e.g. `mycustomer.com`

The Default Project Ingress Host is:

1. custom host if present
2. otherwise slug platform host

The stable ID host always remains routable, but is not the normal user-facing
URL.

At Project creation, create:

- `<project-slug>.iterate.app`
- `<project-id>.iterate.app`
- `mcp.<project-slug>.iterate.app`
- `mcp.<project-id>.iterate.app`
- `mcp__<project-slug>.iterate.app`
- `mcp__<project-id>.iterate.app`
- `streams.<project-slug>.iterate.app`
- `streams.<project-id>.iterate.app`
- `streams__<project-slug>.iterate.app`
- `streams__<project-id>.iterate.app`

The double-underscore MCP and streams hosts are single-label aliases. They are
not canonical user-facing URLs; they exist so `*.iterate.app`-style wildcard DNS
can route project MCP and streams traffic while deeper wildcard records such as
`mcp.<project-slug>.iterate.app` are unavailable or still propagating.

When a custom host is added, create:

- `<custom-host>`
- `mcp.<custom-host>`
- `streams.<custom-host>`

Slug changes do not need to be implemented in this first pass, but the intended
model is that slug-derived routes update with the slug. Alias lifecycle is
future work.

## Streams Routing

The streams host prefix is always `streams`.

Streams are host-routed, not path-routed. Use:

- `streams.mycustomer.com`
- `streams.<project-slug>.iterate.app`
- `streams.<project-id>.iterate.app`
- `streams__<project-slug>.iterate.app`
- `streams__<project-id>.iterate.app`

The global D1 route still resolves each exact streams hostname to
`ProjectIngressEntrypoint`, so the Project Durable Object remains the authority
for the route. The Project DO then dispatches a project-local shared fetch
callable to the production Events app:

- base URL: `https://events.iterate.com`
- injected header: `x-iterate-project-id: <project-id>`

The proxy preserves path and query string. For example,
`https://streams.demo.iterate.app/api/streams/foo` is fetched from
`https://events.iterate.com/api/streams/foo` with the Project ID header set.

## Project Dashboard Host

There should be a future project-owned dashboard route:

- `iterate.<project-ingress-host>`

For example:

- `iterate.mycustomer.com`

This should route to the OS2 dashboard for that Project. It is not the global
OS2 dashboard host; it is a project-local route destination that forwards to
the OS2 app with enough Project context.

This does not need to be implemented before the first ingress vertical slice,
but the route model should allow it.

## MCP Routing

The MCP host prefix is always `mcp`.

MCP is host-routed, not path-routed. Do not use `mycustomer.com/mcp` as the
Project MCP route. Instead:

- `mcp.mycustomer.com`
- `mcp.<project-slug>.iterate.app`
- `mcp.<project-id>.iterate.app`
- `mcp__<project-slug>.iterate.app`
- `mcp__<project-id>.iterate.app`

The Project DO routes the entire MCP hostname to
`ProjectMcpServerEntrypoint`. Every path on that hostname belongs to the entry
point. The entry point owns:

- MCP protocol paths
- OAuth protected-resource metadata
- browser/static HTML instructions
- 404s for unsupported paths

TanStack Start does not need to render the MCP instructions page.

## MCP Naming

The inbound MCP server connection Durable Object has been renamed:

- old class/catalog idea: `IterateMcpServer`
- new class/catalog name: `ProjectMcpServerConnection`

The name should describe one external MCP client connection into OS2's
project-scoped MCP server. This must remain distinct from future
`OutboundMcpClientConnection`, where OS2 is the client connecting to an
external MCP server.

## MCP Auth Boundary

Do not add destination-specific Project DO methods such as
`authorizeMcpServerConnection(...)`.

V1 boundary:

1. `ProjectMcpServerEntrypoint` verifies Clerk OAuth protocol details.
2. It calls a generic Project DO Project Access Check.
3. The Project DO uses the D1 `projects` projection to verify that the
   principal's Clerk Organization can access the Project.
4. The entrypoint passes verified identity props to `ProjectMcpServerConnection`.

Future work should design generic Project Route Authorization for Project Route
Destinations and route-specific scopes.

## Project Access Check

V1 can expose a generic Project DO method such as:

```ts
checkAccess({
  principal: {
    clerkUserId,
    clerkOrgId,
    clerkOrgRole,
    clerkOrgPermissions,
  },
});
```

It should be project-level, not MCP-specific. It can return a small domain
result or throw a domain error; it should not return an HTTP `Response`.

## D1 Projections And Repair

D1 projections are not the lifecycle authority:

- `projects` is a Project Listing Projection
- `ingress_routes` is a global exact-host lookup projection
- durable-object-utils catalog tables are infrastructure discovery state

The Project DO owns desired state. V1 can write projections synchronously from
Project Control Surface commands, even though Durable Object SQLite and D1 are
not one atomic transaction.

Track reconciliation separately. Existing follow-up:

- `tasks/os2-project-do-projection-reconciliation.md`
- `tasks/os2-project-route-authorization.md`

The OS2 Worker entrypoint should mount durable-object-utils infrastructure
routes needed for initialization/catalog/repair workflows. Those routes are not
TanStack product routes.

## Implementation Scope Checklist

Implement the architecture skeleton and first vertical slice:

- [x] Project DO class and binding
- [x] `ProjectIngressEntrypoint`
- [x] `ProjectMcpServerEntrypoint`
- [x] exact-host ingress route schema and matcher
- [x] project creation through Project DO `createProject`
- [x] D1 projections for project listing and global ingress
- [x] project-local route table in Project DO SQLite
- [x] MCP static instructions page from the entrypoint
- [x] MCP OAuth verification in the entrypoint
- [x] generic Project Access Check on Project DO
- [x] rename MCP connection DO/class/catalog to `ProjectMcpServerConnection`

Do not implement in this first slice:

- [ ] Cloudflare custom hostname automation
- [ ] DNS record provisioning
- [ ] certificate provisioning
- [ ] slug alias lifecycle
- [ ] full Project Route Authorization policy language
- [ ] KV/cache projections
- [ ] separate public OS2 ingress worker script

## Acceptance Criteria

- [ ] Creating a Project calls `Project.createProject(...)` and redirects to the
      Project detail route after durable desired state/projections are written.
- [x] Global ingress lookup can route both slug and stable ID platform hosts to the
      Project DO through `ProjectIngressEntrypoint`.
- [x] Project-local routing can route MCP hosts to `ProjectMcpServerEntrypoint`.
- [x] Browser visits to an MCP host show static setup instructions.
- [ ] MCP client requests are OAuth-verified by `ProjectMcpServerEntrypoint`.
- [ ] `ProjectMcpServerEntrypoint` calls the Project DO's generic Project Access
      Check before creating/using `ProjectMcpServerConnection`.
- [ ] The TanStack/oRPC Project router contains minimal lifecycle logic and mostly
      delegates to the Project DO.
- [x] Existing `IterateMcpServer` naming is removed or clearly migrated to
      `ProjectMcpServerConnection`.
