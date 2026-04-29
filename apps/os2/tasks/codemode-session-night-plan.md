---
state: in_progress
priority: high
size: large
dependsOn:
  - codemode-session-vertical-slice.md
---

# Codemode Session Night Plan

This is the working plan for finishing the Codemode Session architecture after
the first vertical slice. It should grow through the grill-with-docs questions
before implementation resumes.

## Current Decisions

- A **Codemode Session** is the durable authority for one **Event Stream Path**.
- The **Event Stream Path** is the public identity; Durable Object names are
  derived infrastructure identity.
- A **Script Execution** starts when the session appends
  `events.iterate.com/codemode/script-execution-requested`.
- `executeScript` is a command and returns the committed request event
  immediately.
- Reading output is separate: clients subscribe/read from the Event Stream Path.
- The **Codemode Session** owns the **Tool Provider** registry for its stream.
- Dynamic workers and Tool Providers receive a **Codemode Session Capability**.
- A local helper turns that capability into a **Codemode Context**.
- Tool Functions are addressed at the context root:
  `ctx.<provider>.<toolFunction>(payload)`.
- Built-in codemode operations are grouped under `ctx.codemode.*`.
- `ctx.codemode.*` is the **Codemode Control Surface**, not a Tool Provider.
- Provider-to-provider calls go back through the Codemode Session and append the
  normal Tool Function lifecycle events.
- **Provider Descriptors** are serializable. **Tool Providers** and **Provider
  Bridges** are live runtime implementations.
- A callable descriptor is only known to be dispatchable against a concrete
  dispatch context. `loopback-binding` is valid when the dispatching worker has
  the matching `ctx.exports`; it is not globally valid or invalid.

## Current Implementation Map

- `apps/os2/src/durable-objects/codemode-session.ts`
  - `CodemodeSession` Durable Object.
  - Owns registry, event append, script execution, and Tool Function lifecycle.
  - Starts dynamic workers with a scoped `CodemodeSessionCapability`.
- `packages/shared/src/codemode/context-proxy.ts`
  - Builds the local `CodemodeContext` proxy from a capability.
- `packages/shared/src/callable/*`
  - Serializable callable descriptors and dispatch.
  - `assertCallableDispatchContext()` validates a callable against actual
    `env` / `ctx.exports` / `fetch` dispatch authority.
- `apps/os2-contract/src/index.ts`
  - oRPC contract for `codemode.executeScript`, `codemode.streamEvents`, legacy
    `codemode.execute`, and `codemode.describe`.
- `apps/os2/src/orpc/routers/codemode.ts`
  - One-shot API layer that initializes a session, optionally registers
    providers, starts a Script Execution, and reads events.
- `apps/os2/src/rpc-targets/openapi-bridge.ts`
  - Stateless Provider Bridge for OpenAPI specs.
- `apps/os2/src/rpc-targets/mcp-client-bridge.ts`
  - Stateful Provider Bridge for remote MCP servers.

## Outcome We Want

End state for this slice:

1. A Project MCP Endpoint can create or attach to a Project Run Code Session
   for its Project.
2. The session can register durable Provider Descriptors.
3. Provider Descriptors can point to first-party bridge entrypoints without
   depending on whichever worker happens to dispatch the call.
4. A script can call a bridge-backed Tool Function through `ctx.provider.fn()`.
5. A provider can call another provider through the same Codemode Session
   Capability.
6. MCP `run_code` can start a Script Execution and return useful results while
   preserving the underlying event stream.
7. The UI can observe and manage Project Run Code Sessions through the same
   session/event model, with Project identity supplied by the browser route and
   oRPC client.
8. The remaining unsafe or deliberately-unimplemented surfaces are captured as
   explicit follow-up tasks, not implicit TODOs.

## Proposed Workstreams

### 1. Provider Descriptor Resolution

Goal: make serialized Provider Descriptors dispatch reliably from a Codemode
Session worker.

Questions to resolve:

- Should OS2 standardize on **Self-Callable Provider Descriptors** for
  first-party app-worker bridges?
