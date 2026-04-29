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

**Clerk User**:
A person authenticated by Clerk who acts inside a Clerk Organization.
_Avoid_: Member, account

**Project**:
An OS2-managed app surface owned by exactly one Clerk Organization.
_Avoid_: App, site, workspace

### Codemode

**Codemode Session**:
A durable codemode run that owns the event stream, tool provider registry, and canonical lifecycle events.
_Avoid_: Runtime, worker, conversation

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
User-authored TypeScript or JavaScript code executed by codemode with a Codemode Context.
_Avoid_: Function, tool, provider

**Provider Bridge**:
An adapter that exposes an external system, such as OpenAPI or MCP, as a Tool Provider.
_Avoid_: Tool provider descriptor, session capability

**Provider Descriptor**:
A serializable description of how to resolve a Tool Provider at runtime.
_Avoid_: Provider, bridge

**Tool Provider Descriptor**:
The current TypeScript schema name for Provider Descriptor values passed through contracts.
_Avoid_: CallableToolProvider

## Relationships

- The **OS2 App** has no public product pages; unauthenticated users are sent to Clerk sign-in.
- A **Clerk Organization** owns zero or more **Projects**.
- A **Project** belongs to exactly one **Clerk Organization**.
- A **Clerk User** acts through their active **Clerk Organization** when managing **Projects**.
- A **Codemode Session** exposes a **Codemode Session Capability**.
- A **Codemode Context** is built locally from a **Codemode Session Capability**.
- A **Script** receives a **Codemode Context**.
- A **Tool Provider** may receive a **Codemode Session Capability** when executing a **Tool Function**.
- A **Tool Provider** provides one or more **Tool Functions**.
- A **Leaf Tool Function** is a **Tool Function** whose remaining path is empty after provider resolution.
- A **Provider Bridge** adapts an external system into a **Tool Provider**.
- A **Provider Descriptor** is stored or transmitted; a **Tool Provider** is the live runtime implementation.
- Codemode calls **Tool Functions** with `callToolFunction(...)`; **Tool Providers** execute Tool Functions with `executeToolFunction(...)`.
- Tool Provider Descriptors name `executeToolFunction` and `describeToolFunctions` callables.
- `ctx.<provider>.<toolFunction>(payload)` calls a **Tool Function**.
- `ctx.codemode.*` uses the **Codemode Control Surface** and does not create Tool Function lifecycle events.

## Example Dialogue

> **Dev:** "When a script runs `ctx.linear.createIssue(...)`, is that a tool execution?"
> **Domain expert:** "It is a **Tool Function Call**. The **Codemode Session** calls the **Tool Function**, and the **Tool Provider** executes it."

> **Dev:** "Is `ctx.codemode.append(...)` also a Tool Function Call?"
> **Domain expert:** "No. It uses the **Codemode Control Surface** to append an event directly, so it does not create Tool Function lifecycle events."

> **Dev:** "Can someone open an OS2 project page without signing in?"
> **Domain expert:** "No. The **OS2 App** is authenticated, and every **Project** is managed through the user's active **Clerk Organization**."

## Flagged Ambiguities

- "function" can mean a JavaScript function, a Tool Function, or a session control operation. Resolved: use **Tool Function** only for functions provided by Tool Providers.
- "execute" and "call" were used interchangeably. Resolved: codemode **calls** Tool Functions; Tool Providers **execute** Tool Functions.
- "tools" was used for both the whole context and provider functions. Resolved: the local object is **Codemode Context**; provider callables are **Tool Functions**.
- "ExecutionContext" conflicts with Cloudflare's Worker `ExecutionContext`. Resolved: use **Codemode Context** for codemode userland.
- "app" can mean the OS2 product or a managed project surface. Resolved: use **OS2 App** for this dashboard and **Project** for the managed app surface.
