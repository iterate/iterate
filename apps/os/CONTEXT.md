# OS

OS is an authenticated app where users manage organization-owned projects and run scripts through itx capability handles. This context defines the language for project ownership, itx capabilities, streams, and project ingress.

## Language

### Product Ownership

**OS App**:
The authenticated dashboard where users manage organization-owned projects and run itx scripts.
_Avoid_: Public site, marketing app

**Organization**:
The owning account boundary for projects in OS.
_Avoid_: Workspace, team, tenant, account

**Active Organization**:
The Organization selected by auth-worker session claims for organization-level
UI and project creation.
_Avoid_: Current workspace, selected account

**Personal Account**:
The auth worker's non-organization user context, which OS does not allow for project ownership.
_Avoid_: Personal organization, default organization

**User**:
A person authenticated by the auth worker who acts inside an Organization.
_Avoid_: Member, account

**OAuth Access Token**:
An auth-worker-issued OAuth access token used by a remote MCP client to call OS
as a protected resource.
_Avoid_: MCP JWT, session token

**Principal**:
The request-local authenticated actor resolved by OS from the admin API secret,
auth-worker session cookie, or auth-worker OAuth access token.
_Avoid_: Raw auth payload, token claims, provider-specific auth object

**Admin API Secret**:
The shared secret that grants OS operator automation full app-level authority.
_Avoid_: Admin user, admin session, root user

**Capability Scope**:
The authority boundary derived from a Principal that determines which OS
capabilities can be reached.
_Avoid_: Tenant context, organization context, permission bag

**Project**:
An OS-managed app surface owned by exactly one Organization.
_Avoid_: App, site, workspace

**Data Scope**:
The ownership boundary for a persisted OS record: Project, Organization, User, or Global.
_Avoid_: Tenant type, resource kind

**ID**:
A stable TypeID-prefixed identifier minted by OS for a durable domain object.
_Avoid_: slug, key, database rowid

**Slug**:
A human-readable locator constrained to hostname-safe lowercase letters, numbers, and hyphens.
_Avoid_: ID, arbitrary key

**Key**:
An arbitrary string locator chosen by a caller or integration for project-local lookup.
_Avoid_: ID, slug, hostname label

**Project ID**:
The stable TypeID-prefixed OS identifier for a Project.
_Avoid_: Project slug, Project Route

**Project Slug**:
The globally unique hostname-safe Slug used in Project Routes.
_Avoid_: Project ID

**Project Route**:
The dashboard URL for a Project, identified by Project slug under
`/projects/:projectSlug`.
_Avoid_: Organization-scoped project URL, project ID URL

**Project Route Context**:
The TanStack Router route context for a Project Route. It should resolve the pretty Project Slug into the Project row once so child routes can render with Project details and call project-scoped APIs with either slug or ID.
_Avoid_: Assuming inherited project data, page-local project state

**Project-Scoped itx Handle**:
An itx handle narrowed to one authorized Project. External callers select a
project by slug or stable ID at `/api/itx/:projectIdOrSlug`; the resolved
handle operates in that Project's capability scope.
_Avoid_: Raw projectId handler, unchecked project route

**Project Durable Object Namespace**:
The Worker environment binding used by server code to obtain Project Durable Object stubs.
_Avoid_: project context, resolved project

**Project MCP Route**:
The OS `/mcp` resource for project-scoped MCP sessions. OAuth access tokens
expose projects granted by token claims and scopes; admin-token sessions expose
all projects. Project-scoped tools such as `exec_js` select the Project per
invocation.
_Avoid_: Project MCP hostname, ingress MCP alias

**Ingress Hostname**:
A public hostname that OS can classify before running the OS App.
_Avoid_: Route, URL, domain

**Project-Owned Hostname**:
An Ingress Hostname owned by exactly one Project.
_Avoid_: Project URL, project domain

**Project Ingress Host**:
A rootable Project-Owned Hostname that sends requests to one Project's Project Ingress.
_Avoid_: Project URL, route path

**Slug Project Ingress Host**:
The human-readable platform Project Ingress Host derived from the Project Slug, such as `<project-slug>.<project-host-base>`.
_Avoid_: Stable project host

**Stable Project Ingress Host**:
The immutable platform Project Ingress Host derived from the Project ID, such as `<project-id>.<project-host-base>`.
_Avoid_: Slug project host, canonical host

**Project Ingress**:
Traffic for a Project-Owned Hostname after the OS Worker has classified it.
_Avoid_: App route, TanStack route

**Ingress Route Table**:
A set of ordered routing rules that match an HTTP request and resolve it to a Fetch Destination.
_Avoid_: URL map, hostname registry

**Ingress Routing Rule**:
One match rule inside an Ingress Route Table.
_Avoid_: TanStack route, route handler

**Exact Host Ingress Rule**:
An Ingress Routing Rule that matches exactly one normalized hostname.
_Avoid_: Host pattern, path rule

**Fallback Ingress Rule**:
A call-site supplied low-priority Ingress Routing Rule used when no more specific rule matches.
_Avoid_: Seed route, default row

**Fetch Destination**:
A route target that can accept an HTTP request through a fetch-shaped callable.
_Avoid_: Handler, app route, service

**Fetch Callable**:
The serializable route target description stored on an Ingress Routing Rule.
_Avoid_: Callable wrapper, destination callable

**OS Ingress Worker**:
The skinny Worker entrypoint that classifies public traffic and proxies it to Fetch Destinations.
_Avoid_: OS App, control plane app

**OS App Worker**:
The Worker that runs the authenticated OS App behind the OS Ingress Worker.
_Avoid_: Ingress worker, public worker

**Project Ingress Entry Point**:
A named WorkerEntrypoint exported as `ProjectIngressEntrypoint` that receives Project identity as props, resolves the Project Durable Object, and delegates Project Ingress to it.
_Avoid_: Project app worker, project service

**Project Egress**:
Future outbound HTTP/S policy work for Project-owned execution. Current itx
`fetch(...)` and `itx.fetch(...)` calls go through the default itx Fetch
Capability; full egress policy and secret injection live in
`tasks/project-egress-secrets-mvp.md`.
_Avoid_: Project Ingress, implemented gateway, implemented secret system

**Project Worker**:
The Project-owned dynamic Worker loaded from Project Repo code.
_Avoid_: OS App Worker, Project Durable Object, itx worker

**Project Worker Fetch**:
A direct `fetch` call against the Project Worker, bypassing public Project Ingress classification.
_Avoid_: Project Ingress, Project Egress, OS App fetch

