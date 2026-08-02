---
state: in-progress
priority: high
size: large
tags: [os, workspaces, tasks-app, docs-app, repo-ide, architecture]
---

# Consolidate Docs / Tasks / repo IDE into lenses on workspaces

Follow-up from the workspace namespace revamp (PR #2373) and the 2026-07-31
jam-flow discussion with Jonas. Now that a workspace is a private working
copy of the project's one path namespace (every repo auto-mounted at its own
`/repos/**` path, private files under the workspace's own path), the apps
that render files should stop owning file concepts and become **lenses on a
workspace**:

- **Docs app** — already a lens: `(workspace, file)` in the URL, comments and
  edits write into that workspace, no nouns of its own. The model to copy.
- **Tasks app** — almost a lens: a board is really `(workspace, repo scope)`,
  but hides it behind "checkout", a client-minted random id whose only
  remaining job is naming a throwaway workspace
  (`apps/tasks/src/lib/checkout-shared.ts` — `checkoutWorkspacePath`,
  `newCheckoutId`). With derived mounts those minted workspaces buy nothing:
  `/repos/config/tasks/**` resolves identically in every workspace.
- **Repo IDE** (`apps/os/src/components/repo-ide/`) — the richest file UI we
  have (file tree, editor pane with change gutter, staged-changes model,
  commit diff pane, commit history, markdown frontmatter + HTML preview,
  TypeScript vfs/diagnostics) but bound directly to a REPO, so it cannot show
  a workspace's uncommitted overlay at all.

## Goal

One shared vocabulary: **a workspace is the collaboration surface; every
file UI is a lens over it.** Extract the reusable repo-IDE components
(file tree, editor pane + change gutter, staged-changes/commit controls,
diff + history panes, previews) into a shared package alongside the pieces
Docs/Tasks already share (`@iterate-com/workspace-documents`: comments,
identity, collab), parameterized by the workspace fs surface
(readFile/readFiles/glob/status/readBase/collab) instead of repo RPCs. Then:

- Docs app = the document lens (single file + annotated-markdown comments).
- Tasks app = the board lens (`(workspace, repo)`; glob `**/tasks/**/*.md`).
- Repo IDE = the tree/editor lens — pointed at a workspace it gains
  uncommitted-overlay display for free (`status` + `readBase` already exist).

## Work items

1. **Tasks app addresses `(workspacePath, repoPath)`.** New door
   `workspaceAt(workspacePath, repoPath)` next to the checkout one (no
   lazy-create, no checkout-index announce — mirror the Docs app's
   plain-`get` posture), route accepts `?workspace=`, and a
   `tasks.link({ workspace, repo, task? })` config-bridge RPC + template
   getter + one agent-prompt line so agents can mint board links the way
   they mint Docs review links.
   **DONE 2026-07-31**: `workspaceAt` door + `/w?workspace=` route (`/w/$id`
   stays for the app's own boards), `TasksAppRpcTarget.link` in the tasks
   config bridge, `get tasks()` in the config-repo template, one prompt line
   (budget ceiling 4100 → 4150, argued in the PR).
2. **Guest mode for foreign workspaces.** A lens on a workspace you don't
   own gets read/comment/edit — never Commit or Discard-all (the board's
   commit publishes the mount's ENTIRE dirty set; discard wipes the agent's
   uncommitted work mid-thought). Publishing stays the workspace owner's
   act: you tell the agent to ship.
   **DONE 2026-07-31**: ownership = path shape (nothing durable records an
   owner; the platform's `workspace/created` payload is empty). The app owns
   only its own `/workspaces/tasks/` naming; every other workspace is a
   guest lens — Commit/Discard-all/Assign-agent hidden in the UI AND refused
   at the vessel door.
3. **Extract the repo-IDE components** into the shared package and re-point
   the repo IDE itself at the workspace surface (a repo view is then just a
   lens on any workspace, scoped to that repo's mount). Scoped by the
   2026-07-31 /goal below: the tree + diff viewer are the pieces to extract
   first, into the combined app's shell.
4. **Retire "checkout".** Delete the dead Y.Doc lane
   (`TasksCheckoutApi`, `checkout-do.ts`, `/c/$checkoutId`,
   `/collab/$checkoutId`; port `assignAgent` to the workspace lane first),
   then replace the checkout index DO with the platform's enumerable
   workspace list.
   **DONE 2026-07-31**: `assignAgent` ported to `TasksWorkspaceApi` (owner
   act), Y.Doc lane + `/yjs` upgrade + both DOs deleted (tombstoned in
   wrangler.jsonc), sidebar/home list workspaces via `streams.list()`
   filtered to `/workspaces/**` (board paths parse back via the embedded
   repo hash; agent workspaces appear as guest lenses).
5. **Branch-targeted commits** — split out to
   [workspace-branch-targeted-commits](workspace-branch-targeted-commits.md)
   (separate platform follow-up; not part of the lens work).

## Decisions already taken (2026-07-31, Jonas)

- Consolidate around **workspace** as the one noun; apps are lenses.
- A jam session happens in **the agent's own workspace**; humans join as
  guests through lenses (no neutral "session workspace" noun).
- Per-commit branch targeting is wanted, as a separate follow-up from the
  lens consolidation.

## Direction update (2026-07-31, Jonas via /goal)

Docs and Tasks should ultimately combine into ONE app whose top-level noun
is the workspace:

- At the highest level you select a workspace path (or make a new one).
- In a workspace you see all the repos (main branch, via the derived
  mounts) plus the workspace's own non-repo files; unsaved changes can span
  multiple repos; committing a repo commits that mount's changes to main.
- A pierre-style tree viewer explores all files (reuse the apps/os repo-IDE
  tree and diff viewer — the item-3 extraction feeds this).
- The doc editor and the kanban tasks view are just VIEWS on that data.
- The viewer can be constrained to a root folder (e.g. `/repos/config`) to
  mimic today's tasks app.

The item-1/2/4 work above is the substrate (workspace addressing, guest
posture, workspace enumeration, no app-owned storage); the combined app
grows from apps/tasks. Remaining: the workspace-level tree + file views
(item 3's extraction), folding the Docs single-document view in, and then
retiring apps/docs behind a link redirect.

## Platform follow-up: a real `workspaces.list()`

The picker currently enumerates via `streams.list()` filtered to
`/workspaces/**`, pruning entries that are strict path-prefixes of others
(ancestor-announcement phantoms — verified on prd 2026-07-31: a nested
agent workspace drags 3 never-created ancestor streams into the catalog).
The honest fix is the sandbox pattern: teach the project reducer
`workspace/created` (via `recordDomainObject`, like repos/secrets/devices)
and add `itx.workspaces.list()`; then the vessel filter and the prefix
heuristic both delete.
