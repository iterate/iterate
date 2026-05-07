---
state: open
priority: high
size: large
dependsOn:
  - os2-events-streams-project-identity-plan
---

# OS2 domain, capability, and project oRPC refactor design

## Purpose

This is a collaborative design document for turning OS2 inside out around domain
modules, project-bound capabilities, and a cleaner oRPC surface.

The target architecture is:

1. A domain runtime owns durable state and core behavior.
2. A capability entrypoint binds runtime authority through Cloudflare env
   bindings and `WorkerEntrypoint` props.
3. The oRPC layer validates untrusted user input, performs auth checks, resolves
   pretty route identifiers, and mostly proxies to project-bound capabilities.
4. The codemode oRPC capability wraps the project-scoped oRPC layer back into a
   project-bound Tool Provider by injecting the Project ID.
5. Browser routes stay in TanStack route files. Domain modules may own reusable
   components, but not route files or page modules in this refactor.

## Locked Decisions

- Use `domains`, not `features`, for OS2 vertical modules. In this first
  refactor, domain modules own durable runtime behavior, capabilities,
  processors, utilities, tests, and reusable UI components.
- Keep actual TanStack route files in `apps/os2/src/routes`.
- Keep normal oRPC routers in `apps/os2/src/orpc` for now.
- Do not move page modules into domains as part of this refactor. Domain modules
  may own reusable components only.
- Domain `components/` folders are for reusable components, not route/page
  modules.
- Keep shared stream runtime in `packages/shared/src/streams`.
- OS2 uses Project ID as the Stream Namespace for project-owned streams, but the
  shared stream runtime must not know about Projects.
- `os.projects` is plural and collection-oriented.
- `os.project` is singular and project-scoped.
- `codemode`, `inboundMcpServer`, and `streams` all live under `os.project`.
- Delete persisted Project Presets entirely.
- Replace persisted Presets with static Codemode Example Stacks in source code.
- Codemode Example Stacks are product-authored Event Input stacks plus provider
  registrations and example scripts; they are not Project-owned persisted
  records.
- Every external/browser-facing `os.project.*` procedure takes an explicit
  `projectSlugOrId`.
- `projectSlugOrId` accepts either globally unique Project Slug or stable
  Project ID.
- Codemode gets a project-bound view of `os.project.*` as `ctx.os.*`.
- Codemode does not see or pass `projectSlugOrId`; the codemode oRPC capability
  injects it from the current Project.
- Codemode can call everything in the normal `os.project` router, not a special
  codemode-only router.
- Codemode exposes all of `os.project.*`, not an allowlisted subset.
- `OrpcCapability` belongs to the Codemode domain because it is a codemode Tool
  Provider adapter.
- oRPC procedures are the outer untrusted-input layer for browser/API callers.
- Most oRPC procedure implementations should resolve auth/identity and then call
  a trusted capability.
- Capabilities are the reusable trusted-call interfaces around Durable Objects or
  other domain runtimes.
- The codemode oRPC capability is intentionally a wrapper around the outer oRPC
  layer: it exposes the project-scoped oRPC subtree as a Tool Provider and
  injects the bound Project ID.
- Domain modules own Durable Object classes and WorkerEntrypoint capability
  classes.
- `entry.workerd.ts` should only re-export domain-owned runtime classes and wire
  Worker fetch/deployment concerns.
- Move `ProjectDurableObject` into the Projects domain in this first pass, even
  though project oRPC routers stay global.
- Move `CodemodeSession` into the Codemode domain in this first pass, even
  though codemode oRPC routers stay global.
- `orpc/root.ts`, `orpc/orpc.ts`, `orpc/handler.ts`, `orpc/client.ts`,
  `orpc/project-access.ts`, and `orpc/routers/*` stay global oRPC wiring for
  now.
- App-wide auth middleware such as `activeOrganizationMiddleware` stays global.
- Project scope middleware and Project slug/id resolution can stay in global
  oRPC files for this first refactor.
- Do not add domain barrel files.
- Callers should import concrete files inside domains.
- Do not restructure `apps/os2-contract` as part of this refactor.
- Treat `apps/os2-contract` as a nuisance package that may be deleted or
  redesigned later; touch it only as needed for the `os.project.*` API shape.
- Do not move OS2-specific domain implementations wholesale into
  `packages/shared`.

## Target Domain Layout

Initial target shape:

```txt
apps/os2/src/domains/
  projects/
    README.md
    AGENTS.md -> README.md
    durable-objects/
      project-durable-object.ts
    entrypoints/
      project-ingress-entrypoint.ts
    stream-processors/
      project-lifecycle.ts
    utils/
    *.test.ts
    components/

  streams/
    README.md
    AGENTS.md -> README.md
    entrypoints/
      streams-capability.ts
    utils/
    *.test.ts
    components/
      stream-path.tsx
      streams-table.tsx
      create-stream-bar.tsx

  codemode/
    README.md
    AGENTS.md -> README.md
    codemode-session-rpc.ts
    default-provider-registrations.ts
    example-provider-registrations.ts
    example-stacks.ts
    durable-objects/
      codemode-session.ts
    entrypoints/
      ai-capability.ts
      fetch-capability.ts
      orpc-capability.ts
    stream-processors/
      codemode-session-processor.ts
    utils/
    *.test.ts
    components/

  agents/
    README.md
    AGENTS.md -> README.md
    durable-objects/
      agent-durable-object.ts
    entrypoints/
      agent-capability.ts
    stream-processors/
    utils/
    *.test.ts
    components/

  repos/
    README.md
    AGENTS.md -> README.md
    durable-objects/
      repo-durable-object.ts
    entrypoints/
      repo-capability.ts
    stream-processors/
    utils/
    *.test.ts
    components/

  workspaces/
    README.md
    AGENTS.md -> README.md
    durable-objects/
      workspace-durable-object.ts
    entrypoints/
      workspace-capability.ts
    stream-processors/
    utils/
    *.test.ts
    components/

  slack/
    README.md
    AGENTS.md -> README.md
    entrypoints/
      slack-capability.ts
    durable-objects/
    stream-processors/
    utils/
    *.test.ts
    components/

  inbound-mcp-server/
    README.md
    AGENTS.md -> README.md
    durable-objects/
      project-mcp-server-connection.ts
      iterate-mcp-server.ts
    entrypoints/
      project-mcp-server-entrypoint.ts
    utils/
    *.test.ts
    components/

  outbound-mcp-client/
    README.md
    AGENTS.md -> README.md
    durable-objects/
      outbound-mcp-from-our-client-capability.ts
    utils/
      outbound-mcp-from-our-client-capability-core.ts
    *.test.ts
    components/

  ingress/
    README.md
    AGENTS.md -> README.md
    entrypoints/
    utils/
    *.test.ts
    components/
```

Notes:

- Every `domains/*` folder must have a `README.md`.
- Every `domains/*/AGENTS.md` should be a symlink to that domain `README.md`.
- Domain READMEs should be short manuals, not implementation checklists.
- Keep TODOs and task checklists in `tasks/`, not domain READMEs.
- Do not force every standard subfolder to exist when it has no files.
- Create domain subfolders such as `durable-objects`, `entrypoints`,
  `stream-processors`, `utils`, and `components` only when they contain real
  files or make a skeleton domain clearer.
- Domain-local utilities should live under that domain, usually in `utils/`,
  unless they are genuinely shared across multiple domains.
- Domain-local unit and runtime tests should live next to the code they cover
  inside the domain. End-to-end tests stay outside domains.
- Move test source files into domains where practical, but keep Vitest config
  files in their current location unless moving them is trivial and low-churn.
- Keep app-level D1/sqlfu schema, migrations, and generated query files in
  `apps/os2/src/db`.
- Domain READMEs should state that most domain state should live in Durable
  Objects when practical; app-level D1 projections are for queryability, routing,
  and cross-object lookup.
- Future work may explore using sqlfu inside Durable Objects, but this refactor
  does not do that.
- Do not add hard domain dependency direction rules yet.
- Domain READMEs should state that cross-domain imports deserve care because a
  future refactor may extract each domain into its own package, which would make
  dependencies explicit.
- `ingress` may remain part of `projects` until it grows further. It is a
  candidate domain because host routing, ingress rules, fetch callables, and
  project ingress are already a distinct concept.
- `repos`, `workspaces`, and `slack` should exist as skeleton domains in this
  refactor so the overall structure is visible.
- Domain `entrypoints/` folders contain WorkerEntrypoint classes, Durable Object
  classes used as callable entrypoints, and other Cloudflare runtime entrypoints.
  Keep the `Capability` suffix in filenames/classes where the class is a
  capability.
- `agents`, `repos`, `workspaces`, and `slack` are codemode Tool Provider
  implementation domains for now. Do not add normal `os.project.*` oRPC
  subrouters for them in this refactor.
- Keep codemode `ctx.repos.get({ slug })` unchanged.
- Keep codemode `ctx.workspace.*` unchanged for now.
- Keep codemode Slack at root `ctx.slack.*`.
- The initial `repos` and `workspaces` domains may mostly hold current POC
  codemode capability code.
- Move the current POC repo/workspace classes into their skeleton domains during
  this refactor rather than leaving empty skeleton folders.
- Add an `agents` skeleton domain and move the current POC Agent capability and
  Durable Object into it.
- Consolidate `ctx.createSubagent` and `ctx.makeSubagent` into one codemode
  subagent API.
- Replace both root-level subagent helpers with `ctx.agents.create()`.
- Delete `ctx.createSubagent()` and `ctx.makeSubagent()` after migrating
  examples/tests. Promise-pipelining should be tested through
  `ctx.agents.create().method(...)`.
- Keep `FetchCapability` and `AiCapability` in the Codemode domain for now.
- Codemode provider registration files stay in the Codemode domain root unless
  they grow enough to justify a common cross-domain folder pattern.
- Codemode examples stay in the Codemode domain root.
- Avoid one-off subfolders. Add a subfolder only when the same category makes
  sense across domains.
- `workspaces` remains a risky product term because OS2 already has Project and
  Clerk Organization. Its README must say that the domain is skeletal/POC until
  the product concept is clarified.
- The initial `slack` domain may hold the current codemode Slack capability.
- Move the current POC Slack capability into the Slack domain during this
  refactor.
  Shared Slack stream processors stay in `packages/shared` unless OS2-specific
  Slack installation/webhook behavior is added.
- Split MCP into two domains:
  - `inbound-mcp-server` owns OS2's Project-scoped MCP server, including
    `ProjectMcpServerEntrypoint`, `ProjectMcpServerConnection`, and
    `IterateMcpServer` test/support code where applicable.
  - `outbound-mcp-client` owns the capability that lets codemode/inbound MCP
    connect from OS2 out to another MCP server.