- Should a Self-Callable Provider Descriptor contain a stable `workerScriptName`
  as domain metadata, or should that remain only deployment wiring?
- Should `createOpenApiProvider()` and `createMcpClientProvider()` require a
  dispatch mode, or should the caller choose between loopback and self-callable
  factories?
- Should the Codemode Session reject Provider Descriptors that cannot dispatch
  in its current callable context at registration time?
- Should provider registration append failure events, or should failed
  registration simply fail the command?

Likely implementation:

- Keep `loopback-binding` for same-worker immediate calls.
- Use self-callable/env-binding descriptors for anything stored in a
  Codemode Session.
- Add helper(s) that construct and validate first-party Provider Descriptors
  from app config plus dispatch context.
- Add workerd proof that OpenAPI bridge can be registered on a session and
  called from a script.

### 2. Bridge Provider Proofs

Goal: prove real Provider Bridges through the session.

Scenarios:

- OpenAPI bridge provider registered on session.
- Script calls `ctx.petstore.<operationId>(payload)`.
- Session appends:
  - provider registered
  - script execution requested
  - tool function call requested
  - tool function call succeeded/failed
  - script execution finished
- MCP client bridge provider registered on session.
- Script calls one remote MCP tool.
- Provider A calls bridge provider B through `CodemodeSessionCapability`.

Risks to examine:

- OpenAPI SSRF and auth are out of scope for this slice but must become a task.
- MCP bridge identity probably cannot be only `serverUrl` once auth/tenant scope
  enters the picture.
- Operation IDs and MCP tool names may need path sanitization or aliasing.

### 3. Event Schema Hardening

Goal: stop relying on generic event payloads for codemode internals.

Candidate event types:

- `events.iterate.com/codemode/tool-provider-registered`
- `events.iterate.com/codemode/script-execution-requested`
- `events.iterate.com/codemode/script-execution-finished`
- `events.iterate.com/codemode/log-emitted`
- `events.iterate.com/codemode/tool-function-call-requested`
- `events.iterate.com/codemode/tool-function-call-succeeded`
- `events.iterate.com/codemode/tool-function-call-failed`

Questions to resolve:

- Should event schemas live in `apps/os2-contract`,
  `@iterate-com/events-contract`, or a new codemode contract package?
- Should canonical lifecycle events be appendable only by the Codemode Session?
- Should provider/domain progress events use a codemode prefix or provider-owned
  event types?
- Is `scriptExecutionRequestedOffset` enough as the Script Execution identity,
  or do we need a stable generated ID in payload too?
- Do Tool Function Calls need generated call IDs, or are requested-event offsets
  enough?

### 4. Codemode Context and Control Surface

Goal: make the script/provider authoring API explicit and bounded.

Current intended shape:

```ts
async (ctx) => {
  await ctx.codemode.append({
    type: "events.iterate.com/codemode/note-added",
    payload: { message: "starting" },
  });

  return await ctx.petstore.getPetById({ petId: 1 });
};
```

Questions to resolve:

- Should `ctx.codemode.append` be exposed to scripts by default?
- Should Tool Providers receive `ctx.codemode.executeScript` by default?
- Should `ctx.codemode.getStreamPath()` be exposed, or should stream identity be
  event-only?
- What is the minimal abort/cancellation shape on the Codemode Context?
- Should `ctx.codemode` include an explicit `callToolFunction({ path, payload })`
  substrate, with root proxy calls as sugar?
- Which root names are reserved for the proxy?

### 5. Capability Scope and Runtime Limits

Goal: avoid accidental infinite recursion or ambient broad authority.

Questions to resolve:

- What is the first useful scope object for `getScopedRpcTarget(scope)`?
- Do scripts and Tool Providers get different default scopes?
- Should providers be able to call all providers, only siblings, or only allowed
  path prefixes?
- What max depth, max total calls, max payload size, and deadline should exist
  in v1?
- Where do limit failures appear in events?
- Should provider-to-provider calls carry parent call offsets?

Likely first slice:

- Add depth/call-count/deadline fields to internal call context only.
- Continue punting policy allowlists to follow-up.
- Add recursion tests before any public bridge/provider surfaces are encouraged.