**Project Egress Intercept Tunnel**:
An ephemeral Project-owned tunnel that can intercept outbound Project Egress fetches while connected.
_Avoid_: external egress proxy, egress gateway, intercept egress traffic

**Project Egress Tunnel**:
Short form for Project Egress Intercept Tunnel.
_Avoid_: project proxy, mock internet proxy

**Project Egress Intercept Route**:
The reserved Project-owned HTTP route used to connect a Project Egress Intercept Tunnel.
_Avoid_: mock route, test-only route, proxy URL

**Project Egress Intercept Test Helper**:
An e2e fixture helper that opens a Project Egress Intercept Tunnel for a test-owned Project.
_Avoid_: semaphore tunnel helper, external proxy fixture, mock internet proxy

**itx Fetch Capability**:
The default Project Egress capability used for `itx.fetch(...)` and bare
`fetch(...)` inside platform-loaded itx isolates. It is shadowable through
`itx.provideCapability({ name: "fetch", ... })`; the default pipe is where
secret placeholders are substituted.
_Avoid_: Raw Dynamic Worker fetch, untraced public fetch

**D1-backed Secrets Capability**:
The current project-bound capability authority for storing, listing, reading, updating, and deleting Project Secrets in D1.
_Avoid_: Secret Durable Object, separate secrets service

**Secret ID**:
The stable TypeID-prefixed identifier for one Project Secret.
_Avoid_: Secret Key, Secret Slug

**Secret Key**:
The project-local arbitrary Key used by Secret References to resolve one Project Secret.
_Avoid_: Secret ID, Secret Slug, hostname-safe name

**OS MCP Handler**:
The OS Worker `/mcp` handler that exposes the inbound MCP server, verifies OAuth
or admin credentials, selects the Project, and attaches a
**Project MCP Server Connection**.
_Avoid_: Project MCP hostname, ingress MCP entrypoint, Tool Provider, Capability wrapper

**Loopback Fetch Callable**:
A Fetch Callable that targets a named entrypoint exported by the same Worker and passes dynamic props through Cloudflare loopback bindings.
_Avoid_: Service binding with props, local function

**Project Durable Object**:
The authoritative runtime owner for one Project's ingress policy and project-local routing.
_Avoid_: Project row, project API

**ProjectDurableObject**:
The TypeScript class/export name for the Project Durable Object.
_Avoid_: ProjectGrubbleObject, Project DO class

**Project Control Surface**:
The RPC command surface on the Project Durable Object for managing Project lifecycle, ingress, destinations, and other project-owned state.
_Avoid_: project service layer, app-worker lifecycle logic

**Create Project Command**:
The Project Control Surface command that creates a Project's lifecycle state and projections.
_Avoid_: Initialize project, create project row

**Project Projection**:
A queryable record outside the Project Durable Object that is derived from the Project Durable Object's desired state.
_Avoid_: Source of truth, duplicate state

**Project Listing Projection**:
The app-level D1 `projects` row used by OS to list, route to, and search Projects.
_Avoid_: Project source of truth, Durable Object catalog row

**Durable Object Catalog**:
The shared mixin-owned D1 tracking table that records initialized Durable Objects for discovery and repair workflows.
_Avoid_: Project table, application projection

**Durable Object Utility Route**:
An infrastructure route mounted on the OS Worker entrypoint for initializing, inspecting, or listing Durable Objects through shared durable-object utilities.
_Avoid_: Product route, TanStack route

**Project Route Destination**:
A project-local target that a Project Durable Object can route Project Ingress to.
_Avoid_: App, service, endpoint

**Project Route Authorization**:
A future Project Durable Object-owned policy decision for whether a principal may access a Project Route Destination.
_Avoid_: MCP authorization, app-specific auth method

**Project Access Check**:
A generic Project Durable Object-owned check that decides whether an auth worker principal can access one Project.
_Avoid_: MCP authorization, route-specific permission

**Project Stream Explorer**:
The OS project-bound UI for discovering and inspecting every initialized Event Stream Path for one Project.
_Avoid_: generic stream explorer, stream tree

### Agents

**Agent**:
A project-scoped assistant work surface that users can list, open, and chat with. An Agent is identified inside one Project by an Agent Path.
_Avoid_: Project Agent, raw stream

**Agent Path**:
The project-local Event Stream Path that identifies one Agent within a Project.
_Avoid_: Agent ID, Project Agent path, global path

**Agent Durable Object**:
A project-scoped Durable Object representing one Agent.
_Avoid_: Script Execution, Tool Provider, assistant message

**AgentDurableObject**:
The TypeScript class/export name for the Agent Durable Object.
_Avoid_: Subagent class, Agent DO class

**withStreamProcessor**:
The Durable Object mixin API that lets a StreamProcessorRunner register one or more processor instances for one or more Event Stream Paths during lifecycle startup.
_Avoid_: withStreamProcessorHost, host mixin, dynamic processor registry

**Stream Processor waitUntil**:
A StreamProcessorRunner-provided best-effort in-memory function that lets processor hooks keep async work alive until a promise settles.
_Avoid_: Durable Object `ctx.waitUntil`, durable scheduler, alarm-backed task

**Stream Namespace**:
The stream runtime's stable owner key for a group of Event Stream Paths. OS uses the stable Project ID as the namespace; future runtime users may use non-project namespaces such as `platform`.
_Avoid_: Project ID inside shared stream runtime, tenant path prefix

**Repo Namespace**:
The stable owner key for a group of Repos, such as one Project ID or a global repo owner.
_Avoid_: Project ID field, repo owner object

**Workspace Namespace**:
The stable owner key for a group of Workspaces, such as one Project ID or a global workspace owner.
_Avoid_: Project ID field, workspace owner object

**Project Lifecycle Stream**:
The Project-owned root Event Stream Path `/` that records durable Project lifecycle facts.
_Avoid_: Project UI state stream, project activity log

**Project Lifecycle Event**:
A fact appended to the Project Lifecycle Stream about Project creation, ingress, provisioning, or repair.
_Avoid_: UI event, lifecycle command, log line

**Project Lifecycle Processor**:
The stream processor that interprets Project Lifecycle Events and performs Project provisioning work.
_Avoid_: Project UI reducer, project service, background job

**Project Lifecycle Reduced State**:
The derived Project lifecycle status produced by reducing Project Lifecycle Events.
_Avoid_: Project source of truth, frontend state, Project Projection

### itx and Capabilities

**Event Stream Path**:
The namespace-local stream address that an itx script or processor reads from
and appends to. In OS these paths are project-local because the Project ID is
already the Stream Namespace; they must not start with `/projects/{projectId}`.
_Avoid_: global path, Durable Object name

