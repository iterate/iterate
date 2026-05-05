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
The mutable slug used in Project Routes and mirrored into the events app project slug.
_Avoid_: Project ID

**Project Route**:
The organization-scoped URL for a Project, identified by Clerk Organization slug and Project slug.
_Avoid_: Global project URL, project ID URL

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
The human-readable platform Project Ingress Host derived from the Project Slug, such as `<project-slug>.iterate.app`.
_Avoid_: Stable project host

**Stable Project Ingress Host**:
The immutable platform Project Ingress Host derived from the Project ID, such as `<project-id>.iterate.app`.
_Avoid_: Slug project host, canonical host

**Custom Project Ingress Host**:
A user-owned Project Ingress Host assigned to one Project, such as `mycustomer.com`.
_Avoid_: Platform host

**Default Project Ingress Host**:
The Project Ingress Host OS2 uses when generating ordinary public URLs for a Project.
_Avoid_: Stable project host, all project hosts

**Project Dashboard Host**:
A project-owned host such as `iterate.<project-ingress-host>` that routes to the OS2 dashboard for that Project.
_Avoid_: Project app host, MCP host

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
Outbound HTTP/S traffic made from a Project-owned execution context and governed by that Project's outbound policy.
_Avoid_: Project Ingress, generic fetch, external calls

**Project Egress Entry Point**:
A named WorkerEntrypoint exported as `ProjectEgressEntrypoint` that receives Project identity as props, resolves the Project Durable Object, and delegates Project Egress to it.
_Avoid_: Egress gateway, egress proxy, outbound worker

**Dynamic Worker Egress Gateway**:
The `globalOutbound` binding given to a Dynamic Worker so the worker's outbound `fetch()` calls become Project Egress.
_Avoid_: External fetch gateway, raw internet access

**Project Egress Policy**:
Project-owned rules that decide whether a Project Egress request is allowed, denied, or held for human review.
_Avoid_: Secret rule, firewall rule

**Project Egress Approval**:
A human decision that releases or rejects a Project Egress request held by Project Egress Policy.
_Avoid_: Approval event, policy override

**Project MCP Server Entry Point**:
A named WorkerEntrypoint exported as `ProjectMcpServerEntrypoint` that receives Project identity as props and exposes that Project's MCP server as a fetch destination.
_Avoid_: Global MCP server, MCP route, Iterate MCP server

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

**Public Project Route**:
A Project Route Destination that does not require the caller to be authenticated.
_Avoid_: Anonymous OS2 route, public dashboard route

**Protected Project Route**:
A Project Route Destination that requires the Project Durable Object to authenticate and authorize the caller.
_Avoid_: OS2 app auth, Clerk route

**Project Route Authorization**:
A Project Durable Object-owned policy decision for whether a principal may access a Project Route Destination.
_Avoid_: MCP authorization, app-specific auth method

**Project Access Check**:
A generic Project Durable Object-owned check that decides whether a Clerk principal can access one Project.
_Avoid_: MCP authorization, route-specific permission

**Secret**:
A scoped value in OS2's secrets system that can resolve from a Secret Reference into request material without exposing raw material to Project-owned execution.
_Avoid_: Egress secret, env var, token, managed value

**Iterate-Provided Secret**:
A Global Secret owned by Iterate and made available to Projects under product-defined usage and pricing rules.
_Avoid_: Built-in key, shared key

**Secret Durable Object**:
The lifecycle authority for one Secret.
_Avoid_: Secret table row, secret subclass

**Secret Stack**:
The ordered set of Secrets considered when resolving a Secret Reference in a Project context.
_Avoid_: Secret hierarchy, fallback chain

**Secret Override**:
A more specific Secret in a Secret Stack that takes precedence over a less specific Secret for the same intended use.
_Avoid_: Replacement key, shadow secret

**Secret Reference**:
A placeholder such as `getSecret({ id: "..." })` or `getSecret({ key: "..." })` carried in request material and resolved to a Secret only inside a trusted OS2 boundary.
_Avoid_: Magic string, sentinel string, raw secret

