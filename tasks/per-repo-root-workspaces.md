---
state: done
priority: medium
size: large
tags: [os, repos, workspaces, architecture, performance]
---

# Per-repo root workspaces (fast HEAD reads for every repo)

> **Done — superseded by the durable head-tree cache inside `RepoDurableObject`
> itself** (PR #2095): every repo now materializes its default-branch tree into
> its own DO SQLite (R2 spill), invalidated by the local head cursor, so
> `readFile`/`listFiles`/`listTaskFiles` at HEAD are clone-free for EVERY repo
> — no separate cache workspace needed, and the cross-DO re-entrant `getHead`
> dance this task worried about never exists. The lazy per-object Artifacts
> read layer remains the longer-term successor for repos too large to
> materialize at all.

Today only the project's config repo (`/repos/config`) gets fast HEAD reads.
Every other repo — secondary `/repos/**`, per-example scratch repos, legacy
projectId-less repos — falls back to the clone lane: **every `readFile` /
`listFiles` clones the whole repo fresh**. On a large repo (e.g.
`iterate/iterate`) that is slow, and firing several concurrent reads at one
`RepoDurableObject` overloads it ("Durable Object is overloaded. Requests
queued for too long.").

The tasks board already sidesteps this with a single task-masked clone
(`listTaskFiles`, added in the PR this task spun out of), but the underlying
asymmetry remains: **the file tree, editor, and every other HEAD read on a
non-config repo still clone per read.**

## The idea

Generalize the "root workspace" from a per-project singleton mirroring the
config repo into a **per-repo** always-fresh, read-only mirror. Then all HEAD
reads on any repo serve from the fast workspace cache: a cheap head-cursor
check (`getHead()` — one KV read), re-cloning only when that repo's `main`
actually advances.

The machinery already exists and is ~90% there:

- `WorkspaceCore` (`apps/os/src/domains/workspaces/workspace-core.ts`) is
  host-agnostic and takes its repo as an injected `RepoAccess` dependency — it
  is **not** tied to the config repo. Root mode already does pull-on-read
  freshness (`#ensureFreshRoot` / `#materializeRoot`) with a head cursor and
  retries against the eventually-consistent Artifacts remote.
- Storage is DO-SQLite with transparent R2 spillover for files >1.5MB
  (`workspace-durable-object.ts`).

Only three wiring points bind it to one repo:

1. `ROOT_WORKSPACE_PATH = "/workspaces"` — a single fixed workspace name per
   project (`domains/workspaces/utils.ts`).
2. `WorkspaceDurableObject.#projectRepoStub()` hard-codes `CONFIG_REPO_PATH`
   (`workspace-durable-object.ts:89-96`).
3. `RepoDurableObject.#hasRootWorkspaceCache()` returns true only for
   `path === CONFIG_REPO_PATH`, and `#rootWorkspaceStub()` names that single
   root (`repo-durable-object.ts` ~549-560).

## Sketch

- Introduce a per-repo root workspace address, e.g.
  `/workspaces/repos/iterate` running in `mode: "root"`, that derives **which
  repo it mirrors from its own name** rather than the hard-coded
  `CONFIG_REPO_PATH`. Root-mode detection (`isRootWorkspacePath`) needs to
  recognize these repo-root workspaces.
- `RepoDurableObject`: `#hasRootWorkspaceCache()` returns true for any real
  repo (see "Open questions" re: scratch/legacy repos); `#rootWorkspaceStub()`
  names the repo-scoped workspace.
- Then `readFile` / `listFiles` / `listTaskFiles` all serve from the per-repo
  workspace: cheap head-check, re-clone only on advance. The per-read clone
  lane disappears for HEAD reads. `listFiles` can also stop reading every
  file's content just to return paths (it currently does — wasteful) by using
  the workspace's `listAllFiles()`.

## Open questions / risks

- **Storage footprint.** A repo-root workspace materializes that repo's entire
  working tree into per-project DO storage (+R2 spill). The config repo is
  small; mirroring a full monorepo per project is a much heavier standing
  footprint. This is the main reason it wasn't simply switched on. Consider:
  lazy/opt-in per repo, an LRU/eviction policy, or a size ceiling above which a
  repo stays on the clone lane.
- **Freshness for GitHub-backed repos (correctness precondition).** The head
  cursor trusts the repo DO's `getHead()` cache. Verify that cache updates when
  `main` advances via a **GitHub-webhook-driven push / `syncFromGithub`**, not
  only via in-app `commitFiles` / `edit`. If a GitHub push can move HEAD
  without updating the cache, a per-repo root workspace would serve stale
  content. This must be confirmed (and fixed if needed) before relying on it.
- **Overlay hierarchy.** Agent overlays currently fall through to the single
  project root (config repo). Per-repo roots don't affect the tasks/file-tree
  read path (which reads a root workspace directly), but if we ever want agent
  overlays over a secondary repo, the fall-through/routing needs a path->parent
  mapping. Out of scope unless needed.
- **Scratch / legacy repos.** Decide which repos are worth a standing
  workspace. projectId-less legacy repos and short-lived per-example scratch
  repos may be better left on the clone lane.

## Acceptance

- HEAD reads (`readFile`, `listFiles`, `listTaskFiles`) on a non-config repo
  serve from an always-fresh per-repo workspace: no clone in steady state, a
  re-clone only when that repo's `main` advances.
- Loading the tasks board / file tree for a large repo like `iterate/iterate`
  no longer overloads the `RepoDurableObject`.
- `listFiles` no longer reads every file's content just to return paths.
- GitHub-webhook / `syncFromGithub` HEAD advances are reflected by the per-repo
  workspace (freshness precondition verified, with a test).
- A clear, documented policy for which repos get a standing workspace and how
  storage is bounded (opt-in, ceiling, and/or eviction).
