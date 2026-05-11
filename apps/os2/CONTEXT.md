# OS2

OS2 is an authenticated app where users manage organization-owned projects and run scripts that call tool functions. This context defines the language for project ownership, codemode sessions, tool providers, and the event-first execution model.

## Language

### Product Ownership

**OS2 App**:
The authenticated dashboard where users manage organization-owned projects and run codemode.
_Avoid_: Public site, marketing app

**Clerk Organization**:
The owning account boundary for projects in OS2.
_Avoid_: Workspace, team, tenant, account

**Active Organization**:
The Clerk Organization currently selected in a Clerk User's session.
_Avoid_: Current workspace, selected account

**Personal Account**:
Clerk's non-organization user context, which OS2 does not allow for project ownership.
_Avoid_: Personal organization, default organization

**Clerk User**:
A person authenticated by Clerk who acts inside a Clerk Organization.
_Avoid_: Member, account

**Clerk OAuth Token**:
A Clerk-issued OAuth access token used by a remote MCP client to call OS2 as a protected resource.
_Avoid_: MCP JWT, session token

**Clerk Session Token**:
A Clerk-issued session token used by first-party or e2e clients to call OS2 as an authenticated Clerk User.
_Avoid_: testing token, OAuth token

**Project**:
An OS2-managed app surface owned by exactly one Clerk Organization.
_Avoid_: App, site, workspace

**Data Scope**:
The ownership boundary for a persisted OS2 record: Project, Clerk Organization, Clerk User, or Global.
_Avoid_: Tenant type, resource kind

**Project ID**:
The stable OS2 identifier for a Project.
_Avoid_: Project slug, Project Route

**Project Slug**:
The globally unique human-readable slug used in Project Routes.
_Avoid_: Project ID

**Project Route**:
The organization-scoped URL for a Project, identified by Clerk Organization slug and Project slug.
_Avoid_: Global project URL, project ID URL

**Project Route Context**:
The TanStack Router route context for a Project Route. It should resolve the pretty Project Slug into the Project row once so child routes can render with Project details and call project-scoped APIs with either slug or ID.
_Avoid_: Assuming inherited project data, page-local project state

**Project-Scoped Procedure**:
An OS2 oRPC procedure under the singular `os.project.*` router. External callers pass `projectSlugOrId`; project-scope middleware resolves and authorizes it, and handlers use the stable Project ID after that point.
_Avoid_: Raw projectId handler, unchecked project route

**Project Durable Object Namespace**:
The Worker environment binding used by server code to obtain Project Durable Object stubs.
_Avoid_: project context, resolved project

**Project MCP Route**:
The project-scoped MCP server route for one Project, served from a project-owned MCP hostname and resolved through Project ingress.
_Avoid_: Global MCP endpoint, MCP project selector, `/mcp` path

**Ingress Hostname**:
A public hostname that OS2 can classify before running the OS2 App.
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
Traffic for a Project-Owned Hostname after the OS2 Worker has classified it.
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

**OS2 Ingress Worker**:
The skinny Worker entrypoint that classifies public traffic and proxies it to Fetch Destinations.
_Avoid_: OS2 App, control plane app

**OS2 App Worker**:
The Worker that runs the authenticated OS2 App behind the OS2 Ingress Worker.
_Avoid_: Ingress worker, public worker

**Project Ingress Entry Point**:
A named WorkerEntrypoint exported as `ProjectIngressEntrypoint` that receives Project identity as props, resolves the Project Durable Object, and delegates Project Ingress to it.
_Avoid_: Project app worker, project service

**Project Egress**:
Future outbound HTTP/S policy work for Project-owned execution. Current codemode `fetch(...)` is traceable through the default Codemode Fetch Capability; full egress policy and secret injection live in `tasks/project-egress-secrets-mvp.md`.
_Avoid_: Project Ingress, implemented gateway, implemented secret system

**Codemode Fetch Capability**:
The default RPC Tool Provider used by codemode for ordinary Script `fetch(...)` and `ctx.fetch(...)` calls.
_Avoid_: Raw Dynamic Worker fetch, untraced public fetch

**Project MCP Server Entry Point**:
A named WorkerEntrypoint exported as `ProjectMcpServerEntrypoint` that receives Project identity as props and exposes that Project's MCP server as a fetch destination.
_Avoid_: Global MCP server, MCP route, Iterate MCP server, Tool Provider, Capability wrapper

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
_Avoid_: Project oRPC router, project service layer

**Create Project Command**:
The Project Control Surface command that creates a Project's lifecycle state and projections.
_Avoid_: Initialize project, create project row

**Project Projection**:
A queryable record outside the Project Durable Object that is derived from the Project Durable Object's desired state.
_Avoid_: Source of truth, duplicate state

**Project Listing Projection**:
The app-level D1 `projects` row used by OS2 to list, route to, and search Projects.
_Avoid_: Project source of truth, Durable Object catalog row

**Durable Object Catalog**:
The shared mixin-owned D1 tracking table that records initialized Durable Objects for discovery and repair workflows.
_Avoid_: Project table, application projection

**Durable Object Utility Route**:
An infrastructure route mounted on the OS2 Worker entrypoint for initializing, inspecting, or listing Durable Objects through shared durable-object utilities.
_Avoid_: Product route, TanStack route

**Project Route Destination**:
A project-local target that a Project Durable Object can route Project Ingress to.
_Avoid_: App, service, endpoint

**Project Route Authorization**:
A future Project Durable Object-owned policy decision for whether a principal may access a Project Route Destination.
_Avoid_: MCP authorization, app-specific auth method

**Project Access Check**:
A generic Project Durable Object-owned check that decides whether a Clerk principal can access one Project.
_Avoid_: MCP authorization, route-specific permission

**Codemode Example Stack**:
A global static product-authored stack containing Event Inputs, provider inputs, and one or more Scripts that can prefill a new Codemode Session form.
_Avoid_: Project preset, saved session, fixture, default preset row

**Codemode Session Creation Form**:
The project-scoped form used to create or attach to a Codemode Session, optionally prefilled from a Codemode Example.
_Avoid_: Example runner, run page, execution form

**Project Stream Explorer**:
The OS2 project-bound UI for discovering and inspecting every initialized Event Stream Path for one Project.
_Avoid_: Events app stream explorer, stream tree

### Agents

**Agent**:
A project-scoped assistant work surface that users can list, open, and chat with. An Agent is identified inside one Project by an Agent Path.
_Avoid_: Project Agent, Codemode Session, raw stream

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
The shared stream runtime's stable owner key for a group of Event Stream Paths. OS2 uses the stable Project ID as the namespace; future runtime users may use non-project namespaces such as `platform`.
_Avoid_: Project ID inside shared stream runtime, tenant path prefix

**Project Lifecycle Stream**:
The Project-owned Event Stream Path `/project` that records durable Project lifecycle facts.
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

### Codemode

**Codemode Session**:
A durable codemode execution context initialized for one Project ID and one Event Stream Path, with its own tool provider registry and canonical lifecycle events.
_Avoid_: Runtime, worker, conversation

**Event Stream Path**:
The namespace-local stream address that a Codemode Session reads from and appends to. In OS2 these paths are project-local because the Project ID is already the Stream Namespace; they must not start with `/projects/{projectId}`.
_Avoid_: Session ID, Durable Object name

**Codemode Session Name**:
The D1 catalog and Durable Object name used as the route identifier for a Codemode Session.
_Avoid_: Session ID, stream path

**Codemode Session Capability**:
A scoped RPC capability handed to script executors and tool providers so they can interact with a Codemode Session.
_Avoid_: RpcTarget, session stub, callback bundle

**StreamsCapability**:
A Project ID-backed RPC capability for stream operations. Its props bind the shared stream namespace to the Project ID, and optional `streamPath` props narrow calls to one namespace-local Event Stream Path.
_Avoid_: Generic stream client, Events app stream client

**Codemode Session Control Plane**:
The explicit command surface for starting codemode work on a Codemode Session.
_Avoid_: Generic append API, stream API

**Codemode Session Started Event**:
The codemode event that records a Codemode Session's stream-level runtime capability.
_Avoid_: Capability registration, provider registration, session metadata

**Session Capability Callable**:
The Callable on a Codemode Session Started Event that lets processors call back into the Codemode Session.
_Avoid_: Codemode session capability callable, session capability, provider callable

**Codemode Context**:
The local JavaScript object built from a Codemode Session Capability and passed to codemode scripts or provider implementations.
_Avoid_: ExecutionContext, tools, ctx tools