**StreamsBackend**:
A Project ID-backed RPC capability for stream operations. Its props bind the shared stream namespace to the Project ID, and optional `streamPath` props narrow calls to one namespace-local Event Stream Path.
_Avoid_: Generic stream client, cross-app stream client

**ReposCapability**:
A Project ID-backed itx capability for creating, listing, and selecting Repos
inside one Project.
_Avoid_: Repo service, Artifact client, GitHub client

**itx Handle**:
The local JavaScript object handed to scripts, browser code, workers, and
external clients. It holds built-in verbs such as `describe`,
`provideCapability`, and `extend`, plus dotted capability calls such as
`itx.slack.chat.postMessage(...)`.
_Avoid_: ExecutionContext, tools, legacy context tools

**itx Capability**:
A named callable surface visible from an itx Handle. A capability may be a live
JavaScript function or object, a Worker RPC address, or a path-call target that
implements `call({ path, args })`.
_Avoid_: Tool Provider, route, service

**Capability Instructions**:
String-form guidance registered with an itx Capability that tells script authors
how to use it.
_Avoid_: Documentation field, function registry, route manifest

**Callable Builder**:
A helper function that constructs a Callable descriptor for one Capability invocation shape.
_Avoid_: Static callable, callable JSON helper, descriptor factory

**Path Call**:
The normalized call envelope produced by the itx path proxy for dotted calls
such as `itx.slack.chat.postMessage(...)`.
_Avoid_: Function Call, Tool Function Call, direct RPC call

**Script Execution ID**:
The Script Execution correlation ID stored in itx script events.
_Avoid_: Script ID, requested offset field

**Capability Path**:
The registered itx path at which a capability is mounted.
_Avoid_: Root path, namespace, provider slug

**Function Path**:
The itx path remaining after the Capability Path has been matched.
_Avoid_: Relative path, method path, route

**Unary Capability**:
An itx capability whose Capability Path is itself callable and whose Function
Path is empty when called.
_Avoid_: Root tool, special function, direct callable

**Stateful Capability Endpoint**:
A directly addressable Durable Object or Worker endpoint that executes capability
calls while owning long-lived connection state.
_Avoid_: Singleton tool, direct service, provider runtime

**Outbound Capability Actor**:
A capability implementation that is not externally addressable and can only
observe requests or report results through outbound communication.
_Avoid_: Offline tool, browser tool, poll provider

**SDK-backed Capability**:
An itx capability whose Function Paths are mapped to calls on an underlying SDK
rather than enumerated as separate OS-owned function definitions.
_Avoid_: Generated tool registry, SDK route table

**RPC Capability**:
An itx capability whose implementation is reached through a Worker RPC target.
_Avoid_: Direct tool, live provider

**Live Tool Handle**:
A Cloudflare RPC value returned by an RPC Capability that exposes its own method
surface after the original Path Call returns.
_Avoid_: nested provider proxy, serialized data object

**Repo**:
A project-scoped versioned file tree identified by one Project ID and one Repo Slug.
_Avoid_: Repository row, GitHub repo, Cloudflare Artifacts repo

**Repo Slug**:
The project-local human-readable slug that identifies one Repo inside a Project.
_Avoid_: Repo ID, Artifact name, GitHub repo name

**Repo Stream**:
The Project-owned Event Stream Path `/repos/{repoSlug}` that records durable Repo lifecycle facts.
_Avoid_: Artifact log, repo activity feed, repo UI state

**Repo Lifecycle Event**:
A fact appended to a Repo Stream about Repo creation, backing storage, or future external connections.
_Avoid_: Git commit, Artifact API response, UI event

**Repo Created Event**:
The Repo Lifecycle Event that records the initial project-local Repo facts needed to derive Repo state.
_Avoid_: Create response, Artifact response, Repo row

**Repo Stream Processor**:
The stream processor that interprets Repo Lifecycle Events and derives Repo state.
_Avoid_: Repo service, Artifact wrapper, UI reducer

**Repo Reduced State**:
The current Repo state derived by reducing Repo Lifecycle Events from one Repo Stream.
_Avoid_: Repo row, Durable Object fields, frontend state

**Repo Token**:
A long-lived Cloudflare Artifacts write token stored in Repo Reduced State so a user or script can access a Repo's Git remote in the v1 prototype.
_Avoid_: API key, separate secret, token row

**Project Repo**:
The project-created Repo with slug `project` that stores project-local Iterate configuration.
_Avoid_: config artifact, project settings row, GitHub config repo

**Iterate Config Base Repo**:
The Cloudflare Artifacts repo named `iterate-config-base` that seeds each Project's Project Repo by Artifact fork.
_Avoid_: template row, default config object, GitHub template

**Cloudflare Artifacts**:
The Cloudflare-hosted Git-compatible storage service currently used as backing storage for OS Repos.
_Avoid_: Repo, GitHub repo, Artifact repo

**Repo Durable Object**:
A project-scoped Durable Object selected by Project ID and repo slug and exposed
through itx as a Live Tool Handle.
_Avoid_: Repository row, repo provider, GitHub repo

**Workspace Durable Object**:
A project-scoped Durable Object selected by Project ID and workspace slug and
exposed through itx as a Live Tool Handle.
_Avoid_: Organization, Project, workspace alias

**Workspace**:
A project-scoped live work surface exposed through `itx.workspace`.
_Avoid_: Organization, Project, workspace alias

**Outbound MCP From Our Client Capability**:
A Durable Object-backed itx capability that connects from OS to one external
MCP server using our MCP client connection and exposes that remote server as
itx capability paths.
_Avoid_: Project MCP Server Connection, inbound MCP server, MCP metadata provider, describe callable, MCP registry

**OpenAPI Client Capability**:
A capability that exposes one OpenAPI specification as itx capability paths.
_Avoid_: OpenAPI metadata provider, describe callable, OpenAPI registry

**Script**:
User-authored TypeScript or JavaScript code that can be run by itx.
_Avoid_: Function, tool, provider, execution

**Script Execution**:
One attempt to run a Script against an itx Handle.
_Avoid_: Script, execution ID, script ID

**Provider Bridge**:
An adapter that exposes an external system, such as OpenAPI or MCP, as an itx
Capability.
_Avoid_: tool provider descriptor, session capability

**Project MCP Server Connection**:
A Durable Object-backed connection from an external MCP client into OS's project-scoped MCP server, implemented by the `ProjectMcpServerConnection` Durable Object.
_Avoid_: Iterate MCP server, MCP client provider, outbound MCP connection

