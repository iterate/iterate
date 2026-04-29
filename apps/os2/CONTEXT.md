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

**Project**:
An OS2-managed app surface owned by exactly one Clerk Organization.
_Avoid_: App, site, workspace

### Codemode

**Codemode Session**:
A durable codemode run attached to exactly one Event Stream Path, with its own tool provider registry and canonical lifecycle events.
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
- A **Clerk User** acts through their **Active Organization** when managing **Projects**.
- A signed-in **Clerk User** without an **Active Organization** must create or select a **Clerk Organization** before using OS2.
- A **Codemode Session** is initialized with exactly one **Event Stream Path**.
- An **Event Stream Path** may exist before a **Codemode Session** is attached to it.
- For any given **Event Stream Path**, there is at most one **Codemode Session**.
- The **Event Stream Path** is the public identity of a **Codemode Session**; the Durable Object name is derived infrastructure identity.
- For now, a **Codemode Session** appends to its **Event Stream Path** by calling the events service directly.
- A **Codemode Session** starts a **Script** by appending a script-execution-requested event and returning that committed event immediately.
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
> **Domain expert:** "Use the **Event Stream Path**. The Durable Object name is just how Cloudflare routes the session internally."

> **Dev:** "Should we store an execution ID when a script starts?"
> **Domain expert:** "Not yet. A **Script Execution** is the script-execution-requested event; use its offset for correlation."

> **Dev:** "Can someone open an OS2 project page without signing in?"
> **Domain expert:** "No. The **OS2 App** is authenticated, and every **Project** is managed through the user's active **Clerk Organization**."

> **Dev:** "Can a **Personal Account** own a **Project**?"
> **Domain expert:** "No. OS2 only lets a **Clerk Organization** own **Projects**."

> **Dev:** "What should OS2 show after sign-in if Clerk has no **Active Organization**?"
> **Domain expert:** "Show Clerk's organization selection or creation flow before rendering the **OS2 App**."

## Flagged Ambiguities

- "function" can mean a JavaScript function, a Tool Function, or a session control operation. Resolved: use **Tool Function** only for functions provided by Tool Providers.
- "script" and "execution" were conflated. Resolved: **Script** is code; **Script Execution** is one attempt to run it.
- "execute" and "call" were used interchangeably. Resolved: codemode **calls** Tool Functions; Tool Providers **execute** Tool Functions.
- "tools" was used for both the whole context and provider functions. Resolved: the local object is **Codemode Context**; provider callables are **Tool Functions**.
- "ExecutionContext" conflicts with Cloudflare's Worker `ExecutionContext`. Resolved: use **Codemode Context** for codemode userland.
- "session id" and "stream path" were conflated. Resolved: **Event Stream Path** is the public identity; Durable Object identity is derived infrastructure identity.
- "app" can mean the OS2 product or a managed project surface. Resolved: use **OS2 App** for this dashboard and **Project** for the managed app surface.
- "personal organization" is misleading because Clerk treats personal accounts separately from organizations. Resolved: use **Personal Account** for Clerk's non-organization user context.
