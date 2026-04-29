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

**Project ID**:
The stable OS2 identifier for a Project.
_Avoid_: Project slug, Project Route

**Project Slug**:
The mutable slug used in Project Routes and mirrored into the events app project slug.
_Avoid_: Project ID

**Project Route**:
The organization-scoped URL for a Project, identified by Clerk Organization slug and Project slug.
_Avoid_: Global project URL, project ID URL

**Project MCP Endpoint**:
The project-scoped MCP endpoint for one Project.
_Avoid_: Global MCP server, MCP project selector

**Codemode Preset**:
A Project-owned named list of Event Inputs that can be appended to a Codemode Session before a Script Execution starts.
_Avoid_: Tool preset, provider config, session template

### Codemode

**Codemode Session**:
A durable codemode execution context initialized for one Project ID and one Event Stream Path, with its own tool provider registry and canonical lifecycle events.
_Avoid_: Runtime, worker, conversation

**Event Stream Path**:
The events app stream address that a Codemode Session reads from and appends to.
_Avoid_: Session ID, Durable Object name

**Codemode Session Capability**:
A scoped RPC capability handed to script executors and tool providers so they can interact with a Codemode Session.
_Avoid_: RpcTarget, session stub, callback bundle

**Codemode Context**:
The local JavaScript object built from a Codemode Session Capability and passed to codemode scripts or provider implementations.
_Avoid_: ExecutionContext, tools, ctx tools

**Codemode Control Surface**:
The built-in codemode operations grouped under `ctx.codemode`, such as appending events or checking cancellation state.
_Avoid_: Tools, tool provider

**Tool Provider**:
An implementation that provides one or more tool functions to a Codemode Session.
_Avoid_: Tool, bridge, runtime

**Tool Function**:
A callable function provided by a Tool Provider and addressed by a path on the Codemode Context.
_Avoid_: Tool, session function, script

**Leaf Tool Function**:
A Tool Function whose provider path is directly callable without a nested function name.
_Avoid_: Root tool, direct provider

**Tool Function Call**:
A request from codemode to call a Tool Function.
_Avoid_: Execution, append, script execution

**Script**:
User-authored TypeScript or JavaScript code that can be run by codemode.
_Avoid_: Function, tool, provider, execution

**Script Execution**:
One attempt to run a Script on a Codemode Session.
_Avoid_: Script, execution ID, script ID

**Provider Bridge**:
An adapter that exposes an external system, such as OpenAPI or MCP, as a Tool Provider.
_Avoid_: Tool provider descriptor, session capability

**Inbound MCP Session**:
An external MCP client connection into OS2's project-scoped MCP server.
_Avoid_: MCP client provider, outbound MCP connection

**Outbound MCP Client Connection**:
An OS2-owned connection to an external MCP server, represented by a Durable Object and usable as a Tool Provider.
_Avoid_: Inbound MCP session, project MCP endpoint

**Provider Descriptor**:
A serializable description of how to resolve a Tool Provider at runtime.
_Avoid_: Provider, bridge

**Self-Callable Provider Descriptor**:
A Provider Descriptor minted by an app that points back to a named Worker entrypoint on that same app worker.
_Avoid_: Loopback binding, local export

**Tool Provider Descriptor**:
The current TypeScript schema name for Provider Descriptor values passed through contracts.
_Avoid_: CallableToolProvider

## Relationships

