---
state: doing
priority: high
size: large
dependsOn: [repos-vertical-slice]
---

# Workspace Codemode Implementation Log

## Goal

Implement a basic OS2 Workspace Durable Object and Workspace Capability so a
real preview MCP codemode session can use a simple JavaScript block to:

1. read the Project's Iterate Config Repo Git details,
2. clone that repo into `ctx.workspace.git.clone(...)`,
3. edit files through `ctx.workspace.*`,
4. commit and push the change back to the Iterate Config Repo.

## Plan

1. Follow the Repos Artifacts slice shape: structured Durable Object identity,
   WorkerEntrypoint capability, default codemode provider registration, and
   focused DO/codemode tests.
2. Keep Workspace identity project-scoped: `{ projectId, workspaceId }`.
3. Use `@cloudflare/shell` directly:
   - `ctx.workspace.*` maps to `createWorkspaceStateBackend(workspace)`.
   - `ctx.workspace.git.*` maps to `createGit(new WorkspaceFileSystem(workspace))`.
4. Let `WorkspaceDurableObject` expose raw shell objects from public methods:
   - `cloudflareShellState()`
   - `cloudflareShellGit()`
5. Put codemode syntax/path adaptation in `WorkspaceCapability`, not in the DO.
6. Always register the default `ctx.workspace` provider when creating codemode
   session startup events.
7. Verify locally with workerd-backed codemode tests, then deploy/verify against
   a real preview MCP codemode session.

## Decisions

- A Workspace is not a Project, Clerk Organization, Agent, or Codemode Session.
  It is a project-scoped file work surface addressed by `projectId` and
  `workspaceId`.
- The default codemode session workspace ID can be derived from the codemode
  stream path for now. This avoids a new allocation table or lifecycle event.
- The raw `createGit(...)` and shell state objects can be returned across
  Workers RPC. A throwaway `/tmp` experiment proved plain returned objects with
  async methods and raw `createGit(...)` objects are callable across a Durable
  Object RPC boundary; plain class instances are not.
- `WorkspaceCapability` is the codemode tool provider. `WorkspaceDurableObject`
  is the durable resource and should not know about codemode paths.

## Difficulties

- `@cloudflare/shell` exposes many state and Git methods. Manually retyping the
  whole API would drift and undermine the reason to depend on the package.
- Codemode wants ergonomic syntax (`ctx.workspace.git.push(...)`), while the DO
  should expose reusable shell-backed handles. The capability bridges that
  syntax to the shell objects.
- Final verification requires a deployed preview MCP session and a real
  Cloudflare Artifacts-backed Iterate Config Repo, so local tests are necessary
  but not sufficient.

## Checkpoints

- [ ] Implement shell-backed `WorkspaceDurableObject`.
- [ ] Implement `WorkspaceCapability`.
- [ ] Register default `ctx.workspace` provider.
- [ ] Add local codemode tests.
- [ ] Commit and push local implementation checkpoint.
- [ ] Deploy preview.
- [ ] Run real MCP codemode script: repo info -> clone -> edit -> commit -> push.
- [ ] Record verification evidence.