**Secret Locator**:
The identifier inside a Secret Reference that tells OS2 which Secret is being requested.
_Avoid_: Secret selector, secret slug

**Secret Injection**:
The act of resolving Secret References and inserting Secret values into a Project Egress request.
_Avoid_: Env injection, prompt injection

**Derived Secret**:
A Secret whose current value is produced from one or more other Secrets.
_Avoid_: Cached token, generated env var

**Refreshable Secret**:
A Secret that can update its own current value by using its dependencies.
_Avoid_: OAuth-only token, derived token

**Secret Dependency**:
A Secret or value that another Secret needs in order to produce or refresh its own value.
_Avoid_: Parent secret, source env var

**Value Provisioning Request**:
A request for a human or OAuth flow to supply missing Secrets needed to satisfy a Secret Reference.
_Avoid_: Missing secret error, setup prompt

**Project Environment Variable**:
A shell or operating-system process environment variable projected from lower-level OS2 values and Secret References.
_Avoid_: Secret, raw env, nvar

**Codemode Preset**:
A Project-owned named list of Event Inputs that can be appended to a Codemode Session before a Script Execution starts.
_Avoid_: Tool preset, provider config, session template

**Codemode Preset Seed**:
A product-defined preset template copied into a Project as ordinary Codemode Presets when the Project is created.
_Avoid_: Built-in preset, global preset, default preset row

**Codemode Example**:
A global static product-authored template containing a Script and Event Inputs that can prefill a new Codemode Session form.
_Avoid_: Project preset, saved session, fixture

**Codemode Session Creation Form**:
The project-scoped form used to create or attach to a Codemode Session, optionally prefilled from a Codemode Example.
_Avoid_: Example runner, run page, execution form

### Codemode

**Codemode Session**:
A durable codemode execution context initialized for one Project ID and one Event Stream Path, with its own tool provider registry and canonical lifecycle events.
_Avoid_: Runtime, worker, conversation

**Event Stream Path**:
The events app stream address that a Codemode Session reads from and appends to.
_Avoid_: Session ID, Durable Object name

**Codemode Session Name**:
The D1 catalog and Durable Object name used as the route identifier for a Codemode Session.
_Avoid_: Session ID, stream path

**Codemode Session Capability**:
A scoped RPC capability handed to script executors and tool providers so they can interact with a Codemode Session.
_Avoid_: RpcTarget, session stub, callback bundle

**Codemode Session Control Plane**:
The explicit command surface for starting codemode work on a Codemode Session.
_Avoid_: Generic append API, stream API

**Codemode Context**:
The local JavaScript object built from a Codemode Session Capability and passed to codemode scripts or provider implementations.
_Avoid_: ExecutionContext, tools, ctx tools

**Tool Provider**:
Model-visible documentation for one or more Tool Functions available in a Codemode Session.
_Avoid_: Tool, bridge, runtime

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

**Outbound MCP Client Connection**:
An OS2-owned connection to an external MCP server, represented by a Durable Object and usable as a Tool Provider.
_Avoid_: Project MCP Server Connection, project MCP route