- Outbound MCP is a core codemode capability. At least one public MCP server
  should be included in the default codemode provider sets.
- From codemode's perspective, outbound MCP providers should live under
  `ctx.mcp.<serverName>`.
- Use protocol-specific discovery names: `ctx.os.listProcedures()` for oRPC and
  `ctx.mcp.<serverName>.listTools()` for MCP.
- Outbound MCP providers should be configured, not automatically injected into
  every Codemode Session.
- For this refactor, outbound MCP provider configuration comes from Example
  Stacks only. It is example/demo material, not a separate Project config
  surface.
- `ctx.mcp.cloudflareDocs` is the recommended first configured public MCP
  provider, not a hardcoded universal default.
- Candidate public MCP providers:
  - `ctx.mcp.cloudflareDocs` -> `https://docs.mcp.cloudflare.com/mcp`
  - `ctx.mcp.cloudflareRadar` -> `https://radar.mcp.cloudflare.com/mcp`
  - `ctx.mcp.xDocs` -> `https://docs.x.com/mcp`
- Domain movement should be incremental. The first pass can create domain
  folders and move the clearest modules without trying to flatten every import.

## Target oRPC Surface

The desired public contract shape is:

```ts
os.projects.list(input);
os.projects.create(input);
os.projects.find(input);
os.projects.findBySlug(input);

os.project.get({ projectSlugOrId });

os.project.codemode.listSessions({ projectSlugOrId });
os.project.codemode.findSession({ projectSlugOrId, name });
os.project.codemode.createSession({ projectSlugOrId, ...input });
os.project.codemode.executeScript({ projectSlugOrId, ...input });
os.project.codemode.streamEvents({ projectSlugOrId, ...input });
os.project.codemode.describe({ projectSlugOrId, ...input });

os.project.inboundMcpServer.listSessions({ projectSlugOrId });

os.project.streams.list({ projectSlugOrId });
os.project.streams.create({ projectSlugOrId, streamPath });
os.project.streams.append({ projectSlugOrId, streamPath, event });
os.project.streams.read({ projectSlugOrId, streamPath, ...input });
os.project.streams.getState({ projectSlugOrId, streamPath });
```

`os.projects` remains for collection and discovery operations. Project-scoped
subdomains leave `os.projects.*` and move to `os.project.*`.
`os.project.get({ projectSlugOrId })` is the canonical project-scoped lookup and
uses the same project scope middleware as the rest of `os.project.*`.

## Codemode Example Stacks

Persisted Project Presets should be deleted.

The replacement is a static source file with product-authored Codemode Example
Stacks. Example Stacks are an authoring/UI model. Codemode Session runtime input
is still events only.

```ts
type CodemodeExampleStack = {
  slug: string;
  name: string;
  description: string;
  providers: CodemodeProviderInput[];
  events: EventInput[];
  scripts: CodemodeExampleScript[];
};

type CodemodeExampleScript = {
  slug: string;
  name: string;
  description: string;
  code: string;
};
```

Rules:

- Example Stacks are not stored in D1.
- Example Stacks are not copied into a Project at Project creation time.
- Example Stacks are not editable through oRPC.
- Example Stacks are not project-owned.
- An Example Stack is an authored starting context: provider registrations plus
  Event Inputs plus example scripts.
- Use the existing `CodemodeProviderInput` shape for `providers` in this
  refactor.
- Provider registrations are allowed in the authoring model because they are
  easier for UI/docs to render than raw provider-configured events.
- Before creating or running a Codemode Session, the Example Stack must compile
  down to Event Inputs.
- Codemode Session Durable Objects only receive/appends Event Inputs. They do
  not know about the Example Stack authoring model.
- An Example Stack has one or more scripts showing what can be done with that
  starting context and provider set.
- The Examples page should browse stacks, render their Event Inputs nicely, show
  provider registrations, and show the scripts attached to each stack.
- The new Codemode Session UI can import/add events from any Example Stack to
  the session being created.
- The new Codemode Session UI should make the authoring layer explicit: show the
  selected Example Stack/providers/scripts, and also show the concrete Event
  Inputs that selection compiles down to or has added to the session.
- This should be similar in spirit to the agent preset UX in `apps/agents`, where
  users can understand both the friendly preset and the underlying generated
  material.
- The new Codemode Session UI is a picker. User actions such as selecting an
  Example Stack, adding providers, or choosing stack events copy/append concrete
  Event Inputs into a visible raw selected-event list.
- Once copied into the selected-event list, events are explicit session input.
  There is no hidden link that re-resolves the Example Stack at submit time.
- Selecting an Example Stack script copies the script code into the script
  editor/form immediately. After selection, the run uses the visible editable
  code, not a hidden reference to the Example Stack script.
- Existing Codemode Session UI should also expose a similar provider/event
  picker. Adding a new Tool Provider to an existing session appends the concrete
  provider-configured Event Inputs to that session's stream.
- Existing sessions should show the authoring-friendly provider choice and the
  raw Event Inputs that will be appended before the user confirms.

Codemode input ordering remains:

```txt
selected Example Stack provider registrations compiled to events
  -> selected Example Stack events
  -> ad-hoc custom events
  -> script-execution-requested event, if a script is selected
```

This deliberately removes the user-editable Project Preset product surface. If
we later want named Project-owned event bundles, we can reintroduce that as a
real product design rather than carrying the current POC implementation forward.

## Project-Scoped oRPC Middleware

`os.project.*` procedures should share one explicit project scope middleware.

Input shape:

```ts
{
  projectSlugOrId: string;
  ...procedureSpecificInput
}
```

Middleware responsibilities:

- Parse and normalize `projectSlugOrId`.
- Resolve it as either Project ID or globally unique Project Slug.
- Check that the authenticated Clerk principal has access to the resolved
  Project.
- Add a resolved Project object to oRPC context for downstream handlers.
- Keep the stable Project ID available for capability props and Durable Object
  names.
- Return `403` when the Project exists but the caller has no access.
- Return `404` when the Project does not exist.

The middleware should be the only place where project slug/id ambiguity exists.
Handlers should use the resolved stable Project ID.

## Capability Layering

The desired implementation shape for most project-scoped procedures is:

```txt
oRPC handler
  -> project scope middleware resolves Project and checks auth
  -> create or obtain project-bound capability
  -> call capability method
  -> return validated result
```

For streams:

```txt
os.project.streams.append({ projectSlugOrId, streamPath, event })
  -> project middleware resolves Project
  -> StreamsCapability({ props: { namespace: project.id } })
  -> capability resolves/normalizes streamPath
  -> StreamDurableObject.append(event)
```

All `os.project.streams.*` oRPC handlers should call `StreamsCapability`.
The oRPC router is the untrusted-input/auth layer in front of the trusted
capability. If stream listing needs Durable Object catalog access, expose that
through the StreamsCapability rather than making the oRPC router reach around
the capability.

For codemode:

```txt
os.project.codemode.executeScript({ projectSlugOrId, ...input })
  -> project middleware resolves Project
  -> Codemode Session Durable Object
  -> stream processors and tool provider capabilities
```

Do not add a `CodemodeSessionCapability` in this refactor. Keep codemode oRPC
handlers directly creating/using handles on the Codemode Session Durable Object
for now. The capability-shaped onion model still guides the design, but this
extra abstraction is deferred until the Codemode Session interface needs to be
reused by another trusted caller.

Keep the existing `codemode-session-rpc.ts` helper as the small shared surface
between web codemode oRPC and inbound MCP `run_code`. Move it into the Codemode
domain, but do not replace it with a new capability in this refactor.

The durable runtime should not parse route slugs, Clerk claims, OpenAPI input, or
browser form data. Those concerns belong to oRPC/protocol adapters.

The important onion model:

```txt
Durable Object / domain runtime
  <- trusted domain capability
  <- oRPC procedure for untrusted browser/API inputs
  <- codemode oRPC capability when codemode wants to call project oRPC
```

This looks recursive, but it is deliberate. Normal product/API calls enter
through oRPC, and those oRPC handlers call trusted capabilities. Codemode then
gets an `OrpcCapability` that turns the normal `os.project.*` oRPC subtree into
a project-bound Tool Provider. The codemode oRPC capability does not replace the
domain capabilities underneath the oRPC handlers; it just supplies a trusted
Project ID and invokes the same outer API surface in-process.

Example:

```txt
Browser:
  orpc.project.codemode.executeScript({ projectSlugOrId, ... })
    -> resolve/check Project
    -> Codemode Session Capability
    -> Codemode Session Durable Object

Codemode:
  ctx.os.codemode.executeScript({ ... })
    -> OrpcCapability injects projectSlugOrId = bound Project ID
    -> same orpc.project.codemode.executeScript implementation
    -> Codemode Session Capability
    -> Codemode Session Durable Object
```

## Codemode oRPC Capability

`OrpcCapability` is part of the Codemode domain. It is specifically a codemode
Tool Provider adapter that exposes the normal project-scoped oRPC router with
the `project` layer skipped.

The existing implementation already uses the right broad mechanism:

- `OrpcCapability.executeCodemodeFunctionCall(...)` resolves an implemented
  oRPC procedure in-process.
- It calls that procedure with `call(...)` from `@orpc/server`.
- It creates a server-side `AppContext` from Worker bindings and provider props.

This refactor keeps that mechanism. It changes the exposed subtree from the
current demo/test router to the real `os.project` router and makes the caller
project-bound.

External/browser API:

```ts
await orpc.project.streams.list({ projectSlugOrId: "yoooo" });
await orpc.project.codemode.listSessions({ projectSlugOrId: "prj_..." });
```

Codemode API:

```ts
await ctx.os.streams.list({});
await ctx.os.codemode.listSessions({});
await ctx.os.inboundMcpServer.listSessions({});
```

Codemode implementation rules:

- Use the existing real `os.project` router.
- Do not create a separate codemode-only router.
- Expose all of `os.project.*`.
- Use a lightweight server-side caller context, not an HTTP oRPC client.
- The server-side caller context exists so existing handlers receive the Worker
  bindings and context objects they expect.
- The caller context may be a pragmatic internal/codemode context for now. It
  does not need a fresh Clerk user auth flow because the capability is already
  bound to one Project.
- The oRPC capability wraps project oRPC procedures; those procedures should
  still call their own domain capabilities after resolving untrusted input.
- Inject `projectSlugOrId` into the input object before invoking the oRPC
  handler.
- The injected value should be the stable Project ID from the codemode session
  props.
- Caller-supplied `projectSlugOrId` must never override the bound Project ID.
- Assume oRPC procedure inputs are objects, not positional args.
- If a procedure input is omitted, treat it as `{}` before injecting
  `projectSlugOrId`.
- If a caller passes more than one arg or a non-object arg, throw.
- Hide `projectSlugOrId` from generated codemode JSON schemas, types, procedure
  listings, and instructions.