### 6. MCP Server Integration

Goal: make remote MCP clients the primary way to create and use Project Run Code
Sessions. Each Project has its own MCP endpoint, so MCP tools should not ask
the caller to select a Project in their input.

Questions to resolve:

- Does each MCP client session map to one Project Run Code Session by default?
- Does each `run_code` tool call create a fresh Project Run Code Session, or a
  new Script Execution inside an existing Project Run Code Session?
- How does the Project MCP Endpoint resolve the Project from the request route?
- Should MCP `run_code` return final text only, event offsets, the Event Stream
  Path, or a combination?
- Should MCP expose tools to register Provider Descriptors, or should provider
  setup be Project/session state managed elsewhere?
- How does Clerk Organization / Project identity enter the Event Stream Path?

Likely product stance:

- MCP is the primary interface for running code.
- MCP project identity comes from the Project MCP Endpoint, not from a project
  selector in tool arguments.
- UI is an observer and management surface for project-scoped run sessions.
- Browser oRPC project identity comes from the Project Route and frontend route
  context.
- MCP responses can be simplified for client ergonomics, but every run must
  still be backed by canonical codemode events.

### 7. UI and Project Route Integration

Goal: wire codemode into the new organization/project route shape without
fighting the current routing churn.

Known local route direction:

- Run Code likely lives under
  `/_app/orgs.$organizationSlug.projects.$projectSlug.run-code`.

Questions to resolve:

- Is a Project Run Code Session per Project MCP client session, per Project, per Script
  block, or user-chosen?
- Where is the Event Stream Path chosen?
- Should Run Code create a new Event Stream Path by default every run?
- Should a Project have a default Provider Registry, or should each session get
  providers explicitly?
- Does the UI expose raw Provider Descriptor editing, curated bridge setup, or
  only first-party defaults?

### 8. Compatibility and Cleanup

Goal: remove confusing old surfaces once replacement flows are proven.

Questions to resolve:

- When do we delete `codemode.execute`?
- Do we keep `CodemodeExecutor` from `packages/shared/src/codemode/executor.ts`
  as a fallback, or does everything go through `CodemodeSession`?
- Which old tasks should be closed/replaced by this plan?
- Should temp prototypes under `apps/os2/tmp/` stay as reference material or be
  deleted once tests cover the behavior?

## Grill Queue

These are intentionally ordered so each answer narrows later work.

1. What is the unit of user intent: Project Run Code Session, Script Execution,
   or Event Stream Path? Resolved: **Project Run Code Session**.
2. Should stored Provider Descriptors always be dispatchable by the Codemode
   Session worker, or can some descriptors be one-shot only?
3. Should self-callable first-party bridge descriptors become the default for
   OpenAPI and MCP bridges?
4. Should canonical codemode event schemas live in OS2, events-contract, or a
   new package?
5. Are event offsets enough identity for Script Executions and Tool Function
   Calls?
6. Should providers get `executeScript` capability by default?
7. Should scripts get `append` capability by default?
8. Should provider-to-provider calls be allowed by default?
9. What should happen when a provider registration appends the registry event
   but later dispatch validation fails?
10. How much of this needs to be Project-persistent versus session-local?
11. Since MCP is primary and project-scoped, should each MCP client session get
    one sticky Project Run Code Session or should each `run_code` call create a
    fresh one by default?

## Implementation Checkpoints

- [ ] Resolve grill questions into this plan.
- [ ] Update `apps/os2/CONTEXT.md` when terminology or relationships change.
- [ ] Add ADR only if we choose a hard-to-reverse design with real alternatives.
- [ ] Build first-party self-callable descriptor helper.
- [ ] Prove OpenAPI bridge through Codemode Session in workerd.
- [ ] Prove MCP bridge through Codemode Session or create a blocker task.
- [ ] Add explicit codemode event schemas.
- [ ] Add runtime limit/cycle tests.
- [ ] Wire Run Code route to the session/event model.
- [ ] Move MCP `run_code` onto the session/event model.
- [ ] Delete or deprecate compatibility `codemode.execute`.