**Tool Provider**:
Model-visible documentation for one or more Tool Functions available in a Codemode Session.
_Avoid_: Tool, bridge, runtime

**Tool Provider Instructions**:
String-form guidance registered for a Tool Provider path that tells Script authors how to use that Tool Provider.
_Avoid_: Documentation field, function registry, route manifest

**Callable Builder**:
A helper function that constructs a Callable descriptor for one Capability invocation shape.
_Avoid_: Static callable, callable JSON helper, descriptor factory

**Tool Function**:
A callable function provided by a Tool Provider and addressed by a path on the Codemode Context.
_Avoid_: Tool, session function, script

**Tool Function Implementation**:
The code that handles one Tool Function request and produces its result.
_Avoid_: Function tool implementation, processor block

**Leaf Tool Function**:
A Tool Function whose provider path is directly callable without a nested function name.
_Avoid_: Root tool, direct provider

**Tool Function Call**:
A request from codemode to call a Tool Function.
_Avoid_: Execution, append, script execution

**Function Call**:
A request from codemode to invoke a documented function path.
_Avoid_: Context call, direct RPC call

**Script Execution ID**:
The Script Execution correlation ID stored in codemode events.
_Avoid_: Script ID, requested offset field

**Function Call ID**:
The Function Call correlation ID stored in codemode events.
_Avoid_: Tool call ID, requested offset field

**Provider Path**:
The registered Codemode Context path at which a Tool Provider is mounted.
_Avoid_: Root path, namespace, provider slug

**Function Path**:
The Codemode Context path remaining after the Provider Path has been matched.
_Avoid_: Relative path, method path, route

**Unary Tool Provider**:
A Tool Provider whose Provider Path is itself callable and whose Function Path is empty when called.
_Avoid_: Root tool, special function, direct callable

**Event-Mediated Tool Function**:
A Tool Function whose request and completion are mediated through Codemode Session events.
_Avoid_: Offline tool, queue tool

**RPC Tool Function**:
A Tool Function whose request is traced by Codemode Session events but whose live invocation uses Workers RPC so request arguments and return values may include Cloudflare live values.
_Avoid_: Direct tool, non-event tool

**Stateful Tool Provider Endpoint**:
A directly addressable Durable Object or Worker endpoint that executes Tool Functions while owning long-lived connection state.
_Avoid_: Singleton tool, direct service, provider runtime

**Outbound Tool Provider Actor**:
A Tool Function Implementation that is not externally addressable and can only observe requests or report results through outbound communication.
_Avoid_: Offline tool, browser tool, poll provider

**SDK-backed Tool Provider**:
A Tool Provider whose Tool Function paths are mapped to calls on an underlying SDK rather than enumerated as separate OS2-owned function definitions.
_Avoid_: Generated tool registry, SDK route table

**Event-Mediated Tool Provider**:
A Tool Provider whose Tool Function Implementations observe Function Call request events and append matching Function Call completion events.
_Avoid_: Callback provider, offline provider

**RPC Tool Provider**:
A Tool Provider whose Tool Function Implementations are reached through an RPC capability registered for a Codemode Context path.
_Avoid_: Direct tool, live provider

**Live Tool Handle**:
A Cloudflare RPC value returned by an RPC Tool Provider that exposes its own method surface after the Codemode Function Call returns.
_Avoid_: Tool Function, nested codemode path, provider proxy

**Repo Durable Object**:
A project-scoped Durable Object selected by Project ID and repo slug and exposed to codemode as a Live Tool Handle.
_Avoid_: Repository row, repo provider, GitHub repo

**Workspace Durable Object**:
A project-scoped Durable Object selected by Project ID and workspace slug and exposed to codemode as a Live Tool Handle.
_Avoid_: Clerk Organization, Project, workspace alias

**Workspace**:
A project-scoped live work surface exposed to codemode through `ctx.workspace`.
_Avoid_: Clerk Organization, Project, workspace alias

**Outbound MCP From Our Client Capability**:
A Durable Object-backed codemode Tool Provider capability that connects from OS2 to one external MCP server using our MCP client connection and exposes that remote server as codemode Tool Functions through `executeCodemodeFunctionCall`.
_Avoid_: Project MCP Server Connection, inbound MCP server, MCP metadata provider, describe callable, MCP registry

**OpenAPI Client Capability**:
A capability that exposes one OpenAPI specification as codemode Tool Functions.
_Avoid_: OpenAPI metadata provider, describe callable, OpenAPI registry

**oRPC Capability**:
A capability that exposes an oRPC router or contract subtree as codemode Tool Functions using a server-side caller context.
_Avoid_: HTTP oRPC client, oRPC metadata provider, router registry

**Script**:
User-authored TypeScript or JavaScript code that can be run by codemode.
_Avoid_: Function, tool, provider, execution

**Script Execution**:
One attempt to run a Script on a Codemode Session.
_Avoid_: Script, execution ID, script ID

**Provider Bridge**:
An adapter that exposes an external system, such as OpenAPI or MCP, as a Tool Provider.
_Avoid_: Tool provider descriptor, session capability

**Project MCP Server Connection**:
A Durable Object-backed connection from an external MCP client into OS2's project-scoped MCP server, implemented by the `ProjectMcpServerConnection` Durable Object.
_Avoid_: Iterate MCP server, MCP client provider, outbound MCP connection

**Outbound MCP From Our Client Tool Provider**:
A Tool Provider registration whose RPC Callable targets an **Outbound MCP From Our Client Capability**.
_Avoid_: Project MCP Server Connection, project MCP route, inbound MCP

## Relationships