- The **OS2 App** has no public product pages; unauthenticated users are sent to Clerk sign-in.
- The **OS2 App** hides **Personal Account** mode and requires a **Clerk Organization** context.
- A **Clerk Organization** owns zero or more **Projects**.
- A **Project** belongs to exactly one **Clerk Organization**.
- A **Project Route** includes both the owning **Clerk Organization** slug and the **Project** slug.
- A **Project Slug** is route identity and may change; a **Project ID** is stable identity.
- The **Project Slug** used in the **Project Route** corresponds to the project slug used by the events app.
- A **Project MCP Endpoint** identifies exactly one **Project**.
- A **Project MCP Endpoint** is served at `https://<project>.<project-host-base>/mcp`.
- OS2 does not expose a normal global MCP endpoint; `/mcp` is only valid on a project hostname.
- A **Codemode Preset** belongs to exactly one **Project**.
- A **Codemode Preset** stores Event Inputs without interpreting their event types.
- Applying a **Codemode Preset** appends each stored Event Input to the Codemode Session's Event Stream Path.
- A **Project Route** or **Project MCP Endpoint** resolves its **Project Slug** to the stable **Project ID** before initializing a **Codemode Session**.
- A **Clerk User** acts through their **Active Organization** when managing **Projects**.
- A signed-in **Clerk User** without an **Active Organization** must create or select a **Clerk Organization** before using OS2.
- A remote MCP client calls OS2 with a **Clerk OAuth Token**, not a Clerk session token.
- OS2 accepts Clerk's OAuth token contract for MCP; JWT token format is the preferred Clerk environment setting, not the domain boundary.
- The browser UI explicitly creates and selects **Codemode Sessions** for a **Project**.
- Browser oRPC calls identify the **Project** through the **Project Route** and frontend route context, then pass the stable **Project ID** to codemode.
- Browser oRPC may pass an **Event Stream Path** when creating a **Codemode Session**; if it does not, OS2 generates one for the Project.
- Creating a **Codemode Session** is attach-or-create for the pair of **Project ID** and **Event Stream Path**.
- An **Inbound MCP Session** already has an **Event Stream Path**; when it runs codemode, the **Codemode Session** uses that same Event Stream Path.
- Inbound MCP `run_code` may include Event Inputs, such as Tool Provider registration events, which are appended to the **Codemode Session** before the **Script Execution** starts.
- An **Outbound MCP Client Connection** is a Tool Provider; it is unrelated to **Inbound MCP Session** identity.
- A **Codemode Session** is initialized with exactly one stable **Project ID** and exactly one **Event Stream Path**.
- An **Event Stream Path** may exist before a **Codemode Session** is attached to it.
- For any given pair of **Project ID** and **Event Stream Path**, there is at most one **Codemode Session**.
- The **Project ID** and **Event Stream Path** together are the identity of a **Codemode Session**; the Durable Object name is derived from those init params.
- For now, a **Codemode Session** appends to its **Event Stream Path** by calling the events service directly.
- A **Codemode Session** starts a **Script** by appending a script-execution-requested event and returning that committed event immediately.
- Reading Script Execution output is a subscription to the **Event Stream Path**, not part of the start command.
- A **Codemode Session** owns the Tool Provider registry for its **Event Stream Path**.
- One-shot adapters may register Tool Providers immediately before starting a **Script Execution**.
- A **Codemode Session** exposes a **Codemode Session Capability**.
- A **Codemode Context** is built locally from a **Codemode Session Capability**.
- A **Script** receives a **Codemode Context**.
- A **Script Execution** is identified by the script-execution-requested event on the **Event Stream Path**.
- Events belonging to a **Script Execution** refer to the requested event by `scriptExecutionRequestedOffset`.
- A **Tool Provider** may receive a **Codemode Session Capability** when executing a **Tool Function**.
- A **Tool Provider** may use that **Codemode Session Capability** to make another **Tool Function Call**.
- Provider-to-provider calls are still mediated by the **Codemode Session** and produce normal Tool Function lifecycle events.
- A **Tool Provider** provides one or more **Tool Functions**.
- A **Leaf Tool Function** is a **Tool Function** whose remaining path is empty after provider resolution.
- A **Provider Bridge** adapts an external system into a **Tool Provider**.
- A **Provider Descriptor** is stored or transmitted; a **Tool Provider** is the live runtime implementation.
- A **Self-Callable Provider Descriptor** survives crossing into another worker because it names the source worker script and entrypoint, not the currently dispatching worker's exports.
- A Provider Descriptor stored on a **Codemode Session** must resolve from the Codemode Session worker's dispatch context.
- Codemode calls **Tool Functions** with `callToolFunction(...)`; **Tool Providers** execute Tool Functions with `executeToolFunction(...)`.
- Tool Provider Descriptors name `executeToolFunction` and `describeToolFunctions` callables.
- `ctx.<provider>.<toolFunction>(payload)` calls a **Tool Function**.
- `ctx.codemode.*` uses the **Codemode Control Surface** and does not create Tool Function lifecycle events.

## Example Dialogue

> **Dev:** "When a script runs `ctx.linear.createIssue(...)`, is that a tool execution?"
> **Domain expert:** "It is a **Tool Function Call**. The **Codemode Session** calls the **Tool Function**, and the **Tool Provider** executes it."

> **Dev:** "Is `ctx.codemode.append(...)` also a Tool Function Call?"
> **Domain expert:** "No. It uses the **Codemode Control Surface** to append an event directly, so it does not create Tool Function lifecycle events."