**Tool Provider Documentation**:
Serializable model-visible docs, instructions, and optional type definitions for a Tool Provider path.
_Avoid_: Provider descriptor, callable provider

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
- The **Project Listing Projection** is derived query state and should be written by the **Project Durable Object** as part of Project lifecycle commands.
- A **Project Route** includes both the owning **Clerk Organization** slug and the **Project** slug.
- A **Project Slug** is route identity and may change; a **Project ID** is stable identity.
- The **Project Slug** used in the **Project Route** corresponds to the project slug used by the events app.
- Every Project has a **Stable Project Ingress Host** derived from the **Project ID**.
- Every Project has a **Slug Project Ingress Host** derived from the current **Project Slug**.
- A Project may have a **Custom Project Ingress Host**.
- The **Default Project Ingress Host** is the **Custom Project Ingress Host** when one exists; otherwise it is the **Slug Project Ingress Host**.
- The **Stable Project Ingress Host** remains routable even when it is not the **Default Project Ingress Host**.
- A **Project Dashboard Host** may be created from a Project Ingress Host by prefixing it with `iterate.` so a user can reach that Project's OS2 dashboard from a project-owned hostname.
- A **Project MCP Route** identifies exactly one **Project**.
- A **Project MCP Route** is selected by project ingress, typically through a project-owned MCP hostname such as `mcp.<project>.<project-host-base>` or `mcp.<custom-hostname>`.
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
- **Project Egress** is distinct from **Project Ingress**: ingress classifies inbound public requests, while egress governs outbound HTTP/S requests from Project-owned execution.
- The **Project Egress Entry Point** should take only a stable **Project ID** prop in v1, resolve the Project Durable Object by that **Project ID**, and delegate outbound request handling to the Project Durable Object.
- The **ProjectDurableObject** method for Project Egress should be named `egressFetch`.
- Codemode Dynamic Workers should receive a **Dynamic Worker Egress Gateway** that targets the **Project Egress Entry Point** for their Project.
- The **Project Durable Object** is the authority for **Project Egress Policy** and **Project Egress Approval** for one Project.
- A **Project Egress Policy** decision may hold a **Project Egress** request until a **Project Egress Approval** releases or rejects it.
- **Secret** is a separate domain concept from **Project Egress**; Project Egress may perform **Secret Injection**, but a Secret can exist independently of an outbound request.
- Every **Secret** should have a **Secret Durable Object** as its lifecycle authority.
- A **Secret** should have an explicit **Data Scope** such as Global, Clerk Organization, Clerk User, or Project.
- An **Iterate-Provided Secret** is a Global Secret.
- A **Secret Stack** should allow more specific customer-owned Secrets to override **Iterate-Provided Secrets** for the same intended use.
- A **Derived Secret** depends on one or more other **Secrets** and should not obscure those dependencies.
- A **Refreshable Secret** is not a separate kind of domain object from **Secret**; it is a Secret with refresh behavior.
- A **Refreshable Secret** may use **Secret Dependencies** to produce a new current value before participating in **Secret Injection**.
- If required **Secret Dependencies** are missing, OS2 may create a **Value Provisioning Request** rather than treating the request as an unrecoverable error.
- **Secret References** should be safe to expose to Project-owned execution because they do not contain raw Secret values.
- A **Secret Reference** may identify a Secret by stable ID or by key, but the chosen **Secret Locator** rules must be explicit.
- **Project Environment Variables** are out of scope for the current Project Egress and Secret Reference design pass.
- The current scope is resolving **Secret References** into values and substituting those values into HTTP requests.
- A request with one or more **Secret References** should pass through a clear **Secret Injection** pipeline before leaving Project Egress.
- Multiple **Secrets** may participate in one **Project Egress** request when multiple **Secret References** are present.
- V1 **Secret Injection** may be limited to HTTP headers.
- **Project Egress Approval** must not expose raw Secret values after **Secret Injection**.
- The **Project MCP Server Entry Point** class/export name is `ProjectMcpServerEntrypoint`.
- The **Project MCP Server Entry Point** takes only a stable **Project ID** prop in v1 and is the default project-local MCP server fetch destination.
- A **Project MCP Route** is host-routed in v1; every path on that MCP hostname is delegated to the **Project MCP Server Entry Point**.
- The **Project MCP Server Entry Point** owns MCP protocol paths, OAuth protected-resource metadata paths, browser instructions, and 404s for unsupported paths on that MCP hostname.
- A browser request to a **Project MCP Route** that is not an MCP client connection may return a static HTML instructions page.
- The **Project MCP Server Connection** Durable Object class/catalog name is `ProjectMcpServerConnection`.
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
- The **Project Durable Object** is responsible for authentication and authorization after a request becomes **Project Ingress**.
- The **Project Durable Object** is the authority for desired project-owned ingress state.
- Global **Ingress Routing Rules** for project-owned hostnames are **Project Projections** written for fast indexed lookup by the OS2 Worker.
- V1 may synchronously write **Project Projections** from **Project Control Surface** commands even though Durable Object SQLite and D1 are not one atomic transaction.
- **Project Ingress** may include **Public Project Routes** and **Protected Project Routes** for the same **Project-Owned Hostname**.
- A **Project-Owned Hostname** may be a **Slug Project Ingress Host**, a **Stable Project Ingress Host**, or a **Custom Project Ingress Host**.
- A **Project Durable Object** owns a project-local **Ingress Route Table** that maps **Project Ingress** to **Project Route Destinations**.
- A **Project Route Destination** is a kind of **Fetch Destination**.
- A **Fetch Destination** may be backed by OS2-packaged source code, runtime-loaded code, or another project-owned capability.
- Global and project-local ingress use the same **Ingress Route Table** concept even though their first concrete destinations differ.
- Projects are born with **Slug Project Ingress Host** and **Stable Project Ingress Host** routes.
- Projects are born with MCP hostname routes for their slug and stable hosts, such as `mcp.<project-slug>.iterate.app` and `mcp.<project-id>.iterate.app`, that resolve to the **Project MCP Server Entry Point**.
- Adding a **Custom Project Ingress Host** should also add its matching MCP hostname route, such as `mcp.<custom-hostname>`.
- Slug changes should update slug-derived ingress routes at the same time; alias lifecycle is future work.
- A **Codemode Preset** belongs to exactly one **Project**.
- A **Codemode Preset** stores Event Inputs without interpreting their event types.
- A **Codemode Preset Seed** is copied into ordinary Project-owned **Codemode Presets** when a **Project** is created.
- After creation, seeded **Codemode Presets** behave like any other **Codemode Preset** for that **Project**.
- Applying a **Codemode Preset** appends each stored Event Input to the Codemode Session's Event Stream Path.
- A **Codemode Example** is global static product data, not owned by a **Project**.
- **Codemode Examples** are listed inside a **Project Route** because running an example requires a **Project**.
- Selecting a **Codemode Example** pre-populates the **Codemode Session Creation Form**.
- Editing a pre-populated form from a **Codemode Example** does not mutate the **Codemode Example**.
- Browser ad-hoc codemode runs are created through **Codemode Sessions**, not through a separate run-code concept.
- The **Codemode Session Control Plane** is domain-driven: callers provide **Scripts**, Event Inputs, Tool Providers, and an optional **Event Stream Path** rather than constructing the complete wire event sequence themselves.
- The **Codemode Session Control Plane** compiles a requested **Script Execution** into a script-execution-requested Event Input internally.
- When a **Codemode Example**, **Codemode Preset**, custom Event Inputs, and a **Script** are combined, OS2 appends example Event Inputs, preset Event Inputs, custom Event Inputs, then the script-execution-requested event.
- Browser UI creates **Codemode Sessions** through a session-first command where the **Script** is optional.
- Project MCP server `run_code` starts a **Script Execution** and therefore requires a **Script**.
- Browser session creation and Project MCP server `run_code` share the same internal attach-or-create and stream append behavior.
- A **Project Route** resolves its **Project Slug** to the stable **Project ID** before initializing a **Codemode Session**.
- A **Project MCP Route** resolves to the stable **Project ID** through project ingress before initializing a **Codemode Session**.
- A **Clerk User** acts through their **Active Organization** when managing **Projects**.
- A signed-in **Clerk User** without an **Active Organization** must create or select a **Clerk Organization** before using OS2.
- A remote MCP client calls OS2 with a **Clerk OAuth Token**, not a Clerk session token.
- OS2 accepts Clerk's OAuth token contract for MCP; JWT token format is the preferred Clerk environment setting, not the domain boundary.
- The browser UI explicitly creates and selects **Codemode Sessions** for a **Project**.
- Browser oRPC calls identify the **Project** through the **Project Route** and frontend route context, then pass the stable **Project ID** to codemode.
- Browser oRPC may pass an **Event Stream Path** when creating a **Codemode Session**; if it does not, OS2 generates one for the Project.
- The **Codemode Session Creation Form** may include an optional **Event Stream Path** so users can attach the codemode processor to an existing stream.
- Creating a **Codemode Session** is attach-or-create for the pair of **Project ID** and **Event Stream Path**.
- A **Project MCP Server Connection** already has an **Event Stream Path**; when it runs codemode, the **Codemode Session** uses that same Event Stream Path.
- Project MCP server `run_code` may include Event Inputs, such as Tool Provider registration events, which are appended to the **Codemode Session** before the **Script Execution** starts.
- An **Outbound MCP Client Connection** is a Tool Provider; it is unrelated to **Project MCP Server Connection** identity.
- A **Codemode Session** is initialized with exactly one stable **Project ID** and exactly one **Event Stream Path**.
- An **Event Stream Path** may exist before a **Codemode Session** is attached to it.
- For any given pair of **Project ID** and **Event Stream Path**, there is at most one **Codemode Session**.
- The **Project ID** and **Event Stream Path** together are the identity of a **Codemode Session**; the Durable Object name is derived from those init params.
- A **Codemode Session Name** is the route identifier for a listed **Codemode Session**.
- A **Codemode Session Name** is not the domain identity of the **Codemode Session**; domain identity remains **Project ID** plus **Event Stream Path**.
- The **Codemode Session Control Plane** exposes explicit commands, not a generic append method.
- The **Codemode Session Control Plane** commands append codemode request events to the **Event Stream Path**.
- Low-level stream operations exposed to scripts are ordinary path-addressed **Tool Functions**.
- A **Codemode Session** starts a **Script** by appending a script-execution-requested event and returning that committed event immediately.
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
- Function Call completion events include the completed function path for readable event feeds and debugging.
- A **Tool Provider** provides one or more **Tool Functions**.
- A **Leaf Tool Function** is a **Tool Function** whose remaining path is empty after provider resolution.
- A **Provider Bridge** adapts an external system into Tool Provider documentation plus a **Tool Function Implementation**.
- Codemode calls **Tool Functions** by appending function-call-requested events and waiting for matching function-call-completed events.
- `ctx.<provider>.<toolFunction>(payload)` calls a **Tool Function**.
- Built-in stream operations, such as append, are ordinary **Tool Functions** under paths like `ctx.streams.append(...)`.
- **Tool Provider** registration is primarily documentation; runtime callability may be supplied by processor helpers but is not the primary meaning of registration.