- The **OS2 App** has no public product pages; unauthenticated users are sent to Clerk sign-in.
- The **OS2 App** hides **Personal Account** mode and requires a **Clerk Organization** context.
- Every persisted OS2 record should have an explicit **Data Scope**: Project, Clerk Organization, Clerk User, or Global.
- A record's **Data Scope** should be represented as first-class queryable columns, not only inside JSON payloads or callable props.
- The **Durable Object Catalog** is infrastructure state and is separate from application-level **Project Projections**.
- **Durable Object Utility Routes** may be mounted into the OS2 Worker entrypoint so app code can reuse shared Durable Object initialization, catalog, and lifecycle utilities.
- A **Clerk Organization** owns zero or more **Projects**.
- A **Project** belongs to exactly one **Clerk Organization**.
- The **Project Durable Object** is the lifecycle authority for a **Project**.
- Every **Project** has one **Project Lifecycle Stream** at Event Stream Path `/project` in that Project's **Stream Namespace**.
- The **Project Lifecycle Stream** records **Project Lifecycle Events** as facts, not frontend view state.
- The **Project Lifecycle Processor** may use **Project Lifecycle Reduced State** to decide follow-up work, but **Project Lifecycle Events** remain the shared durable facts.
- The OS2 frontend may reduce **Project Lifecycle Events** with the same reducer as the **Project Lifecycle Processor**, but it does not own the Project lifecycle model.
- The **Project Listing Projection** is derived query state and should be written by the **Project Durable Object** as part of Project lifecycle commands.
- A **Project Route** includes both the owning **Clerk Organization** slug and the **Project** slug.
- A **Project Slug** is route identity and may change; a **Project ID** is stable identity.
- A **Project Route** resolves its **Project Slug** before rendering Project-local UI. Project-scoped oRPC procedures still accept `projectSlugOrId` so the same API remains curlable by slug or callable by stable Project ID.
- The **Project Slug** used in the **Project Route** corresponds to the project slug used by the events app.
- Every external **Project-Scoped Procedure** accepts `projectSlugOrId`, resolving globally unique Project Slugs and stable Project IDs through the same project-scope access path.
- A **Project Durable Object Namespace** is infrastructure context; a resolved and authorized **Project** is domain context.
- Browser routes use pretty Project Slugs in URLs and may pass either the slug or resolved stable Project ID to Project-scoped procedures.
- Every Project has a **Stable Project Ingress Host** derived from the **Project ID**.
- Every Project has a **Slug Project Ingress Host** derived from the current **Project Slug**.
- The **Stable Project Ingress Host** remains routable even when the slug-derived host changes.
- Custom hostname, default-host, dashboard-host, and stream-host lifecycle are future ingress work, not current routing behavior.
- A **Project MCP Route** identifies exactly one **Project**.
- A **Project MCP Route** is selected by project ingress, currently through platform hosts such as `mcp__<project-slug>.<project-host-base>`.
- OS2 does not expose a normal global MCP endpoint.
- The OS2 Worker classifies every request by **Ingress Hostname** before invoking the **OS2 App**.
- The OS2 Worker uses a global **Ingress Route Table** to decide whether a request becomes **Project Ingress** or continues to the **OS2 App**.
- Requests that do not match the global **Ingress Route Table** are handled by the **OS2 App**.
- Requests whose global **Ingress Routing Rule** resolves to a **Project Durable Object** are **Project Ingress** and are delegated to that Project's **Project Durable Object**.
- The **Ingress Route Table** is evaluated by pure matching logic over a request and a route lookup dependency.
- **Ingress Routing Rules** have stable unique IDs and deterministic priority ordering.
- The first concrete stored **Ingress Routing Rule** is an **Exact Host Ingress Rule** so the global lookup can compile to a simple indexed SQL query.
- Stored **Ingress Routing Rules** carry their target as a top-level **Fetch Callable**.
- **Fallback Ingress Rules** are provided by the caller and are not stored as seed data.
- The global **Ingress Route Table** stores project-owned exact-host rules, not OS2 App fallback routes.
- Global **Ingress Routing Rules** that route to a Project store **Project ID** as a first-class scope column as well as inside their **Fetch Callable** props.
- The **OS2 App Worker** is the fallback destination for every request that does not match a stored global **Ingress Routing Rule**.
- The **OS2 Ingress Worker** may be a separate public Worker script from the **OS2 App Worker**.
- The **OS2 App Worker** does not need its own public route when it is only reached through the **OS2 Ingress Worker**.
- The **Project Durable Object** stays exported from the main OS2 Worker for now so **Loopback Fetch Callables** can pass dynamic entrypoint props.
- The **Project Ingress Entry Point** is the public fetch-shaped bridge from a matched global ingress rule to the **Project Durable Object**.
- The **Project Ingress Entry Point** class/export name is `ProjectIngressEntrypoint`.
- The **Project Ingress Entry Point** takes only a stable **Project ID** prop in v1, resolves the Project Durable Object stub by using that **Project ID** as the Durable Object name, and delegates the request to the Project Durable Object's ingress RPC.
- The **Project Ingress Entry Point** does not accept **Project Slug** props in v1; slug-to-ID resolution happens before a request reaches hot ingress.
- **Project Egress** is future work. Until it is implemented, codemode Script `fetch(...)` calls go through the default **Codemode Fetch Capability** so they are traceable as Function Calls.
- The **Project MCP Server Entry Point** class/export name is `ProjectMcpServerEntrypoint`.
- The **Project MCP Server Entry Point** is a fetch-based Worker entrypoint, not a Tool Provider or Capability wrapper.
- The **Project MCP Server Entry Point** takes only a stable **Project ID** prop in v1 and is the default project-local MCP server fetch destination.
- A **Project MCP Route** is host-routed in v1; every path on that MCP hostname is delegated to the **Project MCP Server Entry Point**.
- The **Project MCP Server Entry Point** owns MCP protocol paths, OAuth protected-resource metadata paths, browser instructions, and 404s for unsupported paths on that MCP hostname.
- A browser request to a **Project MCP Route** that is not an MCP client connection may return a static HTML instructions page.
- The **Project MCP Server Connection** Durable Object class/catalog name is `ProjectMcpServerConnection`.
- The **Outbound MCP From Our Client Capability** Durable Object class name is `OutboundMcpFromOurClientCapability`.
- The **Outbound MCP From Our Client Capability** uses the `OUTBOUND_MCP_FROM_OUR_CLIENT_CAPABILITY` namespace binding.
- The **Project MCP Server Entry Point** owns MCP OAuth protocol verification in v1.
- The **Project Durable Object** must not grow MCP-specific authorization methods such as `authorizeMcpServerConnection`.
- The **Project Durable Object** may expose a generic **Project Access Check** in v1 for entrypoints that have already verified a principal.
- The v1 **Project Access Check** may use the app-level **Project Listing Projection** in D1 to verify the principal's Clerk Organization can access the Project.
- Future project-owned authorization should be modeled as generic **Project Route Authorization** for **Project Route Destinations**.
- New OS2 Worker named entrypoints live in an `entrypoints/` source folder, separate from `durable-objects/`.
- A **Loopback Fetch Callable** is preferred when an ingress rule needs to target a named OS2 Worker entrypoint with per-route props.
- The **Project Durable Object** exposes the **Project Control Surface** for project lifecycle commands.
- The **Create Project Command** is the domain command for creating a Project; do not call the domain command "initialize project".
- The app worker authenticates the caller, validates the requested slug, allocates the **Project ID**, gets the Project Durable Object by **Project ID**, and calls the **Create Project Command**.
- The **Create Project Command** writes the Project Durable Object's local lifecycle state and all v1 D1 projections before returning to the RPC caller.
- Asynchronous provisioning work, such as Cloudflare DNS/custom-hostname/certificate lifecycle, may continue after the **Create Project Command** has written durable desired state.
- TanStack/oRPC project routes should thinly proxy project lifecycle commands to the **Project Control Surface** instead of reimplementing project lifecycle logic in the app worker.
- The **Project Durable Object** owns project ingress routing. MCP auth currently lives in `ProjectMcpServerEntrypoint`, which calls a generic **Project Access Check**.
- The **Project Durable Object** is the authority for desired project-owned ingress state.
- Global **Ingress Routing Rules** for project-owned hostnames are **Project Projections** written for fast indexed lookup by the OS2 Worker.
- V1 may synchronously write **Project Projections** from **Project Control Surface** commands even though Durable Object SQLite and D1 are not one atomic transaction.
- **Project Ingress** currently includes platform slug/stable hosts and platform MCP aliases. Custom hosts and per-destination auth are future work.
- A **Project Durable Object** owns a project-local **Ingress Route Table** that maps **Project Ingress** to **Project Route Destinations**.
- A **Project Route Destination** is a kind of **Fetch Destination**.
- A **Fetch Destination** may be backed by OS2-packaged source code, runtime-loaded code, or another project-owned capability.
- Global and project-local ingress use the same **Ingress Route Table** concept even though their first concrete destinations differ.
- Projects are born with **Slug Project Ingress Host** and **Stable Project Ingress Host** routes.
- Projects are born with MCP hostname aliases for their slug and stable hosts, such as `mcp__<project-slug>.<project-host-base>` and `mcp__<project-id>.<project-host-base>`, that resolve to the **Project MCP Server Entry Point**.
- Slug changes should update slug-derived ingress routes at the same time; alias lifecycle is future work.
- A **Codemode Example Stack** is global static product data, not owned by a **Project**.
- **Codemode Example Stacks** are listed inside a **Project Route** because running an example requires a **Project**.
- Selecting a **Codemode Example Stack** pre-populates the **Codemode Session Creation Form** with authored provider inputs, Event Inputs, and one default Script.
- Editing a pre-populated form from a **Codemode Example Stack** does not mutate the **Codemode Example Stack**.
- Browser ad-hoc codemode runs are created through **Codemode Sessions**, not through a separate run-code concept.
- The **Codemode Session Control Plane** is domain-driven: callers provide **Scripts**, Event Inputs, Tool Providers, and an optional **Event Stream Path** rather than constructing the complete wire event sequence themselves.
- The **Codemode Session Control Plane** compiles a requested **Script Execution** into a script-execution-requested Event Input internally.
- When a **Codemode Example Stack**, custom Event Inputs, and a **Script** are combined, OS2 appends example Event Inputs, custom Event Inputs, then the script-execution-requested event.
- Browser UI creates **Codemode Sessions** through a session-first command where the **Script** is optional.
- Project MCP server `exec_js` starts a **Script Execution** and therefore requires a **Script**.
- Browser session creation and Project MCP server `exec_js` share the same internal attach-or-create and stream append behavior.
- A **Project Route** resolves its **Project Slug** to the stable **Project ID** before initializing a **Codemode Session**.
- A **Project MCP Route** resolves to the stable **Project ID** through project ingress before initializing a **Codemode Session**.
- A **Clerk User** acts through their **Active Organization** when managing **Projects**.
- A signed-in **Clerk User** without an **Active Organization** must create or select a **Clerk Organization** before using OS2.
- A remote OAuth MCP client calls OS2 with a **Clerk OAuth Token**.
- A first-party or e2e MCP client may call OS2 with a **Clerk Session Token** when it needs browserless user authentication.
- OS2 accepts Clerk user-token contracts for MCP; JWT token format is the preferred Clerk environment setting, not the domain boundary.
- The browser UI explicitly creates and selects **Codemode Sessions** for a **Project**.
- Browser oRPC calls identify the **Project** with `projectSlugOrId`; handlers resolve that value to the stable Project ID before touching capabilities or Durable Objects.
- Browser oRPC may pass an **Event Stream Path** when creating a **Codemode Session**; if it does not, OS2 generates one for the Project.
- The **Codemode Session Creation Form** may include an optional **Event Stream Path** so users can attach the codemode processor to an existing stream.
- Creating a **Codemode Session** is attach-or-create for the pair of **Project ID** and **Event Stream Path**.
- A **Project MCP Server Connection** already has an **Event Stream Path**; when it runs codemode, the **Codemode Session** uses that same Event Stream Path.
- Project MCP server `exec_js` may include Event Inputs, such as Tool Provider registration events, which are appended to the **Codemode Session** before the **Script Execution** starts.
- An **Outbound MCP From Our Client Capability** can be registered as a Tool Provider; it is unrelated to **Project MCP Server Connection** identity.
- A **Codemode Session** is initialized with exactly one stable **Project ID** and exactly one **Event Stream Path**.
- An **Event Stream Path** may exist before a **Codemode Session** is attached to it.
- For any given pair of **Project ID** and **Event Stream Path**, there is at most one **Codemode Session**.
- The **Project ID** and **Event Stream Path** together are the identity of a **Codemode Session**; the Durable Object name is derived from that structured name.
- A **Codemode Session Name** is the route identifier for a listed **Codemode Session**.
- A **Codemode Session Name** is not the domain identity of the **Codemode Session**; domain identity remains **Project ID** plus **Event Stream Path**.
- The **Codemode Session Control Plane** exposes explicit commands, not a generic append method.
- The **Codemode Session Control Plane** commands append codemode request events to the **Event Stream Path**.
- Low-level stream operations exposed to scripts are ordinary path-addressed **Tool Functions**.
- A **Codemode Session** starts a **Script** by appending a script-execution-requested event and returning that committed event immediately.
- The codemode processor should append exactly one **Codemode Session Started Event** as its user-space initialization event for a Codemode Session stream.
- The **Codemode Session Started Event** type is `events.iterate.com/codemode/session-started`.
- A **Codemode Session Started Event** carries only a **Session Capability Callable**.
- A singleton event for one stream may use its event type as its idempotency key.
- The codemode processor tracks whether it has emitted the **Codemode Session Started Event** in reduced state, similar to processor registration but specific to codemode's domain events.
- The **Session Capability Callable** is supplied to the codemode processor as a Runtime dependency; the shared processor does not construct OS2-specific callables itself.
- Reading Script Execution output is a subscription to the **Event Stream Path**, not part of the start command.
- A **Codemode Session** owns the Tool Provider registry for its **Event Stream Path**.
- One-shot adapters may register Tool Providers immediately before starting a **Script Execution**.
- A **Codemode Session** exposes a **Codemode Session Capability**.
- A **Codemode Context** is built locally from a **Codemode Session Capability**.
- A **Script** receives a **Codemode Context**.
- A **Script Execution** is identified by a **Script Execution ID** on the script-execution-requested event.
- Events belonging to a **Script Execution** refer to the **Script Execution ID**.
- Script Execution request events and completion events both include the **Script Execution ID**.
- A **Codemode Session** may have multiple in-flight **Script Executions** on the same **Event Stream Path**.
- The Codemode Session projection tracks in-flight and finished **Script Executions** from the event stream.
- A **Tool Provider** may receive a **Codemode Session Capability** when executing a **Tool Function**.
- A **Tool Provider** may use that **Codemode Session Capability** to make another **Tool Function Call**.
- Provider-to-provider calls are still mediated by the **Codemode Session** and produce normal Tool Function lifecycle events.
- In the first processor-first redesign, provider-to-provider awaitability is a warm-memory convenience over events: a **Tool Function Implementation** appends a nested function-call-requested event, waits in memory for the matching function-call-completed event, then continues.
- A **Function Call** starts by appending a function-call-requested event.
- A **Function Call** completes when a matching function-call-completed event appears.
- Function Call completion events reference the **Function Call ID**.
- Function Call request events and completion events both include the **Function Call ID**.
- Function Call request events include the full Function Call path, the matched **Provider Path**, and the provider-relative **Function Path**.
- Tool Function Implementations should normally switch on **Function Path**, not the full Function Call path, so they do not depend on their mount depth.
- Function Call request events use an `args` field for both Event-Mediated and RPC Tool Providers.
- RPC Function Call request `args` are best-effort serialized for traceability; Cloudflare live values such as callback functions, streams, or Durable Object stubs are represented as summaries while the real live values travel only through Workers RPC.
- Function Call completion events include the completed function path for readable event feeds and debugging.
- Function Call completion outcomes use JavaScript terms: a Function Call either `returned` a value or `threw` an error.
- The canonical durable Function Call protocol is a requested/completed event pair.
- A Tool Function Implementation completes an Event-Mediated Tool Function by appending a matching function-call-completed event.
- Function Call result delivery has separate dimensions: how a Tool Function Implementation observes requests, what kind of result value it returns, and how long the call takes.
- A Tool Function Implementation may observe Function Call requests by direct stream processing, queue subscription, pull-based polling, or another event delivery mechanism.
- HTTP/fetch result delivery can report only serialized return values and serialized exceptions.
- Workers RPC result delivery can report serialized values and Cloudflare live values such as functions, streams, `RpcTarget`s, or Durable Object stubs inside the active script/provider call chain.
- Long-running Function Calls must remain valid when their eventual result is serialized, even if no warm in-memory RPC channel remains.
- An **Event-Mediated Tool Function** can be implemented by a Tool Function Implementation that is not directly reachable when the Function Call is requested.
- A **Stateful Tool Provider Endpoint** may expose Tool Functions backed by a singleton connection, such as a Discord WebSocket held by one Durable Object.
- An **Outbound Tool Provider Actor** may execute Tool Functions from a browser extension, browser tab, or pull-based processor runner that cannot be called directly by codemode.
- An **RPC Tool Function** can receive live request arguments from a **Script**, including callback functions, streams, or Durable Object stubs.
- An **RPC Tool Function** can return live Cloudflare values to a **Script**.
- Codemode must support promise-pipelined Workers RPC call style for RPC Tool Functions, such as `await ctx.sandbox.get({ name }).exec({ cmd })`.
- A **Tool Provider** provides one or more **Tool Functions**.
- A **Tool Provider** may document its Tool Functions with **Tool Provider Instructions** instead of enumerating the full API surface as structured data.
- A **Leaf Tool Function** is a **Tool Function** whose remaining path is empty after provider resolution.
- A **Provider Bridge** adapts an external system into Tool Provider documentation plus a **Tool Function Implementation**.
- An **SDK-backed Tool Provider** resolves the Function Call path at execution time and delegates to the matching SDK member.
- Codemode calls **Tool Functions** by appending function-call-requested events and waiting for matching function-call-completed events.
- Every **Tool Function Call** has the same durable requested/completed event pair, regardless of provider mechanism.
- For an **RPC Tool Provider**, the **Codemode Processor** appends both the function-call-requested event and the function-call-completed event around `executeCodemodeFunctionCall(...)`.
- For an **Event-Mediated Tool Provider**, the **Codemode Processor** appends the function-call-requested event, but the Tool Function Implementation owns appending the matching function-call-completed event.
- `ctx.<provider>.<toolFunction>(payload)` calls a **Tool Function**.
- Built-in stream operations, such as append, are ordinary **Tool Functions** under paths like `ctx.streams.append(...)`.
- A **StreamsCapability** defaults operations to its narrowed **Event Stream Path** when the caller omits a path.
- In a narrowed **StreamsCapability**, stream paths without a leading slash, including `./` paths, resolve relative to the narrowed **Event Stream Path**.
- In a narrowed **StreamsCapability**, stream paths with a leading slash resolve as absolute project-scoped **Event Stream Paths** and remain subject to capability policy.
- Navigating to an **Event Stream Path** in the Project Stream Explorer may initialize that stream; users do not need a separate create-stream command.
- The **Project Stream Explorer** lists every initialized **Event Stream Path**, including `/`, as a flat list rather than a tree.
- For the **Project Stream Explorer**, an Event Stream Path exists in reality when its Stream Durable Object is initialized and cataloged for the Project.
- Child stream paths observed from a parent stream are navigation hints, not main-list entries, until their own Stream Durable Object is initialized.
- Agents exist within **Projects**.
- Agent work should be project-scoped and should not introduce new Clerk, organization, or auth concepts.
- An **Agent** is not a **Codemode Session**.
- An **Agent** may use the shared Agent processor and other shared stream processors almost verbatim.
- An **Agent Path** is project-local because the **Project ID** is already the **Stream Namespace**.
- The durable identity of an **Agent Durable Object** is derived from `{ projectId, agentPath }`.
- An **Agent Durable Object** may be the **StreamProcessorRunner** for its **Agent Path**.
- The `withStreamProcessor` API should let a Durable Object register multiple processors, and should namespace stored processor state by both **Event Stream Path** and processor identity.
- `withStreamProcessor` should not have a local stream path admission policy; subscription setup decides which Event Stream Paths deliver events to a Durable Object.
- When `withStreamProcessor` receives an event for an Event Stream Path it has not seen for a registered processor, it creates that processor's state container for that Event Stream Path and catches up from the stream as needed.
- If one Durable Object is subscribed to multiple Event Stream Paths, `withStreamProcessor` should process events for all of them using independent processor state per Event Stream Path.
- `withStreamProcessor` maintains a cursor and reduced state for each combination of registered processor and observed Event Stream Path.
- A new processor/path cursor starts at offset zero.
- The callable event delivery method exposed by `withStreamProcessor` should hide catch-up and consume boilerplate from Durable Object classes.
- The callable event delivery method exposed by `withStreamProcessor` is `afterAppend({ event })`.
- For one inbound event, `withStreamProcessor` runs all registered processors concurrently.
- Processors hosted by the same Durable Object must still coordinate through appended stream events, not through in-memory ordering between processors.
- `withStreamProcessor` treats each processor/path cursor independently; one processor failure should not stop successful sibling processors from advancing.
- In v1, processor failures should append loud processor error events to the stream instead of relying on callable delivery retry.
- In v1, `afterAppend({ event })` does not need to throw an aggregate error after appending processor error events, because stream subscription delivery does not currently retry usefully.
- Receiving an event whose offset is behind a processor/path cursor is a loud ordering/corruption error, not a silent no-op.
- Events appended by a processor are committed to the stream and later delivered back through stream subscription or caught by cursor catch-up; processors hosted by the same Durable Object should not invoke sibling processors directly in memory for newly appended events.
- `withStreamProcessor` should expose inspectable runtime state, optionally through a fetch/debug path.
- To measure local append-to-delivery delay, `withStreamProcessor` should keep an in-memory log of local append timestamps keyed by returned stream offset, then compare that timestamp when the same offset is later received through subscription delivery.
- Local append-to-delivery delay should not be derived from the event's `createdAt`, because that measures stream commit timestamp rather than this runner's local append call.
- `withStreamProcessor` should provide **Stream Processor waitUntil** to stream processor hooks such as `afterAppend`.
- **Stream Processor waitUntil** is a default runner capability available to ordinary stream processors; processors should not need an app-specific Runtime dependency just to keep a promise alive.
- **Stream Processor waitUntil** is best-effort in-memory liveness; it is not durable alarm-backed recovery.
- **Stream Processor waitUntil** should be implemented through the repo's keep-alive primitive if one exists, or introduced deliberately before relying on opaque long-running promises.
- Processor Runtime dependencies that need `waitUntil`-style behavior should use **Stream Processor waitUntil**, not raw Durable Object `ctx.waitUntil`.
- In v1, `withStreamProcessor` registrations happen during `registerOnInstanceWake(...)`; post-startup dynamic processor registration is not supported.
- Public callable stream processor delivery methods should call `ensureStarted()` before consuming an event, so processor registration has completed before inbound event delivery runs.
- `withStreamProcessor` should use callable stream subscriptions for processor delivery.
- `withStreamProcessor` should expose an explicit helper for installing callable stream subscriptions; registering a processor should not automatically write subscription events.
- The canonical pattern is to install callable stream subscriptions in `registerOnFirstInitialize(...)`, because subscription configuration is durable stream setup that should run once for the Durable Object lifetime.
- The canonical pattern is to register processor instances in `registerOnInstanceWake(...)`, because processor instances and Runtime dependencies are per-JavaScript-instance state.
- **Tool Provider** registration is primarily documentation; runtime callability may be supplied by processor helpers but is not the primary meaning of registration.
- Codemode supports two principal Tool Provider mechanisms: **Event-Mediated Tool Providers** and **RPC Tool Providers**.
- An **Event-Mediated Tool Provider** is the default for stream processors, long-running processors, pull-based actors, and SDK-backed processors that can work from the event log.
- An **RPC Tool Provider** is required when a Script must pass or receive Cloudflare live values, preserve Workers RPC promise pipelining, or call a platform binding through a small policy-enforcing capability.
- An **RPC Tool Provider** receives `executeCodemodeFunctionCall(...)` input with the full path, matched **Provider Path**, provider-relative **Function Path**, args, invocation kind, IDs, and **Codemode Session Capability** so one thin wrapper can proxy a whole SDK, binding surface, or Live Tool Handle lookup.
- Capability modules may expose a **Callable Builder** so registration code can construct the relevant Callable descriptor without hand-writing callable JSON.
- A **Live Tool Handle** returned by an **RPC Tool Provider** is not itself a Codemode Context path proxy.
- Codemode records the Function Call that returns a **Live Tool Handle**; methods later called on that handle belong to the handle's own Workers RPC surface unless that provider adds its own tracing.
- Provider-to-provider composition uses a **Codemode Context** or **Codemode Session Capability** inside the Tool Function Implementation and records nested Function Call lifecycle events.
- Event-Mediated Tool Providers may reduce over the **Codemode Session Started Event**, store its **Session Capability Callable**, and use that callable to build a **Codemode Context**.
- The Repo example uses a WorkerEntrypoint **RPC Tool Provider** that returns a **Live Tool Handle** for a **Repo Durable Object** selected by Project ID from provider props and the requested slug.
- The **Workspace** example uses a **Workspace Durable Object** as the **RPC Tool Provider** itself, with `executeCodemodeFunctionCall` implemented on the Durable Object.
- `ctx.workspace` is an implicit current **Workspace**; its Durable Object identity is selected by the registered RPC callable, not by a selector passed in the Script.
- `ctx.agents.create()` is a namespaced **RPC Tool Function** that returns a **Live Tool Handle** for an **Agent Durable Object**.
- `ctx.agents.create().sendMessage(...)` is the explicit **Live Tool Handle** case.
- `ctx.agents.create().doThing(...)` is the promise-pipelined **Live Tool Handle** case.
- A **Unary Tool Provider** uses an empty **Function Path** to mean the provider itself is the called function.
- Dynamic MCP and OpenAPI discovery should be exposed as ordinary Tool Functions such as `listTools` and `listOperations`, not as a separate provider-description protocol.
- An **Outbound MCP From Our Client Capability** owns one MCP client connection to one external MCP server in v1.
- An **oRPC Capability** may expose nested oRPC routers as nested Codemode Context paths.
- An **oRPC Capability** should call OS2 oRPC handlers in-process with a server-side caller context when the implementation is available in the same Worker.
- An **oRPC Capability** should expose generated TypeScript signatures through ordinary discovery Tool Functions, not by embedding the full API surface in Tool Provider registration.
- External MCP tool names and OpenAPI operation IDs are treated as exact Function Path segments, even when they contain dots.
- OS2 should register codemode examples for each supported Tool Provider topology so users can run real Scripts against the examples.

