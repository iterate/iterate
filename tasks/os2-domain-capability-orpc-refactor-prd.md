---
state: planned
priority: high
size: large
dependsOn:
  - os2-domain-capability-orpc-refactor-design
---

# OS2 Domain, Capability, and Project oRPC Refactor PRD

## Problem Statement

OS2 is accumulating project-scoped behavior in horizontal folders, legacy
contract shapes, demo-only codemode providers, and persisted POC data models.
That makes it hard to understand where a domain begins, how project identity is
resolved, which APIs codemode should call, and which parts are shared runtime
versus OS2 product behavior.

The current implementation also keeps Project Presets as persisted database
records even though the desired product shape is static authored examples that
compile down to codemode events. Stream operations are partially capability
driven, but the browser-facing oRPC router still reaches around the capability
for some operations. Codemode can call a demo oRPC router, but not the real
project-scoped OS2 API surface.

For this refactor, production-grade polish and backwards compatibility are not
requirements. The goal is a clean POC architecture that is easier to reason
about, easier to test, and strong enough to prove Code Mode working in local
development and a deployed OS2 preview environment. Old paths and old persisted
POC concepts should be replaced directly rather than kept as aliases.

## Solution

Refactor OS2 around explicit domain modules, project-bound capabilities, and a
singular project-scoped oRPC surface.

The public OS2 API should keep collection-oriented project operations under
`os.projects`, and move project-scoped functionality under `os.project`. Every
external `os.project` procedure should accept an explicit `projectSlugOrId`.
The slug is globally unique and curl-friendly; the stable Project ID is used
internally after resolution. Values that look like Project IDs resolve as IDs
first; all other values resolve as global slugs.

Codemode should receive a project-bound view of that same `os.project` router as
`ctx.os`. Codemode callers should not see or pass `projectSlugOrId`. The
codemode oRPC tool provider should inject only the bound stable Project ID,
strip that field from generated tool types, and reject caller attempts to supply
it.

Persisted Project Presets should be deleted entirely. Static Codemode Example
Stacks in source should replace them. Example Stacks should describe provider
inputs, event inputs, and one or more example scripts. The UI should show both
the friendly authoring layer and the raw events that will be appended to a
Codemode Session.

Streams should be namespace-based at the shared runtime boundary. OS2 happens
to use the Project ID as the stream namespace for project-owned streams, but the
shared Stream Durable Object should know only about namespaces and paths. OS2
stream oRPC handlers should validate project access and then call
`StreamsCapability` for listing, creation, append, read, and state. Project
stream listing means all initialized streams that actually exist in the bound
namespace.

The physical OS2 tree should start moving to `domains/*` without moving TanStack
routes, global oRPC wiring, app-level SQL/sqlfu files, or the existing contract
package structure into domains yet.

## User Stories

1. As an OS2 developer, I want project collection APIs separated from
   project-scoped APIs, so that API shape communicates ownership and scope.

2. As an OS2 developer, I want all project-scoped browser/API procedures under
   `os.project`, so that codemode and browser clients use one real API surface.

3. As an OS2 developer, I want `projectSlugOrId` accepted by project-scoped
   APIs, so that manual curl usage can use global slugs and internal callers can
   use stable IDs.

4. As an authenticated OS2 user, I want project slugs in browser URLs, so that
   URLs stay readable while backend code still uses stable Project IDs.

5. As an OS2 developer, I want unauthorized existing projects to return 403 and
   missing projects to return 404, so that auth behavior is explicit.

6. As an OS2 developer, I want project identity resolution in shared oRPC
   middleware, so that handlers do not each implement slug/id parsing and auth.

7. As a codemode script author, I want to call `ctx.os.streams.list({})`, so
   that I can inspect project streams without knowing the Project ID.

8. As a codemode script author, I want to call `ctx.os.codemode.listSessions({})`,
   so that project APIs feel like normal local tools inside codemode.

9. As an OS2 developer, I want codemode `ctx.os` to wrap the real project oRPC
   router, so that codemode does not drift into a special parallel API.

10. As an OS2 developer, I want codemode to reject caller-supplied
    `projectSlugOrId`, so that the project-bound capability cannot be escaped.