- Post-process oRPC input schemas/listings/types to remove the project identity
  parameter supplied by the capability.
- List only stripped codemode paths such as `streams.list`, not underlying paths
  such as `project.streams.list`.
- If a codemode script supplies `projectSlugOrId` anyway, the provider must
  throw. This is a capability-boundary violation, not a value to merge.
- Apart from resolving the called procedure, enforcing object input shape,
  forbidding caller-supplied `projectSlugOrId`, injecting the bound Project ID,
  and post-processing generated declarations, the oRPC capability should not
  understand procedure-specific input semantics.
- Procedure-specific behavior such as stream path normalization belongs inside
  the underlying oRPC procedure or trusted domain capability.

Procedure discovery must be project-bound and stripped:

```txt
streams.list
codemode.listSessions
inboundMcpServer.listSessions
```

Do not expose `project.streams.list` or other underlying `project.*` paths in
codemode listings. Do not include extra procedure metadata for the underlying
router path unless we later add a separate debugging-only mode.

Discovery functions are provider-owned Tool Functions. In this case,
`OrpcCapability` chooses `ctx.os.listProcedures()` as its discovery function.
Other Tool Providers may choose different discovery names that fit their
protocol or domain.

`ctx.os.listProcedures()` should be included in the generated codemode TypeScript
definitions. It is an ordinary Tool Function exposed by the oRPC capability, not
an undocumented dynamic escape hatch.
The returned declaration should include `listProcedures` itself at the mounted
provider path with a fixed `Promise<string>` return type.
`listProcedures` takes no input in this refactor.

Procedure listings should include output schemas where available. Output schemas
are critical for callers and generated TypeScript. Project identity
post-processing applies to input schemas only.

`ctx.os.listProcedures()` should return only a generated TypeScript declaration
string. That declaration should include docstrings, nested function signatures,
input types, and output types. It should declare the provider at its actual
mounted Codemode Context path. If the oRPC provider is mounted at
`ctx.something.somethingElse.os`, the declaration must target that nested path,
not assume `ctx.os`.

The generated declaration should be similar to how codemode/Cloudflare-style
tool specs are rendered into TypeScript for callers. It should not return HTTP
route metadata such as method, OpenAPI path, or tags in the normal response.
Use the existing prior art in
`packages/shared/src/codemode/json-schema-types.ts`: field descriptions become
property doc comments in generated input/output types, and input field
descriptions also become `@param input.<field>` comments on the generated Tool
Function docstring. The oRPC capability refactor should preserve that behavior
and extend it only where necessary for nested provider paths and stripped
project identity.

## Shared Runtime Boundaries

Shared packages should own code that is truly reusable across apps:

```txt
packages/shared/src/streams/
  stream-durable-object.ts
  types.ts
  helpers.ts
  external-subscriber.ts
  db/

packages/shared/src/stream-processors/
  slack/
  slack-thread/
```

OS2 domains should own OS2-specific adapters:

- oRPC route shape.
- Clerk/project auth.
- Project-bound capability props.
- OS2-specific UI components.
- OS2 deployment and Worker entrypoint wiring.

Do not move the OS2 domains wholesale into `packages/shared`. That would make
`packages/shared` depend on OS2-specific concerns such as Clerk auth, OS2 app
config, D1 projections, Worker entrypoint exports, TanStack UI components, and
OS2 runtime tests. Shared should hold cross-app primitives. OS2 domains should
hold OS2 product/runtime behavior.

Leave `apps/os2-contract` structurally alone for now. It is a nuisance package
that may go away later. This refactor should touch the contract only where the
public `os.project.*` API shape requires it.

Apps should import shared stream schemas and types directly from
`@iterate-com/shared/streams/*`. `apps/events-contract` should not be the owner
or re-export hub for core stream schemas.

## Implementation Phases

### Phase 1: Contract and router shape

- Add `os.project` to `apps/os2-contract`.
- Do not split `apps/os2-contract` into domain files.
- Move project-scoped contract members from `os.projects.*` to `os.project.*`.
- Add `os.project.get({ projectSlugOrId })` while keeping `os.projects.find`
  and `os.projects.findBySlug` for collection/discovery callers.
- Rename:
  - `codemodeSessions.list` -> `codemode.listSessions`
  - `codemodeSessions.find` -> `codemode.findSession`
  - `mcpSessions.list` -> `inboundMcpServer.listSessions`
- Delete `project.presets.*` from the contract.
- Delete persisted Project Preset CRUD, routes, queries, table definitions, and
  seed-on-project-create behavior.
- Delete persisted Presets with sqlfu only: update definitions, generate the
  migration, and do not hand-write the migration.
- It is acceptable to delete local Miniflare state during this refactor.
- Preview/production preview databases may be reset if needed; do not preserve
  backwards compatibility for persisted Presets.
- Replace the Codemode UI's Preset picker with Example Stack event import loaded
  from source.
- Delete the Project `/presets` route and sidebar item entirely. Static examples
  remain the user-facing page for authored Example Stacks.
- Keep `os.projects` for project collection operations.
- Add `projectSlugOrId` to every `os.project.*` input.
- Update OpenAPI route paths to remain easy to curl, for example:
  - `/projects/{projectSlugOrId}/streams`
  - `/projects/{projectSlugOrId}/codemode/sessions`
  - `/projects/{projectSlugOrId}/mcp/sessions`

### Phase 2: Project scope middleware

