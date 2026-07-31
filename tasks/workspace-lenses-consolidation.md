---
state: todo
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
   they mint Docs review links. (Assessed 2026-07-31: ~4 edits;
   `apps/tasks/src/rpc-api.ts:395` is the single line that binds a board to
   a workspace path.)
2. **Guest mode for foreign workspaces.** A lens on a workspace you don't
   own gets read/comment/edit — never Commit or Discard-all (the board's
   commit publishes the mount's ENTIRE dirty set; discard wipes the agent's
   uncommitted work mid-thought). Publishing stays the workspace owner's
   act: you tell the agent to ship.
3. **Extract the repo-IDE components** into the shared package and re-point
   the repo IDE itself at the workspace surface (a repo view is then just a
   lens on any workspace, scoped to that repo's mount).
4. **Retire "checkout".** Delete the dead Y.Doc lane
   (`TasksCheckoutApi`, `checkout-do.ts`, `/c/$checkoutId`,
   `/collab/$checkoutId`; port `assignAgent` to the workspace lane first),
   then replace the checkout index DO with the platform's enumerable
   workspace list — the sidebar becomes "workspaces containing task files
   under this repo", which surfaces agent workspaces in the picker for free.
5. **Branch-targeted commits (separate platform follow-up, tracked here
   until split out).** Today every mount is commit-to-main. The missing
   verb: with several repos mounted and local modifications spread across
   them, commit a chosen subset of one mount's changes to a chosen BRANCH
   of that repo (e.g. `git.commit({ scope, branch, paths? })`), so a jam
   session can end in "these task files → main, that refactor → a draft-PR
   branch". The workspace README already sketches the branch-mode policy
   (draft-PR synthesis on GitHub-linked repos via the Git Database API);
   this extends it from a per-mount policy to a per-commit choice. Also the
   honest answer for "create tasks in the iterate/iterate repo": a commit
   to `/repos/iterate` lands on the project's clone, so the real
   materialization is a branch + PR through the GitHub lane, never
   clone-main.

## Decisions already taken (2026-07-31, Jonas)

- Consolidate around **workspace** as the one noun; apps are lenses.
- A jam session happens in **the agent's own workspace**; humans join as
  guests through lenses (no neutral "session workspace" noun).
- Per-commit branch targeting is wanted, as a separate follow-up from the
  lens consolidation.