**Outbound MCP From Our Client Tool Provider**:
A Tool Provider registration whose RPC Callable targets an **Outbound MCP From Our Client Capability**.
_Avoid_: Project MCP Server Connection, project MCP route, inbound MCP

## Relationships

- The **OS App** has no public product pages; unauthenticated users are sent to auth-worker sign-in.
- The **OS App** hides **Personal Account** mode and requires an **Organization** context.
- Every persisted OS record should have an explicit **Data Scope**: Project, Organization, User, or Global.
- A record's **Data Scope** should be represented as first-class queryable columns, not only inside JSON payloads or callable props.
- The **Durable Object Catalog** is infrastructure state and is separate from application-level **Project Projections**.
- **Durable Object Utility Routes** may be mounted into the OS Worker entrypoint so app code can reuse shared Durable Object initialization, catalog, and lifecycle utilities.
- An **Organization** owns zero or more **Projects**.
- A **Project** belongs to exactly one **Organization**.
- The **Project Durable Object** is the lifecycle authority for a **Project**.
- Every **Project** has one **Project Lifecycle Stream** at root Event Stream Path `/` in that Project's **Stream Namespace**.
- The **Project Lifecycle Stream** records **Project Lifecycle Events** as facts, not frontend view state.
- Resource streams such as `/repos/{repoSlug}` are child Event Stream Paths inside the same Project Stream Namespace.
- The **Project Lifecycle Processor** may use **Project Lifecycle Reduced State** to decide follow-up work, but **Project Lifecycle Events** remain the shared durable facts.
- The OS frontend may reduce **Project Lifecycle Events** with the same reducer as the **Project Lifecycle Processor**, but it does not own the Project lifecycle model.
- The **Project Listing Projection** is derived query state and should be written by the **Project Durable Object** as part of Project lifecycle commands.
- A **Project** owns zero or more **Repos**.
- A **Repo** belongs to exactly one **Project**.
- A **Repo** is identified in OS by **Project ID** and **Repo Slug**; **Cloudflare Artifacts** is backing storage, not OS domain identity.
- A **Repo Durable Object** uses a structured Durable Object name derived from **Project ID** and **Repo Slug**.
- Every **Repo** has one **Repo Stream** at Event Stream Path `/repos/{repoSlug}` in that Project's **Stream Namespace**; the stream path is derived from **Repo Slug** and is not separate Repo identity.
- A **Repo Stream** records **Repo Lifecycle Events** as facts, not frontend view state.
- A **Repo Created Event** records the initial facts for one **Repo** and is consumed by the **Repo Stream Processor**.
- **Repo Reduced State** is derived from the **Repo Stream Processor**, not from ad hoc Durable Object fields or frontend state.
- The **Repo Created Event** payload is project-local; Project ID comes from the **Stream Namespace**, not the event payload.
- The initial long-lived **Repo Token** and Git remote details are part of the **Repo Created Event** and therefore part of **Repo Reduced State** returned by Repo info reads.
- Every new **Project** gets a **Project Repo** with Repo Slug `project`.
- The **Project Repo** is forked from the **Iterate Config Base Repo** during Project creation and then behaves like an ordinary **Repo**.
- **ReposCapability** owns Repo collection semantics for one **Project**; repo
  dashboard routes and scripts call it through itx instead of duplicating Repo
  lifecycle logic.
- Creating a **Repo** is explicit through **ReposCapability** create behavior and fails if that Repo already exists.
- Selecting a missing **Repo** returns a not-found result and should not initialize a **Repo Durable Object**.
- A **Key** may contain characters that are not valid in a **Slug**; do not use a Key where OS needs hostname-safe routing.
- A **Project Route** includes the globally unique **Project** slug.
- A **Project Slug** is route identity and may change; a **Project ID** is stable identity.
- A **Project Route** resolves its **Project Slug** before rendering
  Project-local UI. Project-scoped itx handles accept a slug or stable Project
  ID at connect time and then operate on the resolved Project ID.
- The **Project Slug** used in the **Project Route** is browser-facing route identity, not stream namespace identity.
- Every external **Project-Scoped itx Handle** accepts `projectIdOrSlug`,
  resolving globally unique Project Slugs and stable Project IDs through the
  same project-scope access path.
- A **Project Durable Object Namespace** is infrastructure context; a resolved and authorized **Project** is domain context.
- Browser routes use pretty Project Slugs in URLs and may pass either the slug
  or resolved stable Project ID when opening Project-scoped itx handles.
- Every Project has a **Stable Project Ingress Host** derived from the **Project ID**.
- Every Project has a **Slug Project Ingress Host** derived from the current **Project Slug**.
- The **Stable Project Ingress Host** remains routable even when the slug-derived host changes.
- Custom hostname, default-host, dashboard-host, and stream-host lifecycle are future ingress work, not current routing behavior.
- A **Project MCP Route** may expose one or more authorized **Projects**.
- A **Project MCP Route** is served through OS `/mcp`, using auth-worker project
  claims and scopes or an admin token that exposes all projects.
- Project-scoped MCP tools select one **Project** per invocation before touching
  project-local capabilities.
- OS exposes one global MCP resource at `/mcp`; it does not expose per-project
  MCP hostnames.
- The OS Worker classifies every request by **Ingress Hostname** before invoking the **OS App**.
- The OS Worker uses a global **Ingress Route Table** to decide whether a request becomes **Project Ingress** or continues to the **OS App**.
- Requests that do not match the global **Ingress Route Table** are handled by the **OS App**.
- Requests whose global **Ingress Routing Rule** resolves to a **Project Durable Object** are **Project Ingress** and are delegated to that Project's **Project Durable Object**.
- The **Ingress Route Table** is evaluated by pure matching logic over a request and a route lookup dependency.
- **Ingress Routing Rules** have stable unique IDs and deterministic priority ordering.
- The first concrete stored **Ingress Routing Rule** is an **Exact Host Ingress Rule** so the global lookup can compile to a simple indexed SQL query.
- Stored **Ingress Routing Rules** carry their target as a top-level **Fetch Callable**.
- **Fallback Ingress Rules** are provided by the caller and are not stored as seed data.
- The global **Ingress Route Table** stores project-owned exact-host rules, not OS App fallback routes.
- Global **Ingress Routing Rules** that route to a Project store **Project ID** as a first-class scope column as well as inside their **Fetch Callable** props.
- The **OS App Worker** is the fallback destination for every request that does not match a stored global **Ingress Routing Rule**.
- The **OS Ingress Worker** may be a separate public Worker script from the **OS App Worker**.
- The **OS App Worker** does not need its own public route when it is only reached through the **OS Ingress Worker**.
- The **Project Durable Object** stays exported from the main OS Worker for now so **Loopback Fetch Callables** can pass dynamic entrypoint props.
- The **Project Ingress Entry Point** is the public fetch-shaped bridge from a matched global ingress rule to the **Project Durable Object**.
- The **Project Ingress Entry Point** class/export name is `ProjectIngressEntrypoint`.
- The **Project Ingress Entry Point** takes only a stable **Project ID** prop in v1, resolves the Project Durable Object stub by using that **Project ID** as the Durable Object name, and delegates the request to the Project Durable Object's ingress RPC.
- The **Project Ingress Entry Point** does not accept **Project Slug** props in v1; slug-to-ID resolution happens before a request reaches hot ingress.
- **Project Egress** is future work. Until it is implemented, itx Script
  `fetch(...)` and `itx.fetch(...)` calls go through the default **itx Fetch
  Capability**.