- Add project slug/id resolution helper.
- Add shared project-scoped oRPC middleware.
- Keep `activeOrganizationMiddleware` in global oRPC wiring.
- Keep Project scope middleware and Project slug/id resolution in global oRPC
  files for this first refactor.
- Use Project ID internally after the middleware.
- Preserve existing Clerk active organization behavior unless the route already
  needs tightening.

### Phase 3: Capability proxying

- Refactor all stream oRPC handlers to call `StreamsCapability` rather than
  reaching straight through to `StreamDurableObject` or catalog helpers.
- Add StreamsCapability methods as needed so listing/append/read/get-state/create
  all go through the capability.
- Keep codemode oRPC handlers directly creating/using Codemode Session Durable
  Object handles for now.
- Move `codemode-session-rpc.ts` into the Codemode domain and keep using it from
  web codemode oRPC and inbound MCP.
- Keep implementation minimal; do not invent capability abstractions where the
  existing WorkerEntrypoint or Durable Object method is already the useful
  interface.

### Phase 4: Codemode bound `ctx.os`

- Point codemode's oRPC provider at `os.project`.
- Expose the `project` subtree as `ctx.os`.
- Keep the existing in-process server-side caller mechanism. Do not introduce an
  HTTP client call back into the same Worker.
- Build a lightweight server-side caller context from Worker bindings and
  provider props, similar to the existing `createCodemodeOrpcContext(...)`
  pattern.
- Inject stable Project ID as `projectSlugOrId`.
- Remove `projectSlugOrId` from generated codemode schemas/types/listings.
- Ensure codemode provider registration, generated instructions, runtime
  dispatch, tests, and examples all use the project-bound `ctx.os.*` view.
- Remove the old `ctx.os.test.*` demo as the primary oRPC capability example.
- Update codemode examples and tests to call:
  - `ctx.os.streams.list({})`
  - `ctx.os.codemode.listSessions({})`
- Ensure Codemode Example Stacks do not create a persisted oRPC surface.

### Phase 5: Domain folder movement

- Move modules in small groups.
- Keep `routes` untouched except import paths.
- Keep `entry.workerd.ts` as Worker wiring, but import exports from domains.
- Move Durable Object classes and WorkerEntrypoint capability classes into their
  owning domains; `entry.workerd.ts` should only re-export them.
- Move `ProjectDurableObject` into `domains/projects/durable-objects` in this
  first pass.
- Move `CodemodeSession` into `domains/codemode/durable-objects` in this first
  pass.
- Keep normal oRPC routers in `src/orpc/routers` for this first refactor.
- Keep `orpc/root.ts`, `orpc/orpc.ts`, `orpc/handler.ts`, `orpc/client.ts`, and
  `orpc/project-access.ts` global.
- Do not add `domains/*/index.ts` barrel files during the move. Update imports
  to concrete domain files instead.
- Update tests after each group.

Suggested first moves:

- `entrypoints/stream-capability.ts` -> `domains/streams/entrypoints/streams-capability.ts`
- Stream explorer reusable components -> `domains/streams/components`
- `durable-objects/project-durable-object.ts` -> `domains/projects/durable-objects/project-durable-object.ts`
- `entrypoints/project-ingress-entrypoint.ts` -> `domains/projects/entrypoints/project-ingress-entrypoint.ts`
- Current POC repo classes/capability -> `domains/repos`
- Current POC workspace classes/capability -> `domains/workspaces`
- Current POC Slack capability -> `domains/slack`
- Current POC Agent classes/capability -> `domains/agents`
- Consolidate provider registrations, examples, and tests so there is one
  namespaced subagent creation Tool Function: `ctx.agents.create()`.
- Remove `ctx.createSubagent` and `ctx.makeSubagent` provider registrations and
  migrate examples/tests to `ctx.agents.create()`.
- Inbound MCP server runtime/entrypoint -> `domains/inbound-mcp-server`
- Outbound MCP client capability/core/test -> `domains/outbound-mcp-client`
- Default codemode provider registrations include at least one public MCP server
  through the outbound MCP client capability.
- Migrate current `ctx.integrations.publicMcp` examples/tests to the
  `ctx.mcp.<serverName>` convention.
- Configure outbound MCP providers through Example Stacks only. Cloudflare Docs
  should be the first configured example.
- Inbound MCP `run_code` should use the richest available example/default
  codemode provider stack by default so it is useful for manual exploration.
- Browser-created Codemode Sessions should use a smaller/default stack unless
  the user selects additional providers or configured defaults require them.

### Phase 6: Documentation

- Copy the Documentation section below into an OS2 design doc under
  `apps/os2/docs`.
- Reference that design doc from `apps/os2/README.md`.
- Update `apps/os2/CONTEXT.md` with any new terms that survive implementation:
  Domain Module, Project-Scoped oRPC Surface, Project Scope Middleware,
  Project-Bound Capability, and Codemode oRPC Capability.

## Success Conditions

- `os.projects` contains only project collection/discovery/lifecycle operations.
- `os.project` contains all project-scoped functionality.
- `codemode`, `inboundMcpServer`, and `streams` are nested under `os.project`.
- `project.presets.*` does not exist.
- Persisted Project Presets are removed from contract, routers, routes, queries,
  schema definitions, generated sqlfu assets, and project creation behavior.
- Preset DB deletion uses sqlfu-generated migrations only.
- Codemode Example Stacks are static source data and do not create a persisted
  project-owned product surface.