11. As a codemode script author, I want generated `ctx.os` type declarations
    with doc comments and output types, so that tool usage is discoverable.

12. As a codemode script author, I want `ctx.os.listProcedures()` to return a
    TypeScript declaration string, so that I can ask the runtime what tools are
    available without inspecting HTTP metadata.

13. As an OS2 developer, I want `ctx.os.listProcedures()` to work at any mount
    path, so that nested provider paths remain possible.

14. As an OS2 developer, I want stream handlers to call `StreamsCapability`, so
    that stream oRPC stays a validation/auth layer in front of trusted runtime
    behavior.

15. As an OS2 developer, I want `StreamsCapability` to support list/create/read/
    append/state operations, so that stream routers do not bypass it for catalog
    work.

16. As an OS2 developer, I want shared streams to use namespace/path language,
    so that the same runtime can support project namespaces and future platform
    namespaces.

17. As an OS2 user, I want the Streams page to list actual project streams, so
    that I can inspect existing streams without a sidebar tree.

18. As an OS2 user, I want Code Mode examples to be static authored stacks, so
    that the POC has useful starter material without persisted presets.

19. As an OS2 user, I want a new Codemode Session form that lets me pick example
    stack events and scripts, so that I can quickly start a useful session.

20. As an OS2 user, I want the Codemode Session UI to show selected raw events,
    so that I can see exactly what will be appended.

21. As an OS2 user, I want to add providers to an existing Codemode Session, so
    that I can extend the session without creating a new one.

22. As an OS2 developer, I want Project Preset database records removed, so that
    there is no stale persisted POC surface.

23. As an OS2 developer, I want preset deletion done through sqlfu, so that
    database state changes follow the repository workflow.

24. As a codemode script author, I want outbound MCP providers under
    `ctx.mcp.<serverName>`, so that external MCP tools have a clear namespace.

25. As a codemode script author, I want public API examples that actually call
    tools and log results, so that examples prove the provider stack works.

26. As an OS2 developer, I want inbound MCP and outbound MCP separated as
    domains, so that OS2-as-server and OS2-as-client are not conflated.

27. As a codemode script author, I want one subagent creation API at
    `ctx.agents.create()`, so that `createSubagent` and `makeSubagent` stop
    being duplicate concepts.

28. As an OS2 developer, I want promise-pipelined live handles preserved, so that
    tool providers can return Durable Object-backed capabilities safely.

29. As an OS2 developer, I want POC repo, workspace, Slack, and agent tool
    provider code moved into domain folders, so that the new structure is
    visible even before those domains become full products.

30. As an OS2 developer, I want every domain folder to have a short README and
    AGENTS symlink, so that humans and agents get the same local guidance.

31. As an OS2 developer, I want Worker entrypoint files to mostly re-export
    domain-owned runtime classes, so that runtime ownership sits with the
    domain.

32. As an OS2 developer, I want routes and global oRPC wiring to remain outside
    domains for now, so that the first refactor stays small enough to land.

33. As an OS2 developer, I want local Miniflare and preview verification, so
    that the POC is proven in both development and deployed preview.

34. As an OS2 developer, I want existing OS2 and Events smoke tests to keep
    working, so that the stream runtime refactor does not regress the demo apps.

## Implementation Decisions

- This is a clean POC refactor. Backwards compatibility with old persisted
  presets, old oRPC paths, old codemode examples, and old local Miniflare state
  is not required.

- Keep `os.projects` for project collection, discovery, and lifecycle actions.
  Add `os.project` for all project-scoped functionality.

- Move codemode sessions, inbound MCP server sessions, and streams under
  `os.project`.

- Every external project-scoped procedure accepts `projectSlugOrId`. The value
  can be a globally unique Project Slug or a stable Project ID.

- Resolve `projectSlugOrId` once in project scope middleware. Downstream
  handlers should operate on the resolved Project and its stable ID.

- Resolve ID-shaped inputs as stable Project IDs first. Resolve all other inputs
  as globally unique Project Slugs. If an unlikely collision exists, Project ID
  wins.

- Return 404 for a project that does not exist. Return 403 for a project that
  exists but the authenticated Clerk user cannot access.

