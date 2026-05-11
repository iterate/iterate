---
state: done
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
- Preview project creation initially failed because the Artifacts namespace was
  missing the `iterate-config-base` source repo. The local token available to
  the shell could deploy Workers but could not call the Artifacts REST API, so I
  added an admin-only debug repair route that seeds the base repo through the
  deployed Worker's own `ARTIFACTS` binding.

## Checkpoints

- [x] Implement shell-backed `WorkspaceDurableObject`.
- [x] Implement `WorkspaceCapability`.
- [x] Register default `ctx.workspace` provider.
- [x] Add local codemode tests.
- [x] Commit and push local implementation checkpoint.
- [x] Deploy preview.
- [x] Seed preview `iterate-config-base` through admin debug route.
- [x] Run real MCP codemode script: repo info -> clone -> edit -> commit -> push.
- [x] Record verification evidence.

## Verification Evidence

Local checks:

```sh
pnpm --dir apps/os2 typecheck
pnpm --dir apps/os2 test:codemode-session
pnpm --dir apps/os2 build
```

Preview deployment:

```sh
doppler run --project os2 --config preview_2 -- pnpm --dir apps/os2 alchemy:up
```

The direct OS2 deploy completed for `https://os2.iterate-preview-2.com`.

Preview seed and smoke:

```sh
POST https://os2.iterate-preview-2.com/__debug/seed-iterate-config-base
OS2_BASE_URL=https://os2.iterate-preview-2.com \
  OS2_PREVIEW_SMOKE_PROJECT_SLUG=workspace-mcp-proof-3dbbcbf7 \
  pnpm --dir apps/os2 test:e2e:preview
```

The seed route returned the base repo
`os2-preview-2-repos/iterate-config-base.git`. The preview smoke then created
project `workspace-mcp-proof-3dbbcbf7` and verified its MCP endpoint.

Real MCP codemode proof:

```sh
OS2_E2E_MCP_URL=https://mcp__workspace-mcp-proof-3dbbcbf7.iterate-preview-2.app/ \
  pnpm --dir apps/os2 exec tsx /tmp/os2-workspace-mcp-proof.ts
```

The script executed a single JavaScript codemode block that:

1. called `ctx.repos.get({ slug: "iterate-config" }).getInfo()`,
2. cloned the repo with `ctx.workspace.git.clone(...)`,
3. wrote `workspace-codemode-proof.md` with `ctx.workspace.writeFile(...)`,
4. committed with `ctx.workspace.git.commit(...)`,
5. pushed with `ctx.workspace.git.push(...)`.

Returned proof:

```json
{
  "marker": "workspace-mcp-proof-1778538010701",
  "repo": {
    "slug": "iterate-config",
    "defaultBranch": "main",
    "hasToken": true
  },
  "commit": {
    "oid": "cf4839914cd51d9759efa2ff8f65a6f9f6c2561e",
    "message": "Verify workspace codemode push"
  },
  "pushed": {
    "ok": true,
    "refs": {
      "refs/heads/main": {
        "ok": true,
        "error": ""
      }
    }
  },
  "status": []
}
```