- The **Project Egress Intercept Tunnel** (and its `/__iterate/intercept-project-egress` route) is deleted; egress interception is a live `fetch` capability shadow on the project's itx context, session-bound and scoped to exactly one **Project**.
- A live `fetch` shadow dispatches BEFORE the default egress pipe, so it sees `getSecret(...)` references unsubstituted; without a shadow, Project Egress header Secret references are replaced with raw **Secret Material** before public fetch.
- Project-scoped Secret CRUD goes through the **D1-backed Secrets Capability**;
  UI and script callers must not reimplement Secret storage behavior directly.
- Project-scoped Secret reads return redacted Secret summaries and metadata,
  not raw Secret material.
- The first Project Egress Secret Injection proof also resolves Secret material through the **D1-backed Secrets Capability**; Secret Durable Objects are not in the immediate substitution path.
- A **Project Secret** has a stable **Secret ID** for management routes and CRUD reads/removals.
- A **Project Secret** has one **Secret Key** that is unique within its **Project**.
- **Secret Keys** are arbitrary strings and are not required to be URL-safe.
- Upserting a **Project Secret** by **Secret Key** preserves the existing **Secret ID** when that key already exists in the Project.
- **Secret References** resolve by **Secret Key**, such as `getSecret({ key: "openai-api-key" })`.
- The legacy `ProjectMcpServerEntrypoint` Worker export now returns a tombstone response.
- The OS Worker owns MCP protocol paths, OAuth protected-resource metadata paths, browser instructions, and 404s for unsupported paths on `/mcp`.
- A browser request to a **Project MCP Route** that is not an MCP client connection may return a static HTML instructions page.
- The **Project MCP Server Connection** Durable Object class/catalog name is `ProjectMcpServerConnection`.
- The **Outbound MCP From Our Client Capability** Durable Object class name is `OutboundMcpFromOurClientCapability`.
- The **Outbound MCP From Our Client Capability** uses the `OUTBOUND_MCP_FROM_OUR_CLIENT_CAPABILITY` namespace binding.
- The OS Worker `/mcp` handler owns MCP OAuth protocol verification in v1.
- The **Project Durable Object** must not grow MCP-specific authorization methods such as `authorizeMcpServerConnection`.
- The **Project Durable Object** may expose a generic **Project Access Check** in v1 for entrypoints that have already verified a principal.
- The v1 **Project Access Check** first trusts auth-worker project claims and may use the app-level **Project Listing Projection** in D1 as a legacy fallback.
- Future project-owned authorization should be modeled as generic **Project Route Authorization** for **Project Route Destinations**.
- New OS Worker named entrypoints live in an `entrypoints/` source folder, separate from `durable-objects/`.
- A **Loopback Fetch Callable** is preferred when an ingress rule needs to target a named OS Worker entrypoint with per-route props.
- The **Project Durable Object** exposes the **Project Control Surface** for project lifecycle commands.
- The **Create Project Command** is the domain command for creating a Project; do not call the domain command "initialize project".
- The app worker authenticates the caller, validates the requested slug, allocates the **Project ID**, gets the Project Durable Object by **Project ID**, and calls the **Create Project Command**.
- The **Create Project Command** writes the Project Durable Object's local lifecycle state and all v1 D1 projections before returning to the RPC caller.
- Asynchronous provisioning work, such as Cloudflare DNS/custom-hostname/certificate lifecycle, may continue after the **Create Project Command** has written durable desired state.
- TanStack project routes and itx entrypoints should thinly proxy project
  lifecycle commands to the **Project Control Surface** instead of
  reimplementing project lifecycle logic in the app worker.
- The **Project Durable Object** owns project ingress routing. MCP auth lives in the OS `/mcp` handler, which calls generic project access logic after token verification.
- The **Project Durable Object** is the authority for desired project-owned ingress state.
- Global **Ingress Routing Rules** for project-owned hostnames are **Project Projections** written for fast indexed lookup by the OS Worker.
- V1 may synchronously write **Project Projections** from **Project Control Surface** commands even though Durable Object SQLite and D1 are not one atomic transaction.
- **Project Ingress** currently includes platform slug/stable hosts. Custom hosts and per-destination auth are future work.
- A **Project Durable Object** owns a project-local **Ingress Route Table** that maps **Project Ingress** to **Project Route Destinations**.
- A **Project Route Destination** is a kind of **Fetch Destination**.
- A **Fetch Destination** may be backed by OS-packaged source code, runtime-loaded code, or another project-owned capability.
- Global and project-local ingress use the same **Ingress Route Table** concept even though their first concrete destinations differ.
- Projects are born with **Slug Project Ingress Host** and **Stable Project Ingress Host** routes.
- Projects are not born with MCP hostname aliases; MCP access is centralized at OS `/mcp`.
- Slug changes should update slug-derived ingress routes at the same time; alias lifecycle is future work.
- Project MCP server `exec_js` starts a **Script Execution** and therefore requires a **Script**.
- Browser REPL execution and Project MCP server `exec_js` share the same itx
  script runner shape.
- A **Project Route** resolves its **Project Slug** to the stable **Project ID**
  before opening a **Project-Scoped itx Handle**.
- A **Project MCP Route** resolves to the stable **Project ID** from token claims
  or the tool invocation's selected project slug before running a project-scoped
  script.