## Target Codemode Blocks

```ts
await ctx.slack.chat.postMessage({ channel: "C123", text: "hello" });
```

The Slack case targets an **Event-Mediated Tool Provider** and **SDK-backed Tool Provider**: the registered documentation can say that `ctx.slack` delegates to the Slack SDK, while the Slack processor maps the remaining path to the SDK member at execution time.

```ts
await ctx.discord.sendMessage({ channelId: "123", content: "hello" });
```

The Discord case targets an **Event-Mediated Tool Provider** backed by a long-running processor or Durable Object that owns a singleton Discord WebSocket connection and appends completion events after Discord responds.

```ts
await ctx.browserExtension.click({ selector: "button[type=submit]" });
const title = await ctx.browserExtension.textContent({ selector: "h1" });
```

The browser case targets an **Outbound Tool Provider Actor**: a browser extension, browser tab, or pull-based processor runner may observe Function Call requests and report completion through outbound communication.

```ts
const result = await ctx.sandbox.get({ name: "build" }).exec("pnpm test");
```

The sandbox case targets an **RPC Tool Function** that returns a **Live Tool Handle** and preserves Workers RPC promise pipelining, so codemode must not eagerly await the intermediate sandbox handle before returning it to the Script.

```ts
await ctx.repos.get({ slug: "web" }).proofOfConcept({
  callback: async (args) => {
    console.log("callback called", args);
  },
});
```