- All external `os.project.*` procedures accept `projectSlugOrId`.
- All handlers use stable Project ID after project middleware resolution.
- Codemode exposes `ctx.os.*` as the project-bound view of `os.project.*`.
- Codemode generated schemas/types do not mention `projectSlugOrId`.
- Stream oRPC handlers use `StreamsCapability` for all project-bound stream
  operations.
- Shared stream runtime remains Project-agnostic and namespace-based.
- TanStack route files remain in `apps/os2/src/routes`.
- Domain modules do not own route files or page modules in this refactor.
- Every domain folder has `README.md`.
- Every domain folder has `AGENTS.md` symlinked to `README.md`.
- Domain-local utilities and unit/runtime tests live inside the domain where
  possible.
- Vitest config files may remain outside domains as wiring files.
- App-level D1/sqlfu files stay under `src/db`.
- Domain components are reusable leaf/composition components. Route-level page
  composition stays in TanStack route files for now.
- End-to-end tests stay outside domains.
- Existing `apps/os2` e2e tests continue working.
- Existing `apps/events` e2e tests continue working.
- Existing manual smoke tests against `apps/os2` and `apps/events` continue
  working.
- The implementer is responsible for proving the result works in local Miniflare
  and in a deployed preview environment after pushing the commit.
- Preview smoke still proves Code Mode works in OS2 with authenticated Clerk
  browser login.

## Verification

Focused checks:

```sh
pnpm --filter @iterate-com/os2-contract typecheck
pnpm --filter @iterate-com/os2 typecheck
pnpm --filter @iterate-com/os2 test
```

Broader checks before handoff:

```sh
pnpm typecheck
pnpm lint
pnpm test
```

Manual smoke coverage:

- OS2 local dev can list and create project streams.
- OS2 preview can log in through Clerk testing-token flow.
- OS2 preview Code Mode can call `ctx.os.streams.list({})`.
- OS2 preview Code Mode can call at least one non-stream project API through
  `ctx.os.*`.
- Events preview still serves public stream debug routes.
- Events preview can still append/read streams through its configured Stream
  Durable Object namespace.

## Open Questions

- Should `os.projects.find` remain collection-level, or should a resolved
  project details call also exist as `os.project.get({ projectSlugOrId })`?
- Should project deletion/config update live on `os.projects` as lifecycle
  commands, or under `os.project` as project-scoped commands?
- Should `ingress` be a `projects` subdomain for now, or a first-class
  `domains/ingress` module?
- When Slack becomes real product functionality in OS2, should it be
  `domains/slack` or remain under `domains/codemode` until it has installation
  and webhook config?
- Should codemode reject user-supplied `projectSlugOrId` in `ctx.os.*` calls, or
  silently overwrite it with the bound Project ID?

## Documentation

### OS2 domain modules and project-bound capabilities

OS2 is organized around domain modules. A domain module groups the code that
belongs to one product/runtime concept: durable objects, WorkerEntrypoint
capabilities, oRPC router fragments, stream processors, and reusable UI
components. Route files stay in `src/routes` so TanStack Start can own route
generation. Domain modules may own components imported by those routes, but this
design does not move pages or route files into domains.

The main reason for domain modules is locality. Streams, codemode, MCP, and
projects all cross runtime boundaries: Durable Objects, WorkerEntrypoints,
oRPC, stream processors, and browser UI. A layer-first tree makes one concept
hard to understand because a maintainer has to jump between global
`durable-objects`, `entrypoints`, `orpc`, `stream-processors`, and
`components` folders. A domain-first tree keeps the implementation of one
concept near itself while preserving framework-owned entrypoints.

The preferred implementation shape is:

1. A durable runtime owns the source-of-truth state and core behavior. Examples
   include `StreamDurableObject`, `ProjectDurableObject`, and
   `CodemodeSession`.
2. A capability entrypoint binds that runtime to a narrower authority. A
   capability is usually a Cloudflare `WorkerEntrypoint` parameterized by props
   such as `namespace`, `projectId`, append policy, or provider configuration.
3. The oRPC layer validates untrusted input, checks authentication and project
   access, resolves route-friendly identifiers, and then calls the capability.

This keeps browser/API concerns out of durable runtimes. Durable Objects should
not need to know about Clerk sessions, TanStack route params, OpenAPI paths, or
pretty project slugs. They should receive stable identifiers and validated
inputs from the layer in front of them.

Project-scoped browser APIs live under the singular `os.project` oRPC router.
The plural `os.projects` router is reserved for collection-level operations such
as listing and creating Projects. Functionality that acts inside one Project
lives under `os.project`, including:

```txt
os.project.streams.*
os.project.codemode.*
os.project.inboundMcpServer.*
```

Persisted Project Presets are not part of the target design. The previous
Project Preset model created editable Project-owned Event Input bundles, copied
seed Presets into each Project at creation time, and exposed CRUD through oRPC.
That is unnecessary for the current OS2 product shape.

Codemode should instead use static product-authored Example Stacks from source
code. An Example Stack is an authoring/UI model for a starting context:
provider registrations, Event Inputs, and one or more scripts that demonstrate
what can be done in that context. Before reaching the Codemode Session Durable
Object, provider registrations compile down to Event Inputs. The runtime
boundary remains events only. Example Stacks are not copied into a Project, not
editable through oRPC, and not Project-owned records. If OS2 later needs
user-editable named Event Input bundles, that should be designed as a new
product surface rather than preserving the current POC Preset implementation.

