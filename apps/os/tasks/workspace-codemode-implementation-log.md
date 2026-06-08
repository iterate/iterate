---
state: done
priority: high
size: large
dependsOn: [repos-vertical-slice]
---

# Workspace Codemode Implementation Log

## Goal

Implement a basic OS Workspace Durable Object and Workspace Capability so a
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
4. Let `WorkspaceDurableObject` expose shell-backed RPC targets from public methods:
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
- The raw `createGit(...)` object can be returned across Workers RPC. Shell
  state is exposed as a plain method object because plain returned objects with
  async methods cross the Durable Object RPC boundary, while class instances do
  not.
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
- Preview project creation can fail if the Artifacts namespace is missing the
  `iterate-config-base` source repo. The checked-in
  `artifacts:seed-config-base` script is the intended repair path; the deployed
  worker no longer exposes a seed/debug route.
- Cloudflare Artifacts write token TTLs must be at most 31,536,000 seconds. The
  repo write-token TTL is set to one year so project `iterate-config` creation
  and preview proofs can create tokens successfully.

## Checkpoints

- [x] Implement shell-backed `WorkspaceDurableObject`.
- [x] Implement `WorkspaceCapability`.
- [x] Register default `ctx.workspace` provider.
- [x] Add local codemode tests.
- [x] Commit and push local implementation checkpoint.
- [x] Deploy preview.
- [x] Add checked-in preview example script for repo info -> clone -> edit -> commit -> push.
- [x] Run real MCP codemode preview example against preview_2.
- [x] Record verification evidence.

## Verification Evidence

Local checks:

```sh
pnpm --dir apps/os typecheck
pnpm --dir apps/os test:codemode-session
pnpm --dir apps/os build
```

Preview deployment:

```sh
doppler run --project os --config preview_2 -- pnpm --dir apps/os alchemy:up
```

The direct OS deploy completed for `https://os.iterate-preview-2.com`.

Preview smoke:

```sh
OS_BASE_URL=https://os.iterate-preview-2.com \
  OS_PREVIEW_SMOKE_PROJECT_SLUG=workspace-mcp-proof-3dbbcbf7 \
  pnpm --dir apps/os test:e2e:preview
```

The preview smoke created project `workspace-mcp-proof-3dbbcbf7` and verified
its MCP endpoint.

Checked-in preview example:

```sh
doppler run --project os --config preview_2 -- \
  pnpm --dir apps/os example:workspace-codemode-preview
```

The example creates a fresh preview project, connects to its MCP endpoint, and
runs one `exec_js` block with the default workspace provider plus the static
inbound MCP provider stack already loaded.

Real MCP codemode proof:

```sh
OS_E2E_MCP_URL=https://mcp.iterate-preview-2.com/ \
  pnpm --dir apps/os exec tsx /tmp/os-workspace-mcp-proof.ts
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

Latest checked-in preview example proof:

```json
{
  "project": {
    "id": "proj__os__01krddypaae4db1f8fqzcy79et",
    "slug": "workspace-codemode-example-1778567303786"
  },
  "result": {
    "commit": {
      "oid": "a2566ada2b6a2f038a43418d4b18985cb8a0256f",
      "message": "Verify workspace codemode preview example"
    },
    "fileName": "workspace-preview-example-1778567326606.md",
    "pushed": {
      "ok": true
    },
    "repo": {
      "slug": "iterate-config",
      "defaultBranch": "main"
    },
    "status": []
  }
}
```