The Repo case targets an **RPC Tool Provider** whose `repos.get` Function Call returns a **Live Tool Handle** for a Repo Durable Object initialized by Project ID and slug; `proofOfConcept` is a method on that returned handle, not a separate Codemode Function Call.

```ts
await ctx.workspace.proofOfConcept({
  callback: async (args) => {
    console.log("workspace callback called", args);
  },
});
```

The Workspace case targets a singular **Workspace** surface: `ctx.workspace` is backed directly by a **Workspace Durable Object** RPC Tool Provider that implements `executeCodemodeFunctionCall`.

```ts
const result = await ctx.agents.create().sendMessage({
  message: "hi",
  subPath: "bob",
});
```

The Agent case targets a namespaced **Unary Tool Provider**: `agents.create()` is the Codemode Function Call with an empty provider-relative **Function Path**, it returns a **Live Tool Handle** for an **Agent Durable Object**, and `sendMessage` is a Workers RPC method on that returned handle.

```ts
const result = await ctx.agents.create().doThing({
  label: "promise-pipeline",
  value: 21,
});
```

The promise-pipelined Agent case targets the same root-level **Unary Tool Provider** shape, but proves that codemode can preserve Workers RPC promise pipelining when a **Live Tool Handle** is returned and immediately called.

```ts
const tools = await ctx.mcp.cloudflareDocs.listTools();
console.log("Cloudflare Docs MCP tools", tools);

const answer = await ctx.mcp.cloudflareDocs.search({
  query: "Workers RPC promise pipelining",
});
```