> **Dev:** "If Provider B calls Provider A while executing a Tool Function, is that a private provider call?"
> **Domain expert:** "No. Provider B uses the **Codemode Session Capability** to make another **Tool Function Call**, so the **Codemode Session** records the same lifecycle events as any other Tool Function Call."

> **Dev:** "Does creating a **Codemode Session** always create a new stream?"
> **Domain expert:** "No. A **Codemode Session** is attached to an **Event Stream Path**, which may be newly chosen by OS2 or may already exist."

> **Dev:** "What is the ID of a **Codemode Session**?"
> **Domain expert:** "Use the pair of **Project ID** and **Event Stream Path**. The Durable Object name is derived from those init params."

> **Dev:** "Should we store an execution ID when a script starts?"
> **Domain expert:** "Not yet. A **Script Execution** is the script-execution-requested event; use its offset for correlation."

> **Dev:** "Should starting a Script stream all results back from the command?"
> **Domain expert:** "No. Starting a **Script Execution** returns the committed request event immediately. Output is read from the **Event Stream Path**."

> **Dev:** "Is there a separate Project Run Code Session concept above Codemode Session?"
> **Domain expert:** "No. The concept is **Codemode Session**. Browser UI creates explicit Codemode Sessions with their own Event Stream Paths; inbound MCP reuses the MCP session's existing Event Stream Path."

> **Dev:** "Should MCP `run_code` take a project selector?"
> **Domain expert:** "No. MCP is project-scoped: the **Project MCP Endpoint** identifies the **Project**. Browser oRPC gets the project from the **Project Route** and resolves the stable **Project ID**."

> **Dev:** "Does a Codemode Session init with the project slug?"
> **Domain expert:** "No. Routes use **Project Slug**, but Codemode Session init uses the stable **Project ID** resolved from that route."

> **Dev:** "Who chooses the Event Stream Path for browser-created Codemode Sessions?"
> **Domain expert:** "Browser oRPC may pass one to attach to an existing stream; otherwise OS2 generates an Event Stream Path for the Project."

> **Dev:** "What if a Codemode Session already exists for that Project ID and Event Stream Path?"
> **Domain expert:** "Treat creation as attach-or-create. Return the existing Codemode Session for that identity, or initialize it if it does not exist."

> **Dev:** "Is an MCP Tool Provider the same thing as OS2's MCP server session?"
> **Domain expert:** "No. An **Outbound MCP Client Connection** can be a Tool Provider. An **Inbound MCP Session** is an external client connected to OS2's MCP server."

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

## Flagged Ambiguities

- "function" can mean a JavaScript function, a Tool Function, or a session control operation. Resolved: use **Tool Function** only for functions provided by Tool Providers.
- "script" and "execution" were conflated. Resolved: **Script** is code; **Script Execution** is one attempt to run it.
- "execute" and "call" were used interchangeably. Resolved: codemode **calls** Tool Functions; Tool Providers **execute** Tool Functions.
- "tools" was used for both the whole context and provider functions. Resolved: the local object is **Codemode Context**; provider callables are **Tool Functions**.
- "ExecutionContext" conflicts with Cloudflare's Worker `ExecutionContext`. Resolved: use **Codemode Context** for codemode userland.
- "session id" and "stream path" were conflated. Resolved: **Project ID** plus **Event Stream Path** is the **Codemode Session** identity.
- "app" can mean the OS2 product or a managed project surface. Resolved: use **OS2 App** for this dashboard and **Project** for the managed app surface.
- "personal organization" is misleading because Clerk treats personal accounts separately from organizations. Resolved: use **Personal Account** for Clerk's non-organization user context.
- "MCP JWT" is too narrow for Clerk OAuth Applications. Resolved: use **Clerk OAuth Token** for MCP bearer tokens, regardless of Clerk's token format setting.
- "project URL" was ambiguous between stable IDs and slugs. Resolved: use **Project Route** for the user-facing organization-slug/project-slug URL.
- "MCP" can mean OS2 as an MCP server or OS2 as a client of another MCP server. Resolved: use **Inbound MCP Session** for external clients connected to OS2, and **Outbound MCP Client Connection** for OS2 connecting to external MCP servers as Tool Providers.
- "Project Run Code Session" added an unnecessary layer. Resolved: use **Codemode Session** directly.