- A **User** acts through their **Active Organization** when managing **Projects**.
- A signed-in **User** without an **Active Organization** must create or select an **Organization** before using OS.
- A remote OAuth MCP client calls OS with an **OAuth Access Token**.
- First-party or e2e MCP clients should use either an **OAuth Access Token** or the OS admin API secret.
- A **Script** receives an **itx Handle**.
- A **Script Execution** is identified by `executionId` on `events.iterate.com/itx/script-execution-requested` and `events.iterate.com/itx/script-execution-completed`.
- The runner accepts one script shape: `async (itx) => ...`. Endpoint-specific vars are baked into the source before it reaches the runner.
- `/api/itx/run` records requested/completed script events around a synchronous run; an enqueued requested event asks the context processor to run it later.
- Individual itx capability calls do not create durable function-call-requested/completed events. The dotted path is captured by the path proxy and dispatched once through the itx supervisor.
- A provided capability may be a live object/function, a Worker RPC address, or a path-call target implementing `call({ path, args })`.
- A returned live handle, such as a Repo handle from `itx.repos.get({ slug })`, exposes its own Workers RPC methods after the original path call returns.
- `itx.describe()` is the capability discovery surface. Providers attach instructions and optional types to each capability entry.
- Dynamic MCP and OpenAPI tools should be exposed as itx capabilities whose exact external tool names or operation IDs remain path segments; use bracket syntax when a segment contains dots.
- Project default capabilities include `fetch`, `streams`, `secrets`, `integrations`, `repos`, `agents`, `workspace`, `worker`, and `ai` as defined by `PLATFORM_PROJECT_CAPABILITIES`.
- Agent hosts add channel and agent-local capabilities such as `itx.slack` or `itx.chat`, `itx.debug`, `itx.gmail`, `itx.agents`, and an agent-private `itx.workspace`.

## Target itx Blocks

```ts
await itx.describe();
```

`describe()` is the runtime truth for a handle: it returns the context ref,
access shape, and the capabilities visible through the context chain.

```ts
await itx.slack.chat.postMessage({ channel: "C123", text: "hello" });
```

Slack is a provided itx capability. `SlackCapability.call` receives the dotted
path as data and maps it to the Slack Web API method path.

```ts
const repo = await itx.repos.get({ slug: "project" });
const info = await repo.getInfo();
```

Repos are a project default capability. `ReposCapability.call` replays path
calls onto its WorkerEntrypoint methods; repo handles expose live Workers RPC
methods such as `getInfo`, `commitFiles`, `readFiles`, and `readLog`.

```ts
await itx.workspace.writeFile("/project/worker.ts", source);
await itx.workspace.gitCommit({ dir: "/project", message, author });
```

Workspace is an explicit capability selected by the host. Project handles get
the shared project workspace; agent contexts provide their own isolated
workspace capability.

```ts
const messages = await itx.gmail.request({
  path: "/gmail/v1/users/me/messages",
  query: { maxResults: 5 },
});
```

Gmail is a project capability backed by the connected Google account. It reads
fresh OAuth access through the secrets domain and proxies Gmail REST requests.

```ts
const response = await fetch("https://api.example.com/data");
const samePipe = await itx.fetch("https://api.example.com/data");
```

Bare `fetch()` inside platform-loaded itx isolates and `itx.fetch(...)` both
flow through the project egress capability. A context can shadow `fetch` with
`itx.provideCapability({ name: "fetch", ... })`; secret placeholders are only
substituted in the default egress pipe.

```ts
const stream = itx.streams.get("/agents/demo");
await stream.append({ type: "events.example.com/note", payload: {} });
const events = await stream.getEvents();
```

Streams are a project default capability. Narrowed project handles operate in
the project namespace; absolute refs remain access-checked.

```ts
await itx.provideCapability({
  name: "runSwiftOnMyMac",
  instructions: "Compile and run Swift source on my laptop.",
  capability: async (source) => runSwift(source),
});
```

Live capabilities are session-bound and callable by every holder of the same
context while the provider remains connected.

## Example Dialogue

> **Dev:** "When a script runs `itx.linear.createIssue(...)`, is that a tool execution?"
> **Domain expert:** "It is an itx capability call. The dotted path is captured locally and dispatched once through the context supervisor."

> **Dev:** "Is `itx.streams.get(path).append(...)` a special stream API?"
> **Domain expert:** "No. `streams` is a default project capability, and the returned stream handle is a live Workers RPC value."

> **Dev:** "Does `itx.repos.get({ slug }).getInfo()` make two itx capability calls?"
> **Domain expert:** "The `repos.get` path call returns a repo handle; `getInfo` is a Workers RPC method on that returned handle."

> **Dev:** "How does a script learn what is available?"
> **Domain expert:** "Call `itx.describe()`. Providers attach instructions and optional types to each capability."

> **Dev:** "Should `docs.search` from an MCP server become `itx.docs.search(...)`?"
> **Domain expert:** "No. External tool names and OpenAPI operation IDs are exact path segments, so use bracket syntax such as `itx.mcp.cloudflareDocs["docs.search"](...)` when needed."

> **Dev:** "What script shape should MCP `exec_js` send?"
> **Domain expert:** "Use one async arrow function: `async (itx) => { ... }`. The `/api/itx/run` endpoint accepts `{ itx, vars }` at its API boundary and wraps it into that runner shape."

> **Dev:** "Is an outbound MCP capability the same thing as OS's MCP server connection?"
> **Domain expert:** "No. **Outbound MCP From Our Client Capability** is OS as an MCP client. **Project MCP Server Connection** is an external client connected to OS's project-scoped MCP server."

> **Dev:** "What are the two MCP directions in OS?"
> **Domain expert:** "Inbound MCP is OS acting as the MCP server via the fetch-based **OS MCP Handler** and `ProjectMcpServerConnection`. Outbound MCP is OS acting as an MCP client via `OutboundMcpFromOurClientCapability`, which can be exposed as an itx capability."

> **Dev:** "Should the Durable Object behind OS's project-scoped MCP server be called `IterateMcpServer`?"
> **Domain expert:** "No. Use `ProjectMcpServerConnection`: it describes one external MCP client connection and avoids confusing OS-as-server with OS-as-client."

> **Dev:** "Can someone open an OS project page without signing in?"
> **Domain expert:** "No. The **OS App** is authenticated, and every **Project** is managed through the user's active **Organization**."

> **Dev:** "Can a **Personal Account** own a **Project**?"
> **Domain expert:** "No. OS only lets an **Organization** own **Projects**."

> **Dev:** "Can a project page be addressed without the organization slug?"
> **Domain expert:** "Yes. A **Project Route** is `/projects/:projectSlug`; OS URLs have no organization segment — organization membership and selection live in the auth worker."