- Keep Clerk's current organization/session integration for now. Do not attempt
  a broader Clerk auth rewrite in this PRD.

- Project-scoped auth should be context-based rather than hardwired directly to
  browser Clerk objects. Browser/API requests populate context from Clerk and
  the database. Codemode builds an internal project-bound context so the same
  router can be called in-process.

- Keep the contract package structurally as-is. Modify it only enough to expose
  the new `os.project` API shape and remove Project Presets.

- Keep normal oRPC routers and oRPC transport wiring outside domains in this
  first pass.

- Keep TanStack route files outside domains. Domains may own reusable
  components, not page routes.

- Keep app-level SQL/sqlfu definitions, generated queries, and migrations in
  the global database area.

- Use sqlfu to delete the Project Presets table and generated query surface.
  Do not hand-write migrations.

- Delete Project Preset CRUD, route links, route files, UI selects, project
  creation seeding, generated queries, contract types, and tests that only
  exist for persisted presets.

- Replace persisted presets with static Codemode Example Stacks in source.
  Example Stacks are authored UI/input objects, not runtime state.

- Example Stacks contain provider inputs, event inputs, and multiple scripts.
  Provider inputs compile down to concrete Event Inputs before Codemode Session
  runtime receives them.

- Codemode Session Durable Objects receive events, not Example Stack references.

- Browser-created Codemode Sessions should default to a smaller provider set,
  while inbound MCP `run_code` may use the richest available example/provider
  stack for exploration.

- Outbound MCP providers are configured through Example Stacks in this refactor.
  They are not implicitly added to every session.

- Use `ctx.mcp.<serverName>` for outbound MCP providers. Cloudflare Docs should
  be the first configured public MCP example.

- Consolidate subagent creation to `ctx.agents.create()`. Remove
  `ctx.createSubagent()` and `ctx.makeSubagent()`.

- Preserve Workers RPC promise pipelining when returning live tool handles.

- Treat `OrpcCapability` as a Codemode domain tool provider adapter. It should
  wrap the real project-scoped oRPC router in-process.

- Do not create a separate codemode-only oRPC router.

- Do not call HTTP back into the Worker from `OrpcCapability`.

- Expose all procedures under the real `os.project` subtree as `ctx.os.*`, with
  the `project` layer skipped.

- Inject the stable Project ID into oRPC calls as `projectSlugOrId`.

- Reject caller-supplied `projectSlugOrId` before injection.

- Codemode's internal project access context should accept only the injected
  stable Project ID. If any other project identity reaches that internal access
  path, throw.

- Assume oRPC procedure inputs are object-shaped. Treat omitted input as an
  empty object. Throw for positional or non-object input.

- Strip `projectSlugOrId` from generated codemode input schemas, type
  declarations, listings, and instructions.

- Preserve output schemas and output type declarations where available.

- `ctx.os.listProcedures()` should return only a generated TypeScript
  declaration string for the provider mounted at its actual codemode path.

- `ctx.os.listProcedures()` itself should be included in the generated
  declaration.

- Stream oRPC handlers should call `StreamsCapability` for list, create, append,
  read, and state operations.

- Add catalog-backed stream listing to `StreamsCapability` if needed. For this
  POC, `streams.list` means all initialized streams that actually exist in the
  current project namespace. Future filtering or limiting can be added through
  capability props rather than changing the basic API meaning.

- Hide project identity from project-bound codemode stream inputs. Decide during
  implementation whether project namespace should also be hidden from
  project-bound stream outputs; the POC should prefer hiding it unless the UI
  needs it.

- Keep shared stream runtime namespace/path based and Project-agnostic.

- Create `domains/*` folders for codemode, projects, streams, agents, repos,
  workspaces, Slack, inbound MCP server, and outbound MCP client.

- Move the clearest Durable Object classes, WorkerEntrypoint capability classes,
  processors, reusable components, local utilities, and local tests into their
  domain folders.

- Do not add domain barrel files. Import concrete domain files.

- Each domain folder must have a short README and an AGENTS symlink to that
  README.

- Domain READMEs should say that most durable state should live in Durable
  Objects where practical, and that cross-domain imports deserve care because
  domains may later become separate packages.