## Example Dialogue

> **Dev:** "When a script runs `ctx.linear.createIssue(...)`, is that a tool execution?"
> **Domain expert:** "It is a **Tool Function Call**. The **Codemode Session** calls the **Tool Function**, and the **Tool Provider** executes it."

> **Dev:** "Is `ctx.streams.append(...)` also a Tool Function Call?"
> **Domain expert:** "Yes. Stream append is just another path-addressed function; the runtime appends function-call-requested and waits for the corresponding function-call-completed event."

> **Dev:** "If Provider B calls Provider A while executing a Tool Function, is that a private provider call?"
> **Domain expert:** "No. Provider B uses the **Codemode Session Capability** to make another **Tool Function Call**, so the **Codemode Session** records the same lifecycle events as any other Tool Function Call."

> **Dev:** "Does a Function Call dispatch the Provider directly?"
> **Domain expert:** "No. A **Tool Function Call** is event-driven: append the requested event, then wait for the matching completed event."

> **Dev:** "How does codemode learn provider types?"
> **Domain expert:** "Tool Provider registration carries documentation and optional type definitions directly."

> **Dev:** "Does creating a **Codemode Session** always create a new stream?"
> **Domain expert:** "No. A **Codemode Session** is attached to an **Event Stream Path**, which may be newly chosen by OS2 or may already exist."