Every external `os.project.*` procedure accepts `projectSlugOrId`. That value
may be either a globally unique Project Slug or a stable Project ID. A shared
project scope middleware resolves it, verifies that the authenticated Clerk
principal has access, and adds the resolved Project to context. Handlers should
use the stable Project ID after that point.

Codemode receives a project-bound view of the same router. Inside a codemode
script, the model calls `ctx.os.streams.list({})` or
`ctx.os.codemode.listSessions({})`. The codemode oRPC capability invokes the
real `os.project` router underneath, but injects `projectSlugOrId` from the
current Codemode Session's stable Project ID. The generated codemode schemas,
types, and instructions hide `projectSlugOrId` because the script is already
bound to one Project.

Outbound MCP providers are exposed from the codemode point of view under
`ctx.mcp.<serverName>`. The default provider set should include
`ctx.mcp.cloudflareDocs`, backed by Cloudflare's public documentation MCP server.
Other good public candidates are Cloudflare Radar and X API docs. This namespace
is separate from OS2's inbound Project MCP server, which is exposed through
`os.project.inboundMcpServer.*` for browser/API callers.

Streams show the intended pattern clearly. The shared stream runtime lives in
`packages/shared/src/streams` and knows only about `{ namespace, path }`. OS2
uses stable Project ID as the stream namespace, but the stream runtime itself is
not project-specific. OS2's `StreamsCapability` binds the namespace through
WorkerEntrypoint props, and `os.project.streams.*` validates user input,
performs the Project access check, and proxies to that capability.

This architecture supports several use cases:

- Browser callers can use human-friendly Project Slugs in URLs and curlable
  APIs.
- Runtime code and Durable Objects operate on stable Project IDs.
- Codemode can safely expose project-scoped APIs without asking scripts to pass
  a Project ID on every call.
- Server-to-server calls use Cloudflare RPC and env bindings rather than public
  URLs or websocket loops when both participants live in the Worker runtime.
- Shared packages can hold reusable runtime primitives without making Events or
  OS2 appear to own each other's domain types.
- New domains, such as agents, repos, Slack, or secrets, can be added by placing
  their durable runtime, entrypoints/capabilities, processors, and reusable
  components together.

`apps/os2-contract` is intentionally not reorganized in this refactor. The
package is a nuisance we may delete or redesign later. For now, only update it
as needed to expose the desired `os.project.*` router shape.

Do not move OS2 domains wholesale into `packages/shared`. Shared packages should
contain cross-app primitives such as stream runtime types, callable descriptors,
and reusable stream processors. OS2 domains include app-specific auth, Project
semantics, Codemode Session behavior, Worker deployment wiring, UI components,
and D1 projections; moving those into shared would blur ownership and make
testing/package dependencies harder rather than cleaner.

The design intentionally keeps framework entrypoints thin. `entry.workerd.ts`
exports and wires Worker/Durable Object entrypoints. `orpc/root.ts` composes
normal oRPC router files. TanStack route files import domain components. These
files are wiring points, not the home of domain behavior.

Global oRPC files stay global in this first refactor. `orpc/root.ts` composes
the app router, `orpc/orpc.ts` owns shared oRPC implementation
helpers/middleware primitives, `orpc/handler.ts` wires transport handlers,
`orpc/client.ts` wires the browser/client, `orpc/project-access.ts` keeps
Project access helpers, and normal oRPC procedure implementations remain in
`orpc/routers/*`.

App-wide auth middleware, including `activeOrganizationMiddleware`, stays in
global oRPC wiring. Project identity resolution remains in global oRPC files for
now too. It is conceptually Projects-domain behavior, but keeping it outside
`domains/` makes the first physical refactor smaller.

Domain modules own runtime classes. Durable Object classes and
`WorkerEntrypoint` capability classes live inside their domain folders.
`entry.workerd.ts` imports and re-exports those classes for Cloudflare
deployment, but it should not become the implementation home for runtime
behavior.

Domain modules should not use barrel files by default. Callers import concrete
files such as `domains/projects/durable-objects/project-durable-object.ts` or
`domains/streams/entrypoints/streams-capability.ts`. This keeps dependency
direction visible and avoids circular import surprises around Durable Objects,
WorkerEntrypoints, and tests.

Each domain folder carries its own local guidance. Every `domains/*` directory
has a `README.md`, and `domains/*/AGENTS.md` is symlinked to that README so both
humans and agents see the same domain-local notes. Utilities and unit/runtime
tests should live inside the domain when they mostly serve that domain. End-to-
end tests remain outside domains because they describe cross-domain product
behavior.

Domain READMEs should be short manuals. They explain what the domain owns, what
it must not own, important runtime classes/capabilities, import cautions,
testing notes, and possible future package extraction. They should not become
implementation checklists or TODO dumps; those belong in `tasks/`.

Test source should move with the domain where practical. Vitest config files may
remain in their current locations when they are mostly Worker/test-harness
wiring or when moving them would create noisy path churn.

App-level D1/sqlfu files remain global under `src/db`. The OS2 domain model
still prefers Durable Objects as the home for most domain state. D1 projections
exist for queryability, routing, cross-object lookup, and browser/API list
views. Using sqlfu inside Durable Objects may be useful later, but it is outside
this refactor.

The first domain refactor does not enforce strict cross-domain dependency rules.
Domain READMEs should still ask maintainers to be careful with imports across
domains. A plausible future step is extracting one or more domains into separate
packages; if that happens, package dependencies will make the allowed dependency
graph explicit.