The MCP case targets an **Outbound MCP From Our Client Capability**: `ctx.mcp.cloudflareDocs.listTools()` is an ordinary Tool Function that returns the live MCP tool listing, and listed tools are called through the same provider namespace.

```ts
const operations = await ctx.petstore.listOperations();
console.log("Petstore operations", operations);

const pet = await ctx.petstore.getPetById({ petId: 123 });
```

The OpenAPI case targets an **OpenAPI Client Capability**: `ctx.petstore.listOperations()` is an ordinary Tool Function that explains the spec-derived operation surface, and operation IDs are called through the same provider namespace.

```ts
const streams = await ctx.os.streams.list({});
console.log("Project streams", streams);
```

The oRPC case targets an **oRPC Capability**: the real `os.project.*` router is exposed as project-bound `ctx.os.*`, and the capability supplies the server-side caller context needed to run the handler in-process.

```ts
const procedures = await ctx.os.listProcedures();
console.log("OS2 oRPC procedures", procedures);

const sessions = await ctx.os.codemode.listSessions({});
```

The oRPC discovery case mirrors MCP and OpenAPI: `ctx.os.listProcedures()` is an ordinary Tool Function that walks the exposed oRPC contract/router metadata and returns generated TypeScript signatures for the exposed project-bound subtree. Provider-generated type definitions should declare a full **Codemode Context** root named `ctx`, including `ctx.fetch`, `ctx.console`, and the provider's own methods nested under its mounted **Provider Path** such as `ctx.os` or `ctx.builtin.slack`. The generated `ctx.os` surface strips `projectSlugOrId`; if a script supplies `projectSlugOrId`, the oRPC capability throws instead of merging it.

```ts
const response = await fetch("https://api.example.com/data");
```

The fetch case targets the **Codemode Fetch Capability** first: ordinary Script `fetch` is a default Tool Function so it is traceable in codemode events. Project-owned outbound policy and egress proxy enforcement belong inside that capability as it hardens.

```ts
console.log("deployed", { version: "abc123" });
```

The console case targets codemode telemetry: ordinary Script console calls should produce codemode log events without requiring explicit `ctx.log` calls.

```ts
const answer = await ctx.ai.run("@cf/meta/llama-3.1-8b-instruct", {
  prompt: "Summarize the latest deployment log.",
});
```

The AI case targets a minimal wrapper around the Workers AI binding: codemode should make `env.AI.run(model, options)` available without forcing OS2 to enumerate every model-specific argument shape.

```ts
const stream = await ctx.ai.run("@cf/meta/llama-3.1-8b-instruct", {
  prompt: "Stream a release note.",
  stream: true,
});
```

The streaming AI case targets an **RPC Tool Provider** because Workers AI can return streamed results that should remain live when the underlying Workers RPC transport supports them.

```ts
const screenshot = await ctx.browserRendering.screenshot("https://example.com", {
  viewport: { width: 1280, height: 720 },
});
```

The browser rendering case targets Cloudflare Browser Run: simple browser actions should be available with low boilerplate, while richer sessions may delegate to the underlying Puppeteer, Playwright, or CDP APIs.

```ts
await ctx.browserRun.page({ session: "checkout" }).goto("https://example.com");
const png = await ctx.browserRun.page({ session: "checkout" }).screenshot();
```

The Browser Run session case targets an **RPC Tool Provider** backed by a Durable Object that owns or reuses a live browser session and returns promise-pipelineable **Live Tool Handles**.

```ts
await ctx.streams.append({
  path: "/projects/proj_123/audit",
  event: {
    type: "events.example.com/audit/note-added",
    payload: { message: "hello" },
  },
});
```

The streams case targets low-level stream operations as Tool Functions: codemode may append to the current Event Stream Path by default, and may append to another allowed Event Stream Path when a path is provided.

```ts
await ctx.providerA.composeFromProviderB({ value: "hello" });
```

The provider composition case targets provider-to-provider Tool Function Calls: a Tool Function Implementation should be able to receive a **Codemode Context** or **Codemode Session Capability** and call other Tool Functions while codemode records the nested Function Call lifecycle.

## Example Dialogue

> **Dev:** "When a script runs `ctx.linear.createIssue(...)`, is that a tool execution?"
> **Domain expert:** "It is a **Tool Function Call**. The **Codemode Session** calls the **Tool Function**, and the **Tool Provider** executes it."

> **Dev:** "Is `ctx.streams.append(...)` also a Tool Function Call?"
> **Domain expert:** "Yes. Stream append is just another path-addressed function; the runtime appends function-call-requested and waits for the corresponding function-call-completed event."

> **Dev:** "If Provider B calls Provider A while executing a Tool Function, is that a private provider call?"
> **Domain expert:** "No. Provider B uses the **Codemode Session Capability** to make another **Tool Function Call**, so the **Codemode Session** records the same lifecycle events as any other Tool Function Call."

> **Dev:** "Does a Function Call dispatch the Provider directly?"
> **Domain expert:** "No. A **Tool Function Call** is event-driven: append the requested event, then wait for the matching completed event."

> **Dev:** "Is `ctx.repos.get({ slug }).proofOfConcept(...)` two Codemode Function Calls?"
> **Domain expert:** "No. `repos.get` is the Codemode Function Call. It returns a **Live Tool Handle**, and `proofOfConcept` is a Workers RPC method on that returned handle."

> **Dev:** "Does `ctx.agents.create().sendMessage(...)` have a provider namespace?"
> **Domain expert:** "Yes. Use `ctx.agents.create()` so agent creation is grouped under the agents provider namespace while still returning a **Live Tool Handle**."

> **Dev:** "Do we need two separate subagent creation functions?"
> **Domain expert:** "No. `ctx.agents.create()` covers explicit handle use and promise-pipelined handle use."

> **Dev:** "Should a provider switch on the full path where it was mounted?"
> **Domain expert:** "No. Codemode passes both **Provider Path** and **Function Path**; providers should usually switch on **Function Path**."

> **Dev:** "Do RPC Function Call request events use `argsSummary`?"
> **Domain expert:** "No. Use `args` for the event field and serialize live values as well as possible for traceability."

> **Dev:** "Should Function Call completion say succeeded or failed?"
> **Domain expert:** "No. Use JavaScript semantics: a Function Call `returned` or `threw`."

> **Dev:** "Should an RPC Tool Provider implement `executeFunctionCall`?"
> **Domain expert:** "Use `executeCodemodeFunctionCall` so the method name is explicit about codemode's Function Call protocol."

> **Dev:** "How can an Event-Mediated Tool Provider call another Tool Function?"
> **Domain expert:** "Reduce over the **Codemode Session Started Event**, store its **Session Capability Callable**, and build a **Codemode Context** when handling a Function Call."

> **Dev:** "Should every registration hand-write Callable JSON?"
> **Domain expert:** "No. Capability modules may expose a **Callable Builder** for the callable shape they support."