> **Dev:** "What is the ID of a **Codemode Session**?"
> **Domain expert:** "Use the pair of **Project ID** and **Event Stream Path**. The Durable Object name is derived from those init params."

> **Dev:** "Should we store an execution ID when a script starts?"
> **Domain expert:** "Yes. Store a **Script Execution ID** on the requested event and copy it to related events. It may be offset-derived if the caller can know the offset before append; otherwise the caller mints it before append."

> **Dev:** "Should starting a Script stream all results back from the command?"
> **Domain expert:** "No. Starting a **Script Execution** returns the committed request event immediately. Output is read from the **Event Stream Path**."

> **Dev:** "Is there a separate Project Run Code Session concept above Codemode Session?"
> **Domain expert:** "No. The concept is **Codemode Session**. Browser UI creates explicit Codemode Sessions with their own Event Stream Paths; Project MCP server connections reuse the MCP connection's existing Event Stream Path."

> **Dev:** "Should MCP `run_code` take a project selector?"
> **Domain expert:** "No. MCP is project-scoped: the **Project MCP Route** identifies the **Project**. Browser oRPC gets the project from the **Project Route** and resolves the stable **Project ID**."

> **Dev:** "Does a Codemode Session init with the project slug?"
> **Domain expert:** "No. Routes use **Project Slug**, but Codemode Session init uses the stable **Project ID** resolved from that route."

