---
status: done
size: large
branch: repo-ide-git-history
---

# Repo IDE: git history view

## Status summary

Done (PR #1769). Review round handled: history invalidation on commit,
pinned-read retry, honest numstat docs, depth-limited clones; merged main
twice (IDE GitHub panel #1763 landed alongside — both activity-strip features
coexist). Backend: `log`,
`commitDetails` (+/- stats via a dependency-free Myers line diff) and
`readFile({ commitOid })` on the repo DO + itx surface, with unit + e2e tests
and all three generated artifacts refreshed. UI: History activity entry in the
mini-IDE with commit list, expandable rows, and readonly parent-vs-commit file
diffs. Verified on local dev via Playwright (screenshots in the PR); e2e suite
passes against the dev server. Remaining: none in scope — follow-ups listed at
the bottom.

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

- [x] Backend: `#checkout` full-history option (keeps the read-your-write retry) — _`fullHistory` skips the depth-1 clone; #checkout now also returns its `git` handle and resolved branch_
- [x] Backend: `log` on the repo DO + `RepoRpcTarget` (+ types in `domains/repos/types.ts`) — _`RepoLogCommit`/`RepoLogResult`; limit validated 1–200, default 20_
- [x] Backend: `commitDetails` with per-file +/- stats — _two `git.checkout({ ref, force })`s inside one clone, tree walk to path→bytes maps, `diffFileMaps` for stats_
- [x] Backend: `readFile({ commitOid })` pinned reads — _threads through both encoding lanes to the existing pinned-checkout path; oid validated as full 40-hex sha_
- [x] Backend: line-diff util + unit tests — _`line-diff.ts` (Myers O(ND), prefix/suffix trim, 4000-line rewrite fallback, NUL-byte binary sniff); `line-diff.test.ts` covers numstat parity, trailing newlines, minimal counts, binary, root-commit shape_
- [x] Backend: e2e test for the new lanes (`*.itx.e2e.test.ts` pattern) — _`repo-history.itx.e2e.test.ts`: 3 commits then log order/limit/parents/epoch-ms, commitDetails modify+binary-add / delete / root commit, pinned reads at each oid, validation errors; passes against local dev_
- [x] Codegen: `itx-api.generated.ts`, `types-source.generated.ts`, template `sdk.ts` snapshot — _generate:itx-api + generate:itx-types-source; the sdk.ts copy preset again did NOT fire via `pnpm lint --fix` (same gotcha as the parent task) — copied between the markers via node; template snapshot test green_
- [x] UI: History activity entry + `history`/`commit` URL params — _third button in `repo-ide.tsx`; params validated in the `$.tsx` route search schema; Files/SCM buttons clear history state_
- [x] UI: commit list + expanded commit with changed files — _`commit-history-panel.tsx`; expansion is the URL-owned `commit` param (no useState); details via lazy `useItxQuery` keyed by oid only (immutable) in a per-row Suspense_
- [x] UI: readonly parent↔commit file diff pane — _`commit-diff-pane.tsx`: readonly `unifiedMergeView` over two pinned `readFile` reads, same lock/no-controls treatment as the staged view; binary placeholder; FileChrome/EmptyPane exported from repo-editor-pane for shared chrome_
- [x] Verify live on local dev (commits → history → expand → file diff), screenshots — _seeded `/repos/demo` in the `test` project with 4 commits via `pnpm cli itx run`; Playwright walkthrough covered list, expand (+6/−0, +3/−1 counts), modified/deleted diffs, binary pane, root commit, back-to-Files; screenshots in the PR_
- [x] `pnpm typecheck && pnpm lint && pnpm format && pnpm test` — _all green (588 unit tests incl. template snapshot)_

## Implementation log

- `git.log({ ref })` exists in the `@cloudflare/shell` wrapper, but
  `commitDetails` finds the commit by walking the full log instead — one
  code path shared with `log`, repos are small, and an oid missing from the
  branch produces a friendly error rather than ref-resolution weirdness.
- The two per-commit checkouts run inside one clone (`InMemoryFs` reused), so
  details cost zero extra network fetches after the clone.
- The oxlint `codegen/codegen` copy preset for template `sdk.ts` still does
  not fire under `pnpm lint --fix` — third confirmation of the parent task's
  gotcha. Manual node copy between the markers;
  `project-repo-template.test.ts` is the deterministic guard.
- Live verification: `pnpm dev start --detach` in the worktree, `pnpm getin`
  identity recipe, commits seeded through the itx CLI (also live-verified
  `log`/`commitDetails` JSON on the way), Playwright for the UI walkthrough
  since the Chrome extension was not connected.
- Review round (all four threads resolved with 🤖 replies): commit now
  invalidates the repo-log query; the pinned-oid `#checkout` path shares the
  read-your-write retry (retryable only while the clone is behind the
  recorded push); line-diff docs state the deliberate trailing-newline
  divergence from git instead of claiming numstat parity; `log` clones
  depth-limited (isomorphic-git stops its walk at `.git/shallow` — verified
  in the vendored 1.37.6 source) and `commitDetails` resolves its oid as a
  ref instead of walking the whole history.
- Merged origin/main twice (IDE GitHub panel #1763 + stream-event path
  change) — `gh` and `history`/`commit` params coexist; generated artifacts
  regenerated on the merged sources each time; post-merge Playwright smoke
  confirmed all four activity views work side by side.

## Follow-ups deliberately out of scope

- Commit list pagination / "load more" past the first 50 in the UI.
- `commitDetails` on merge commits diffs first-parent only; combined diffs
  (à la GitHub's merge view) would need a design decision.
- No commit operations (revert / checkout / reset) from the history view.
- Rename detection (git-style similarity) — renames read as delete + add.
- A controllable fake git remote seam for the repo DO, so the
  eventual-consistency retry paths (branch-head AND pinned-oid) become unit
  testable — both currently rely on the live Artifacts remote.