> **Dev:** "What should OS show after sign-in if auth worker has no **Active Organization**?"
> **Domain expert:** "Redirect through the auth worker's organization selection or creation flow before rendering the **OS App**."

> **Dev:** "Does the MCP server require an auth-worker JWT?"
> **Domain expert:** "No. The MCP server requires a valid OS admin token or auth-worker **OAuth Access Token**. JWT is a token format detail; OS should model the caller as a **Principal**."

> **Dev:** "Should a request for a Project-owned hostname hit the OS App auth middleware before project routing?"
> **Domain expert:** "No. The OS Worker first classifies the **Ingress Hostname**. If it is a **Project-Owned Hostname**, the request becomes **Project Ingress** before OS App auth runs."

> **Dev:** "Is the global hostname lookup a special project-hostname table?"
> **Domain expert:** "No. Model it as an **Ingress Route Table**. Matching an HTTP request yields a **Fetch Destination**; one such destination is the Project Durable Object."

> **Dev:** "Do fallback routes live as rows in D1?"
> **Domain expert:** "No. They are **Fallback Ingress Rules** supplied by the caller, so a reader can understand the default behavior from the Worker or Project Durable Object source."

> **Dev:** "Should the TanStack Start worker itself be the public entrypoint?"
> **Domain expert:** "Not necessarily. Prefer a skinny **OS Ingress Worker** as the public entrypoint, with the **OS App Worker** reachable only through a service binding."

> **Dev:** "Should an ingress rule store a nested `{ callable: ... }` destination?"
> **Domain expert:** "No. Store the route target directly as a top-level **Fetch Callable** on the rule."

> **Dev:** "Should v1 route matching support path and header predicates?"
> **Domain expert:** "No. Use **Exact Host Ingress Rules** first so the lookup stays a direct indexed SQL query."

> **Dev:** "Should the Project Durable Object be deployed in a separate worker script immediately?"
> **Domain expert:** "Not yet. Keep it exported from the main OS Worker while Project ingress depends on **Loopback Fetch Callables** with dynamic props."

> **Dev:** "Does `/mcp` on a Project-owned hostname route to the Project MCP server?"
> **Domain expert:** "No. MCP is served by the OS app at `/mcp`; OAuth sessions expose token-granted projects, admin-token sessions expose all projects, and project-scoped tools select one project per invocation."

> **Dev:** "Does the Project Durable Object need to understand MCP protocol paths?"
> **Domain expert:** "No. The OS `/mcp` handler owns protocol paths, OAuth metadata, browser setup instructions, and unsupported-path responses."

> **Dev:** "Should Project Durable Object expose `authorizeMcpServerConnection(...)`?"
> **Domain expert:** "No. MCP is one Project Route Destination among many. Future authorization should be generic **Project Route Authorization**, not a method per destination type."

> **Dev:** "How should `/mcp` check access in v1 after verifying auth-worker OAuth?"
> **Domain expert:** "Use the verified **Principal**. Auth-worker project claims authorize directly; the legacy D1 Project projection remains a fallback for organization-owned projects."

> **Dev:** "What should a global ingress rule point at for project traffic?"
> **Domain expert:** "Point it at `ProjectIngressEntrypoint`, the **Project Ingress Entry Point**, with the stable **Project ID** in props. That entry point resolves the Project Durable Object and delegates to its ingress RPC."

> **Dev:** "Is Project Egress just another Project Ingress route?"
> **Domain expert:** "No. **Project Ingress** handles inbound public requests to Project-owned hostnames. **Project Egress** is future outbound policy work; see `tasks/project-egress-secrets-mvp.md`."

> **Dev:** "Can `ProjectIngressEntrypoint` props identify a Project by slug?"
> **Domain expert:** "Not in v1. Slugs are mutable and belong to control-plane routing. Hot ingress uses the stable **Project ID** already resolved by the exact-host route lookup."

> **Dev:** "Which public host should OS use when linking to a Project?"
> **Domain expert:** "Use the slug platform host for now. The stable ID platform host remains routable; custom/default host selection is future work."

> **Dev:** "Should the Project Durable Object command be named `initializeProject`?"
> **Domain expert:** "No. Use **Create Project Command** / `createProject`. `initialize` is infrastructure lifecycle language, not the Project domain command."

> **Dev:** "What happens to slug-derived hosts if the Project Slug changes?"
> **Domain expert:** "The slug-derived routes should change with the slug. The stable ID host remains routable; alias lifecycle can be added later."

> **Dev:** "If `fetchCallable.props.projectId` already contains the Project ID, should the ingress route row also have a `project_id` column?"
> **Domain expert:** "Yes. Data model scope should be first-class. Keep `project_id` queryable for listing, indexing, repair jobs, and ownership checks."

> **Dev:** "Should TanStack routes or itx entrypoints implement project lifecycle logic directly?"
> **Domain expert:** "No. It should proxy project lifecycle commands to the **Project Control Surface** on the **Project Durable Object**. The app worker owns HTTP/auth plumbing, not the project lifecycle model."

> **Dev:** "Is the global exact-host D1 route table authoritative?"
> **Domain expert:** "No. It is a **Project Projection**. The **Project Durable Object** owns desired project ingress state, while D1 gives the Worker a simple indexed lookup."

> **Dev:** "Is the `projects` D1 table the source of truth for Project lifecycle?"
> **Domain expert:** "No. It is a **Project Listing Projection**. The **Project Durable Object** owns lifecycle state and writes the app-level D1 row for listing and routing."

> **Dev:** "Is the automatic Durable Object tracking table the same thing as the `projects` table?"
> **Domain expert:** "No. The **Durable Object Catalog** is shared infrastructure state for initialized Durable Objects. The **Project Listing Projection** is product query state."

## Flagged Ambiguities

- "function" can mean a JavaScript function, an itx capability function, or a
  control operation. Resolved: use **Path Call** for itx-routed calls and
  ordinary "function" for JavaScript.
- "script" and "execution" were conflated. Resolved: **Script** is code; **Script Execution** is one attempt to run it.
- "execute" and "call" were used interchangeably. Resolved: scripts execute;
  itx capabilities receive **Path Calls**.
- "tools" was used for both the whole context and provider functions. Resolved:
  the local object is an **itx Handle**; provider callables are **itx
  Capabilities**.
- "describe callable" added a second provider execution path. Resolved:
  capability registration carries short **Capability Instructions**; richer
  discovery is exposed as ordinary capability methods such as `listTools`,
  `listOperations`, or `listProcedures`.