> **Dev:** "Who chooses the Event Stream Path for browser-created Codemode Sessions?"
> **Domain expert:** "Browser oRPC may pass one to attach to an existing stream; otherwise OS2 generates an Event Stream Path for the Project."

> **Dev:** "What if a Codemode Session already exists for that Project ID and Event Stream Path?"
> **Domain expert:** "Treat creation as attach-or-create. Return the existing Codemode Session for that identity, or initialize it if it does not exist."

> **Dev:** "Is an MCP Tool Provider the same thing as OS2's MCP server connection?"
> **Domain expert:** "No. An **Outbound MCP Client Connection** can be a Tool Provider. A **Project MCP Server Connection** is an external client connected to OS2's project-scoped MCP server."

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
> **Domain expert:** "No. The MCP server requires a valid **Clerk OAuth Token**. JWT is the preferred Clerk token format for cheaper verification, but OS2 should not model MCP auth as JWT-only."

> **Dev:** "Should a request for `mycustomer.com` hit the OS2 App auth middleware before project routing?"
> **Domain expert:** "No. The OS2 Worker first classifies the **Ingress Hostname**. If it is a **Project-Owned Hostname**, the request becomes **Project Ingress** and the **Project Durable Object** decides whether the matching route is public or protected."

> **Dev:** "Can a Project serve the apex of a custom hostname as a public website?"
> **Domain expert:** "Yes. The custom hostname is a **Project-Owned Hostname**, and the Project Durable Object may map its apex route to a **Public Project Route**."

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

> **Dev:** "Does `mycustomer.com/mcp` route to the Project MCP server?"
> **Domain expert:** "No. MCP uses a project-local ingress route such as `mcp.mycustomer.com`; the MCP server is selected by the route, not by hard-coding a `/mcp` path on the custom hostname apex."

> **Dev:** "Does the Project Durable Object need to understand MCP protocol paths?"
> **Domain expert:** "No. It routes the MCP hostname to the **Project MCP Server Entry Point**. That entry point owns protocol paths, OAuth metadata, browser setup instructions, and unsupported-path responses."

> **Dev:** "Should Project Durable Object expose `authorizeMcpServerConnection(...)`?"
> **Domain expert:** "No. MCP is one Project Route Destination among many. Future authorization should be generic **Project Route Authorization**, not a method per destination type."