> **Dev:** "Should MCP provider registration dynamically append detailed tool instructions?"
> **Domain expert:** "No. Register stable **Tool Provider Instructions** that tell the Script to call `listTools`; dynamic discovery is an ordinary Tool Function."

> **Dev:** "Should `docs.search` from an MCP server become `ctx.docs.search(...)`?"
> **Domain expert:** "No. External tool names and OpenAPI operation IDs are exact **Function Path** segments, so use bracket syntax such as `ctx.mcp.cloudflareDocs['docs.search'](...)` when needed."

> **Dev:** "Should codemode call OS2 oRPC handlers over HTTP?"
> **Domain expert:** "No. An **oRPC Capability** should use a server-side caller context and call in-process when the router implementation is in the same Worker."

> **Dev:** "Should oRPC provider registration include the full TypeScript router surface?"
> **Domain expert:** "No. Keep registration instructions short and expose generated signatures through an ordinary discovery Tool Function such as `ctx.os.listProcedures()`."

> **Dev:** "How does codemode learn how to use a provider?"
> **Domain expert:** "Tool Provider registration carries **Tool Provider Instructions** directly."

> **Dev:** "Does creating a **Codemode Session** always create a new stream?"
> **Domain expert:** "No. A **Codemode Session** is attached to an **Event Stream Path**, which may be newly chosen by OS2 or may already exist."

> **Dev:** "What is the ID of a **Codemode Session**?"
> **Domain expert:** "Use the pair of **Project ID** and **Event Stream Path**. The Durable Object name is derived from that structured name."

> **Dev:** "Should we store an execution ID when a script starts?"
> **Domain expert:** "Yes. Store a **Script Execution ID** on the requested event and copy it to related events. It may be offset-derived if the caller can know the offset before append; otherwise the caller mints it before append."

> **Dev:** "Should starting a Script stream all results back from the command?"
> **Domain expert:** "No. Starting a **Script Execution** returns the committed request event immediately. Output is read from the **Event Stream Path**."

> **Dev:** "Is there a separate Project Run Code Session concept above Codemode Session?"
> **Domain expert:** "No. The concept is **Codemode Session**. Browser UI creates explicit Codemode Sessions with their own Event Stream Paths; Project MCP server connections reuse the MCP connection's existing Event Stream Path."

> **Dev:** "Should MCP `exec_js` take a project selector?"
> **Domain expert:** "No. MCP is project-scoped: the **Project MCP Route** identifies the **Project**. Browser oRPC gets the project from the **Project Route** and resolves the stable **Project ID**."

> **Dev:** "Does a Codemode Session init with the project slug?"
> **Domain expert:** "No. Routes use **Project Slug**, but Codemode Session init uses the stable **Project ID** resolved from that route."

> **Dev:** "Who chooses the Event Stream Path for browser-created Codemode Sessions?"
> **Domain expert:** "Browser oRPC may pass one to attach to an existing stream; otherwise OS2 generates an Event Stream Path for the Project."

> **Dev:** "What if a Codemode Session already exists for that Project ID and Event Stream Path?"
> **Domain expert:** "Treat creation as attach-or-create. Return the existing Codemode Session for that identity, or initialize it if it does not exist."

> **Dev:** "Is an MCP Tool Provider the same thing as OS2's MCP server connection?"
> **Domain expert:** "No. An **Outbound MCP From Our Client Tool Provider** can be a Tool Provider. A **Project MCP Server Connection** is an external client connected to OS2's project-scoped MCP server."

> **Dev:** "What are the two MCP directions in OS2?"
> **Domain expert:** "Inbound MCP is OS2 acting as the MCP server via the fetch-based `ProjectMcpServerEntrypoint` and `ProjectMcpServerConnection`. Outbound MCP is OS2 acting as an MCP client via `OutboundMcpFromOurClientCapability`, which can be registered as a codemode Tool Provider."

> **Dev:** "Should the Durable Object behind OS2's project-scoped MCP server be called `IterateMcpServer`?"
> **Domain expert:** "No. Use `ProjectMcpServerConnection`: it describes one external MCP client connection and avoids confusing OS2-as-server with OS2-as-client."

> **Dev:** "Can someone open an OS2 project page without signing in?"
> **Domain expert:** "No. The **OS2 App** is authenticated, and every **Project** is managed through the user's active **Clerk Organization**."

> **Dev:** "Can a **Personal Account** own a **Project**?"
> **Domain expert:** "No. OS2 only lets a **Clerk Organization** own **Projects**."

> **Dev:** "Can a project page be addressed without the organization slug?"
> **Domain expert:** "No. A **Project Route** is organization-scoped and includes both the Clerk Organization slug and the Project slug."

> **Dev:** "What should OS2 show after sign-in if Clerk has no **Active Organization**?"
> **Domain expert:** "Show Clerk's organization selection or creation flow before rendering the **OS2 App**."

> **Dev:** "Does the MCP server require a Clerk JWT?"
> **Domain expert:** "No. The MCP server requires a valid OS2 admin token or Clerk user token. OAuth MCP clients use a **Clerk OAuth Token**; browserless first-party and e2e clients may use a **Clerk Session Token**. JWT is the preferred Clerk token format for cheaper verification, but OS2 should not model MCP auth as JWT-only."

> **Dev:** "Should a request for a Project-owned hostname hit the OS2 App auth middleware before project routing?"
> **Domain expert:** "No. The OS2 Worker first classifies the **Ingress Hostname**. If it is a **Project-Owned Hostname**, the request becomes **Project Ingress** before OS2 App auth runs."

> **Dev:** "Is the global hostname lookup a special project-hostname table?"
> **Domain expert:** "No. Model it as an **Ingress Route Table**. Matching an HTTP request yields a **Fetch Destination**; one such destination is the Project Durable Object."

> **Dev:** "Do fallback routes live as rows in D1?"
> **Domain expert:** "No. They are **Fallback Ingress Rules** supplied by the caller, so a reader can understand the default behavior from the Worker or Project Durable Object source."

> **Dev:** "Should the TanStack Start worker itself be the public entrypoint?"
> **Domain expert:** "Not necessarily. Prefer a skinny **OS2 Ingress Worker** as the public entrypoint, with the **OS2 App Worker** reachable only through a service binding."

> **Dev:** "Should an ingress rule store a nested `{ callable: ... }` destination?"
> **Domain expert:** "No. Store the route target directly as a top-level **Fetch Callable** on the rule."

> **Dev:** "Should v1 route matching support path and header predicates?"
> **Domain expert:** "No. Use **Exact Host Ingress Rules** first so the lookup stays a direct indexed SQL query."

> **Dev:** "Should the Project Durable Object be deployed in a separate worker script immediately?"
> **Domain expert:** "Not yet. Keep it exported from the main OS2 Worker while Project ingress depends on **Loopback Fetch Callables** with dynamic props."

> **Dev:** "Does `/mcp` on a Project-owned hostname route to the Project MCP server?"
> **Domain expert:** "No. MCP uses host-routed project ingress. Current platform aliases use the single-label `mcp__<project>.<project-host-base>` shape."

> **Dev:** "Does the Project Durable Object need to understand MCP protocol paths?"
> **Domain expert:** "No. It routes the MCP hostname to the **Project MCP Server Entry Point**. That entry point owns protocol paths, OAuth metadata, browser setup instructions, and unsupported-path responses."

> **Dev:** "Should Project Durable Object expose `authorizeMcpServerConnection(...)`?"
> **Domain expert:** "No. MCP is one Project Route Destination among many. Future authorization should be generic **Project Route Authorization**, not a method per destination type."

> **Dev:** "How should `ProjectMcpServerEntrypoint` check access in v1 after verifying Clerk OAuth?"
> **Domain expert:** "Call a generic **Project Access Check** on the Project Durable Object. The Project Durable Object can implement that check by reading the app-level D1 Project projection for the caller's Clerk Organization."

> **Dev:** "What should a global ingress rule point at for project traffic?"
> **Domain expert:** "Point it at `ProjectIngressEntrypoint`, the **Project Ingress Entry Point**, with the stable **Project ID** in props. That entry point resolves the Project Durable Object and delegates to its ingress RPC."

> **Dev:** "Is Project Egress just another Project Ingress route?"
> **Domain expert:** "No. **Project Ingress** handles inbound public requests to Project-owned hostnames. **Project Egress** is future outbound policy work; see `tasks/project-egress-secrets-mvp.md`."