- "ExecutionContext" conflicts with Cloudflare's Worker `ExecutionContext`. Resolved: use **itx Handle** for itx userland.
- "session id" and "stream path" were conflated. Resolved: itx contexts are
  explicit handles; **Event Stream Path** identifies streams, not an execution
  session.
- "app" can mean the OS product or a managed project surface. Resolved: use **OS App** for this dashboard and **Project** for the managed app surface.
- "personal organization" is misleading because auth worker treats personal accounts separately from organizations. Resolved: use **Personal Account** for auth worker's non-organization user context.
- "MCP JWT" is too narrow for auth-worker OAuth. Resolved: use **OAuth Access Token** for OAuth MCP bearer tokens and **Principal** for OS's request-local authenticated actor.
- "project URL" was ambiguous between stable IDs and slugs. Resolved: use **Project Route** for the user-facing `/projects/:projectSlug` URL.
- "MCP" can mean OS as an MCP server or OS as a client of another MCP server.
  Resolved: use **OS MCP Handler** plus **Project MCP Server Connection** for
  external clients connected to OS, and **Outbound MCP From Our Client
  Capability** for OS connecting to external MCP servers as itx capabilities.
- "`IterateMcpServer`" names the product, not the domain concept. Resolved: use `ProjectMcpServerConnection` for the Durable Object class/catalog name.
- "Project Run Code Session" added an unnecessary layer. Resolved: run scripts
  against a **Project-Scoped itx Handle**.
- "route" can mean a TanStack route, a Worker hostname match, or a Project-local destination. Resolved: use **Ingress Hostname** for the Worker-level host classifier, **Project Route** for the authenticated OS dashboard URL, and **Project Route Destination** for a Project Durable Object target.
- "authentication" can happen at the OS App layer or inside MCP. Resolved: the OS App authenticates dashboard/control-plane routes; MCP auth currently lives in the **OS MCP Handler**.
- "fetch callable" overlaps with generic JavaScript functions and Tool Provider callables. Resolved: use **Fetch Destination** for an ingress target that can receive an HTTP request.
- "context request" made itx look like a generic invocation broker. Resolved:
  use **Path Call** for path-addressed itx capability calls.
- "documentation" sounded like a generated API schema or external docs page.
  Resolved: use **Capability Instructions** for the string-form guidance
  registered with a capability.
- "Workspace" is usually avoided for Organization or Project. Resolved:
  **Workspace Durable Object** is a separate live-resource concept selected by
  Project ID and workspace slug.
- "`itx.workspaces.get`" made Workspace look like a repo-style collection
  lookup. Resolved: use singular `itx.workspace` for the Workspace surface.
- "root tool" could imply a special non-provider mechanism. Resolved: subagent
  creation is the namespaced **RPC Capability** `itx.agents.create()`.
- "path" was doing two jobs: identifying the full itx call and identifying the
  function relative to the provider. Resolved: use **Capability Path** for the
  registered mount path and **Function Path** for the capability-relative call
  path.
- "argsSummary" made path calls look like a separate event family. Resolved:
  path calls carry an `args` field and live values stay live across Workers RPC.
- "static callable" sounded like one fixed descriptor. Resolved: use **Callable Builder** for helpers that construct different Callable descriptors for one Capability.
- "Project DO worker" conflicted with loopback props. Resolved: use **Project Ingress Entry Point** as the same-worker loopback target for project ingress, while the **Project Durable Object** remains exported by the main OS Worker.
- "project UI state" and lifecycle status could make the frontend look authoritative. Resolved: **Project Lifecycle Events** are durable facts, and UI can reduce them without owning the lifecycle model.
- "project identity" in entrypoint props could mean slug or ID. Resolved: v1 ingress entrypoints accept **Project ID** only; **Project Slug** resolution happens in control-plane routes or route-registry writes.
- "canonical project host" could mean stable ID host, slug host, or future custom host. Resolved for current code: use **Stable Project Ingress Host** for the ID-derived host and **Slug Project Ingress Host** for the slug-derived host.
- "initialize project" conflates infrastructure lifecycle with domain creation. Resolved: use **Create Project Command** for the Project Durable Object domain command.
- "scope" could be hidden inside payload JSON. Resolved: OS persisted records should expose their **Data Scope** through queryable columns.
- "source of truth" for project ingress could mean the global D1 lookup table. Resolved: the **Project Durable Object** owns desired ingress state; D1 rows are **Project Projections**.
- "project table" could mean app-level listing state or mixin-owned Durable Object tracking. Resolved: use **Project Listing Projection** for the app D1 row and **Durable Object Catalog** for shared DO tracking tables.
- "MCP authorization" could become a one-off Project Durable Object method. Resolved: avoid MCP-specific Project DO auth methods; model future auth as generic **Project Route Authorization**.
- "project access" and "route authorization" are different depths of policy. Resolved: v1 can use a generic **Project Access Check**; richer destination-specific policy belongs to future **Project Route Authorization**.
- "egress proxy", "egress gateway", and **Project Ingress** were used around outbound traffic. Resolved for current code: use **Project Egress** only as a pointer to future outbound policy work.
- "external egress proxy", "intercept egress traffic", and "mock internet proxy" were used for test-time outbound interception. Resolved: use **Project Egress Intercept Tunnel**, or **Project Egress Tunnel** as the short form.
- `externalEgressProxyUrl` was a persisted Project configuration field for test-time outbound interception. Resolved: remove it instead of preserving backwards compatibility; the **Project Egress Intercept Tunnel** is ephemeral runtime state.
- `"/__intercept-egress-fetch"` and `"/__iterate/intercept-project-egress"` were both considered as the tunnel connection path. Resolved: use the namespaced **Project Egress Intercept Route** `"/__iterate/intercept-project-egress"`.
- "Cloudflare Artifacts repo" introduced a second repo concept. Resolved: use **Repo** for the OS domain object and **Cloudflare Artifacts** for the backing service.
- "stream path" sounded like independent Repo identity. Resolved: **Repo Stream** path is derived from **Repo Slug** as `/repos/{repoSlug}`.
- "token" originally meant a one-time response secret. Resolved for the Repo v1 prototype: an initial long-lived **Repo Token** is stored in **Repo Reduced State** so `getInfo()` can return clone and push details.
- First-party Cloudflare Artifacts docs recommend short-lived, least-privilege tokens. The v1 **Repo Token** decision intentionally optimizes for a simple clone/push prototype and should be revisited before broad availability.
- The **Project Lifecycle Stream** path was ambiguous between `/project` and `/`. Resolved: use root `/`; resource streams such as `/repos/{repoSlug}` are child streams in the Project Stream Namespace.