> **Dev:** "How should `ProjectMcpServerEntrypoint` check access in v1 after verifying Clerk OAuth?"
> **Domain expert:** "Call a generic **Project Access Check** on the Project Durable Object. The Project Durable Object can implement that check by reading the app-level D1 Project projection for the caller's Clerk Organization."

> **Dev:** "What should a global ingress rule point at for project traffic?"
> **Domain expert:** "Point it at `ProjectIngressEntrypoint`, the **Project Ingress Entry Point**, with the stable **Project ID** in props. That entry point resolves the Project Durable Object and delegates to its ingress RPC."

> **Dev:** "Is Project Egress just another Project Ingress route?"
> **Domain expert:** "No. **Project Ingress** handles inbound public requests to Project-owned hostnames; **Project Egress** handles outbound HTTP/S requests from Project-owned execution."

> **Dev:** "Should secrets be called Egress Secrets?"
> **Domain expert:** "No. A **Secret** is independent of egress. **Project Egress** may use **Secret Injection**, but secrets also cover credentials, refresh tokens, derived tokens, and future environment roles."

> **Dev:** "Are Project Environment Variables part of this design?"
> **Domain expert:** "No. This pass is about resolving **Secret References** into values and substituting them into HTTP requests. Environment variables are a later projection."

> **Dev:** "If Waitrose gives us a 15-minute access token from a username and password, is that different from OAuth?"
> **Domain expert:** "No. It is a **Refreshable Secret**: it can use **Secret Dependencies** to refresh its current value before it injects into **Project Egress**."

> **Dev:** "What happens if the Waitrose username and password are missing?"
> **Domain expert:** "OS2 should create a **Value Provisioning Request** for the missing dependencies, then retry or resume once the required **Secrets** exist."

> **Dev:** "If Iterate provides an OpenAI key, can a customer bring their own key for the same role?"
> **Domain expert:** "Yes. The customer-owned Secret should be a **Secret Override** in the **Secret Stack**, taking precedence over the **Iterate-Provided Secret** for that Project context."

> **Dev:** "Can `ProjectIngressEntrypoint` props identify a Project by slug?"
> **Domain expert:** "Not in v1. Slugs are mutable and belong to control-plane routing. Hot ingress uses the stable **Project ID** already resolved by the exact-host route lookup."

