---
status: in-progress
size: large
branch: repo-ide-git-history
---

# Repo IDE: git history view

## Status summary

Spec committed; implementation not started. Planned: a `log` read lane + lazy
`commitDetails` on the repo DO/itx surface, `readFile` pinned to a commit, and
a History view in the repo mini-IDE (commit list → expanded metadata + changed
files with +/- counts → readonly per-file diff vs parent).

## Ask (verbatim, from Misha — spinoff 3 of the repos-mini-ide task)

> **Git history.** Show commits similar to the "Git Graph" vscode extension —
> a list, and an individual commit expanded by clicking (commit metadata +
> changed files with +/- counts; clicking those filepaths opens a readonly
> diff view).

## Design decisions (assumptions marked ⚠️)

### Backend (repo DO + `RepoRpcTarget`)

- **`log({ limit?, branch? })`** → `{ branch, commits: [{ oid, message, author: { name, email }, timestamp, parents }] }`.
  One full single-branch clone (the existing `#checkout` gains a
  `fullHistory` option — its depth-1 clone can't see history) + `git.log`.
  `timestamp` is epoch **milliseconds** (git's seconds × 1000 — JS-idiomatic,
  documented on the type). ⚠️ `limit` defaults to 20.
- **Per-commit file stats are a separate lazy `commitDetails({ commitOid })`,
  not part of `log`.** Justification: stats need a checkout of the commit AND
  its parent plus a content diff of every file — folding that into `log`
  makes a 20-commit list cost ~40 tree walks and reads of every file version
  in one RPC. The list stays one clone + `git.log`; details are fetched per
  commit when a row is expanded, which is exactly the UI's access pattern.
- **`commitDetails({ commitOid, branch? })`** → the commit's `log` entry plus
  `parentOid` (first parent, `null` for the root commit) and
  `files: [{ path, status: "added" | "modified" | "deleted", additions, deletions, binary }]`.
  Implementation: one full clone, `git.checkout` the commit and its parent in
  the same filesystem, walk both trees, line-diff changed files. ⚠️ Merge
  commits diff against the **first parent** (fine in a single-branch world).
- **Line counts** via a small Myers/LCS line diff in `domains/repos`
  (`line-diff.ts`) — additions = new lines − LCS, deletions = old lines −
  LCS, matching `git diff --numstat` shape. No new dependency; unit-tested.
  ⚠️ **Binary files** (NUL byte in the first 8000 bytes, git's heuristic)
  report `binary: true` with 0/0 counts.
- **`readFile` gains `commitOid?`** — a pinned read through the existing
  pinned-checkout path. This is what makes the UI's readonly diff
  (parent-vs-commit content) pure frontend composition over existing
  machinery instead of a bespoke "give me both sides" RPC.

### Codegen

- Regenerate `itx-api.generated.ts` (`pnpm generate:itx-api`),
  `types-source.generated.ts` (`pnpm generate:itx-types-source`), and the
  template `sdk.ts` snapshot (lint codegen preset; the template test compares
  them verbatim). Known gotcha from the parent task: the oxlint
  `codegen/codegen` fix may not fire — run the preset manually via node if
  needed.

### UI (repo mini-IDE)

- **Third activity-strip entry, History** (clock icon), URL param
  `history: boolean` alongside `scm` — the view state stays URL-owned like
  the rest of the IDE (`file`, `diff`, `scm`, `staged`).
- **Commit list** (`log({ limit: 20 })` via `useItxQuery`): first message
  line, relative time (`formatRelativeTime`), author name, short oid.
- **Expanding a commit** sets a `commit: string` URL param (no useState);
  the expanded row lazily fetches `commitDetails` and shows full metadata
  (message, author, date, oid, parent) + changed files with green `+n` /
  red `−n` counts.
- **Clicking a changed file** opens a READONLY diff in the editor pane —
  content at the parent vs at the commit (`readFile({ path, commitOid })`
  both sides), rendered with the same readonly `unifiedMergeView` treatment
  as the staged (`staged=true`) view: lock icon, no chunk controls, editor
  rejects input. Added files diff from empty; deleted files diff to empty.
  ⚠️ Binary files get a "binary file" placeholder pane, not a diff.

### Non-goals (explicit)

- **No graph edges / branch lines** — repos are effectively single-branch, so
  the history is a linear list. The `parents` oids are in the API for a
  future graph, but nothing is drawn.
- No pagination/infinite scroll beyond the `limit` parameter.
- No commit-from-history operations (revert, checkout, reset).

## Checklist

- [ ] Backend: `#checkout` full-history option (keeps the read-your-write retry)
- [ ] Backend: `log` on the repo DO + `RepoRpcTarget` (+ types in `domains/repos/types.ts`)
- [ ] Backend: `commitDetails` with per-file +/- stats
- [ ] Backend: `readFile({ commitOid })` pinned reads
- [ ] Backend: line-diff util + unit tests
- [ ] Backend: e2e test for the new lanes (`*.itx.e2e.test.ts` pattern)
- [ ] Codegen: `itx-api.generated.ts`, `types-source.generated.ts`, template `sdk.ts` snapshot
- [ ] UI: History activity entry + `history`/`commit` URL params
- [ ] UI: commit list + expanded commit with changed files
- [ ] UI: readonly parent↔commit file diff pane
- [ ] Verify live on local dev (commits → history → expand → file diff), screenshots
- [ ] `pnpm typecheck && pnpm lint && pnpm format && pnpm test`

## Implementation log

(running notes appended during implementation)