> **Dev:** "Can `ProjectIngressEntrypoint` props identify a Project by slug?"
> **Domain expert:** "Not in v1. Slugs are mutable and belong to control-plane routing. Hot ingress uses the stable **Project ID** already resolved by the exact-host route lookup."

> **Dev:** "Which public host should OS2 use when linking to a Project?"
> **Domain expert:** "Use the slug platform host for now. The stable ID platform host remains routable; custom/default host selection is future work."

> **Dev:** "Should the Project Durable Object command be named `initializeProject`?"
> **Domain expert:** "No. Use **Create Project Command** / `createProject`. `initialize` is infrastructure lifecycle language, not the Project domain command."

> **Dev:** "What happens to slug-derived hosts if the Project Slug changes?"
> **Domain expert:** "The slug-derived routes should change with the slug. The stable ID host remains routable; alias lifecycle can be added later."

> **Dev:** "If `fetchCallable.props.projectId` already contains the Project ID, should the ingress route row also have a `project_id` column?"
> **Domain expert:** "Yes. Data model scope should be first-class. Keep `project_id` queryable for listing, indexing, repair jobs, and ownership checks."

> **Dev:** "Should TanStack/oRPC implement project lifecycle logic directly?"
> **Domain expert:** "No. It should proxy project lifecycle commands to the **Project Control Surface** on the **Project Durable Object**. The app worker owns HTTP/auth plumbing, not the project lifecycle model."

> **Dev:** "Is the global exact-host D1 route table authoritative?"
> **Domain expert:** "No. It is a **Project Projection**. The **Project Durable Object** owns desired project ingress state, while D1 gives the Worker a simple indexed lookup."

> **Dev:** "Is the `projects` D1 table the source of truth for Project lifecycle?"
> **Domain expert:** "No. It is a **Project Listing Projection**. The **Project Durable Object** owns lifecycle state and writes the app-level D1 row for listing and routing."

> **Dev:** "Is the automatic Durable Object tracking table the same thing as the `projects` table?"
> **Domain expert:** "No. The **Durable Object Catalog** is shared infrastructure state for initialized Durable Objects. The **Project Listing Projection** is product query state."

## Flagged Ambiguities

- "function" can mean a JavaScript function, a Tool Function, or a session control operation. Resolved: use **Tool Function** only for functions provided by Tool Providers.
- "script" and "execution" were conflated. Resolved: **Script** is code; **Script Execution** is one attempt to run it.
- "execute" and "call" were used interchangeably. Resolved: codemode **calls** Tool Functions; Tool Providers **execute** Tool Functions.
- "tools" was used for both the whole context and provider functions. Resolved: the local object is **Codemode Context**; provider callables are **Tool Functions**.
- "describe callable" added a second Tool Provider execution path. Resolved: Tool Provider registration carries short **Tool Provider Instructions**; richer discovery is exposed as ordinary Tool Functions such as `listTools`, `listOperations`, or `listProcedures`.
- "ExecutionContext" conflicts with Cloudflare's Worker `ExecutionContext`. Resolved: use **Codemode Context** for codemode userland.
- "session id" and "stream path" were conflated. Resolved: **Project ID** plus **Event Stream Path** is the **Codemode Session** identity.
- "app" can mean the OS2 product or a managed project surface. Resolved: use **OS2 App** for this dashboard and **Project** for the managed app surface.
- "personal organization" is misleading because Clerk treats personal accounts separately from organizations. Resolved: use **Personal Account** for Clerk's non-organization user context.
- "MCP JWT" is too narrow for Clerk OAuth Applications and Clerk session-based e2e. Resolved: use **Clerk OAuth Token** for OAuth MCP bearer tokens and **Clerk Session Token** for first-party/e2e bearer tokens, regardless of Clerk's token format setting.
- "project URL" was ambiguous between stable IDs and slugs. Resolved: use **Project Route** for the user-facing organization-slug/project-slug URL.
- "MCP" can mean OS2 as an MCP server or OS2 as a client of another MCP server. Resolved: use **Project MCP Server Entry Point** plus **Project MCP Server Connection** for external clients connected to OS2, and **Outbound MCP From Our Client Capability** for OS2 connecting to external MCP servers as codemode Tool Providers.
- "`IterateMcpServer`" names the product, not the domain concept. Resolved: use `ProjectMcpServerConnection` for the Durable Object class/catalog name.
- "Project Run Code Session" added an unnecessary layer. Resolved: use **Codemode Session** directly.
- "route" can mean a TanStack route, a Worker hostname match, or a Project-local destination. Resolved: use **Ingress Hostname** for the Worker-level host classifier, **Project Route** for the authenticated OS2 dashboard URL, and **Project Route Destination** for a Project Durable Object target.
- "authentication" can happen at the OS2 App layer or inside Project Ingress. Resolved: the OS2 App authenticates dashboard/control-plane routes; MCP auth currently lives in the **Project MCP Server Entry Point**.
- "fetch callable" overlaps with generic JavaScript functions and Tool Provider callables. Resolved: use **Fetch Destination** for an ingress target that can receive an HTTP request.
- "context request" made codemode look like a generic invocation broker. Resolved: use **Function Call** only for path-addressed codemode functions, and keep **Tool Provider** registration as model-visible information first.
- "documentation" sounded like a generated API schema or external docs page. Resolved: use **Tool Provider Instructions** for the string-form guidance registered with a Tool Provider.
- "executeFunctionCall" was clear but too generic for Worker and Durable Object classes. Resolved: use `executeCodemodeFunctionCall` for the RPC Tool Provider entry method.
- "Workspace" is usually avoided for Clerk Organization or Project. Resolved: **Workspace Durable Object** is a separate codemode live-resource concept selected by Project ID and workspace slug.
- "`ctx.workspaces.get`" made Workspace look like a repo-style collection lookup. Resolved: use singular `ctx.workspace` for the codemode Workspace surface.
- "root tool" could imply a special non-provider mechanism. Resolved: subagent creation is the namespaced **RPC Tool Function** `ctx.agents.create()` registered at path `["agents", "create"]`.
- "path" was doing two jobs: identifying the full Codemode Context call and identifying the function relative to the provider. Resolved: use **Provider Path** for the registered mount path and **Function Path** for the provider-relative call path.
- "argsSummary" made RPC Function Calls look like a separate event family. Resolved: Function Call request events keep an `args` field and serialize live values best-effort.
- "static callable" sounded like one fixed descriptor. Resolved: use **Callable Builder** for helpers that construct different Callable descriptors for one Capability.
- "codemode-session-capability callable" was too noun-heavy and unclear about the value kind. Resolved: use **Session Capability Callable** for the Callable carried by `events.iterate.com/codemode/session-started`.
- "Project DO worker" conflicted with loopback props. Resolved: use **Project Ingress Entry Point** and **Project MCP Server Entry Point** as same-worker loopback targets for now, while the **Project Durable Object** remains exported by the main OS2 Worker.
- "project UI state" and lifecycle status could make the frontend look authoritative. Resolved: **Project Lifecycle Events** are durable facts, and UI can reduce them without owning the lifecycle model.
- "project identity" in entrypoint props could mean slug or ID. Resolved: v1 ingress entrypoints accept **Project ID** only; **Project Slug** resolution happens in control-plane routes or route-registry writes.
- "canonical project host" could mean stable ID host, slug host, or future custom host. Resolved for current code: use **Stable Project Ingress Host** for the ID-derived host and **Slug Project Ingress Host** for the slug-derived host.
- "initialize project" conflates infrastructure lifecycle with domain creation. Resolved: use **Create Project Command** for the Project Durable Object domain command.
- "scope" could be hidden inside payload JSON. Resolved: OS2 persisted records should expose their **Data Scope** through queryable columns.
- "source of truth" for project ingress could mean the global D1 lookup table. Resolved: the **Project Durable Object** owns desired ingress state; D1 rows are **Project Projections**.
- "project table" could mean app-level listing state or mixin-owned Durable Object tracking. Resolved: use **Project Listing Projection** for the app D1 row and **Durable Object Catalog** for shared DO tracking tables.
- "MCP authorization" could become a one-off Project Durable Object method. Resolved: avoid MCP-specific Project DO auth methods; model future auth as generic **Project Route Authorization**.
- "project access" and "route authorization" are different depths of policy. Resolved: v1 can use a generic **Project Access Check**; richer destination-specific policy belongs to future **Project Route Authorization**.
- "egress proxy", "egress gateway", and **Project Ingress** were used around outbound traffic. Resolved for current code: use **Project Egress** only as a pointer to future outbound policy work.