## Testing Decisions

- Tests should verify external behavior rather than private folder structure.
  Folder movement should be covered indirectly by typecheck, runtime tests, and
  smoke tests.

- Add or update contract/router tests for the `os.project` shape, especially
  slug/id resolution and 403 versus 404 behavior.

- Add or update codemode runtime tests proving that `ctx.os.*` calls dispatch to
  the real project oRPC router, inject the bound Project ID, and reject
  caller-supplied `projectSlugOrId`.

- Add type-generation tests for the codemode oRPC provider proving that
  `projectSlugOrId` is stripped from inputs, output schemas are preserved, and
  nested mount paths generate declarations at the right context key.

- Add or update stream tests proving project stream listing goes through
  `StreamsCapability` and returns initialized streams in the bound namespace.

- Add or update codemode example tests proving Example Stacks compile provider
  inputs and authored events into concrete Event Inputs.

- Add or update tests for `ctx.agents.create()` preserving promise-pipelined
  live handle calls.

- Update inbound MCP tests to use the new richest provider stack and
  `ctx.mcp.<serverName>` naming.

- Update UI tests or smoke flows that currently depend on the Project Presets
  route or preset select.

- Existing OS2 e2e tests should continue working after the refactor.

- Existing Events e2e tests should continue working after the shared stream
  runtime and namespace changes.

- Existing manual smoke tests against OS2 and Events should continue working.

- Local verification must include Miniflare/local dev proof for OS2 Code Mode
  and project streams.

- Preview verification must include an authenticated Clerk browser login flow
  using the documented test-token process, plus a Code Mode run that calls
  `ctx.os.streams.list({})` and at least one non-stream project API.

## Out of Scope

- Production-grade migration compatibility for Project Presets.

- Preserving old oRPC paths under aliases.

- A broader Clerk integration redesign.

- Moving TanStack route files into domains.

- Moving normal oRPC routers into domains in the first pass.

- Moving app-level SQL/sqlfu files into domains.

- Splitting OS2 domains into separate packages.

- Restructuring the contract package beyond the required API shape changes.

- Building a full product surface for repos, workspaces, agents, Slack, secrets,
  or MCP configuration.

- Solving MCP tool/provider naming collisions.

- Adding a Codemode Session capability abstraction; codemode oRPC handlers can
  keep using Codemode Session Durable Object handles directly for now.

## Further Notes

This PRD is backed by the collaborative design spec in the sibling design task.
That document contains the deeper implementation notes and examples.

The codebase review found several gaps that implementation should treat as
expected work, not surprises:

- The current codemode oRPC provider is still demo-scoped. It exposes a test
  router, returns procedure metadata plus type definitions, and does not inject
  or strip project identity.

- The current oRPC contract shape is still split across top-level codemode
  procedures and plural project subrouters. There is not yet a singular
  `os.project` tree.

- Current project access code resolves stable Project IDs, not global slugs, and
  currently hides unauthorized projects as not found.

- The target project middleware should use a context-level project access
  service/capability so browser callers and codemode's internal server-side
  caller can share the same `os.project` router.

- Current stream project routers still bypass `StreamsCapability` for catalog
  and direct stream operations. The capability needs a namespace-wide list path.

- Current default codemode provider registrations, example provider
  registrations, and inbound MCP provider stacks are separate. Implementation
  should make the intended ownership of `ctx.os`, `ctx.agents.create()`, and
  `ctx.mcp.cloudflareDocs` explicit.

- Current Project Presets touch contract types, route files, sidebar links,
  generated SQL/query assets, schema definitions, project creation seeding, and
  test bootstrap code.

- Current examples have a single script/code field and a provider-set concept.
  They need to become Example Stacks with multiple scripts, explicit provider
  inputs, and raw event inputs.

- Current outbound MCP examples still use `ctx.integrations.publicMcp` in some
  places. They should migrate to `ctx.mcp.<serverName>`.

- Current subagent examples and tests use both `ctx.createSubagent()` and
  `ctx.makeSubagent()`. They should converge on `ctx.agents.create()` without
  losing Workers RPC promise pipelining.

The implementation may reset local Miniflare state and preview database state if
that is the simplest path to a clean POC.