> **Dev:** "Which public host should OS2 use when linking to a Project?"
> **Domain expert:** "Use the **Default Project Ingress Host**: the custom host if present, otherwise the slug platform host. The stable ID platform host remains routable but is not the ordinary user-facing URL."

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
- "describe callable" added a second Tool Provider execution path. Resolved: Tool Provider registration carries docs and type definitions directly.
- "ExecutionContext" conflicts with Cloudflare's Worker `ExecutionContext`. Resolved: use **Codemode Context** for codemode userland.
- "session id" and "stream path" were conflated. Resolved: **Project ID** plus **Event Stream Path** is the **Codemode Session** identity.
- "app" can mean the OS2 product or a managed project surface. Resolved: use **OS2 App** for this dashboard and **Project** for the managed app surface.
- "personal organization" is misleading because Clerk treats personal accounts separately from organizations. Resolved: use **Personal Account** for Clerk's non-organization user context.
- "MCP JWT" is too narrow for Clerk OAuth Applications. Resolved: use **Clerk OAuth Token** for MCP bearer tokens, regardless of Clerk's token format setting.
- "project URL" was ambiguous between stable IDs and slugs. Resolved: use **Project Route** for the user-facing organization-slug/project-slug URL.
- "MCP" can mean OS2 as an MCP server or OS2 as a client of another MCP server. Resolved: use **Project MCP Server Connection** for external clients connected to OS2, and **Outbound MCP Client Connection** for OS2 connecting to external MCP servers as Tool Providers.
- "`IterateMcpServer`" names the product, not the domain concept. Resolved: use `ProjectMcpServerConnection` for the Durable Object class/catalog name.
- "Project Run Code Session" added an unnecessary layer. Resolved: use **Codemode Session** directly.
- "route" can mean a TanStack route, a Worker hostname match, or a Project-local destination. Resolved: use **Ingress Hostname** for the Worker-level host classifier, **Project Route** for the authenticated OS2 dashboard URL, and **Project Route Destination** for a Project Durable Object target.
- "authentication" can happen at the OS2 App layer or inside Project Ingress. Resolved: the OS2 App authenticates dashboard/control-plane routes; the **Project Durable Object** authenticates **Project Ingress**.
- "fetch callable" overlaps with generic JavaScript functions and Tool Provider callables. Resolved: use **Fetch Destination** for an ingress target that can receive an HTTP request.
- "context request" made codemode look like a generic invocation broker. Resolved: use **Function Call** only for path-addressed codemode functions, and keep **Tool Provider** registration as model-visible information first.
- "Project DO worker" conflicted with loopback props. Resolved: use **Project Ingress Entry Point** and **Project MCP Server Entry Point** as same-worker loopback targets for now, while the **Project Durable Object** remains exported by the main OS2 Worker.
- "project identity" in entrypoint props could mean slug or ID. Resolved: v1 ingress entrypoints accept **Project ID** only; **Project Slug** resolution happens in control-plane routes or route-registry writes.
- "canonical project host" could mean the stable ID host or the user-facing default host. Resolved: use **Stable Project Ingress Host** for the ID-derived host and **Default Project Ingress Host** for generated public URLs.
- "initialize project" conflates infrastructure lifecycle with domain creation. Resolved: use **Create Project Command** for the Project Durable Object domain command.
- "scope" could be hidden inside payload JSON. Resolved: OS2 persisted records should expose their **Data Scope** through queryable columns.
- "source of truth" for project ingress could mean the global D1 lookup table. Resolved: the **Project Durable Object** owns desired ingress state; D1 rows are **Project Projections**.
- "project table" could mean app-level listing state or mixin-owned Durable Object tracking. Resolved: use **Project Listing Projection** for the app D1 row and **Durable Object Catalog** for shared DO tracking tables.
- "MCP authorization" could become a one-off Project Durable Object method. Resolved: avoid MCP-specific Project DO auth methods; model future auth as generic **Project Route Authorization**.
- "project access" and "route authorization" are different depths of policy. Resolved: v1 can use a generic **Project Access Check**; richer destination-specific policy belongs to future **Project Route Authorization**.
- "egress proxy", "egress gateway", and **Project Ingress** were used around outbound traffic. Resolved: use **Project Egress** for outbound HTTP/S traffic from Project-owned execution and reserve **Project Ingress** for inbound public requests.
- "magic string" and "sentinel string" were used for secret placeholders. Resolved: use **Secret Reference**, with `getSecret(...)` as the placeholder shape.
- "egress secret" conflated two domains. Resolved: use **Secret** for sensitive values and **Secret Injection** for the egress-time act of inserting them into outbound requests.
- "nvar" / environment variable was used near Secret. Resolved: use **Project Environment Variable** for named runtime configuration values, which may contain **Secret References** but are not themselves **Secrets**.
- "secret locator" is unresolved between stable ID, key, slug, or scoped name. Keep the term **Secret Locator** until the identity rules are settled.
- "global key" was used for Iterate-owned credentials. Resolved: use **Iterate-Provided Secret** for a Global Secret made available to Projects under product-defined pricing and usage rules.
- "override" and "stack" need precise ordering. Partially resolved: use **Secret Stack** and **Secret Override**; exact precedence across Project, Clerk Organization, Clerk User, and Global remains open.
- "derived secret" and "refreshable secret" may be implementation variants of one concept. Partially resolved: use **Refreshable Secret** when the important behavior is updating the current value through **Secret Dependencies**.
- "non-secret secret" was awkward but the broader umbrella term made the model less clear. Resolved: use **Secret** for values in OS2's secrets system, even when an individual supporting value such as an OAuth client ID is not itself highly sensitive.
