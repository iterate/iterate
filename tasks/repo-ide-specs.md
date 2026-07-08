---
status: in-progress
size: small
branch: repo-ide-specs
---

# Tests for the repos mini IDE

## Status summary

Follow-up to `tasks/complete/2026-07-08-repos-mini-ide.md` (PR #1759, merged): the IDE shipped with backend tests but no committed UI regression coverage — every browser flow was verified with ad-hoc gitignored playwright scripts that died with the worktree. This adds the two layers that catch the regression classes we actually hit during development.

## Ask (from Misha)

"do we have playwright tests for it?" → no → "add em"

## Scope

- [ ] Vitest unit tests for the working-tree store (`staged-changes.test.ts`): working/staged slot semantics, the equal-content normalizations, stage/unstage/discard/clearStaged, commitPlan's staged-vs-everything modes, git-status derivation, and localStorage persistence (fake storage): per-oid keying, stale-key sweep, migrateTo.
- [ ] Playwright spec (`specs/repo-ide.spec.ts`) covering the golden path as a readable product spec: open a seeded repo → edit a file (dirty badge + change gutter) → survive a reload (localStorage) → inline diff ("(Working Tree)") → stage → SCM sections + "Commit N staged" → edit-after-stage lands the file in both sections → the staged row opens the readonly "(Index)" pseudo-file → commit → clean state.
- [ ] Run both locally (vitest lane + `pnpm spec` against the auto-started local dev server) and record results.

## Notes

- The playwright spec lane (`specs/*.spec.ts`, root config) does NOT run in Depot CI yet — `ci/playwright-preview-specs` is in flight separately. This spec lands in the local/manual lane and will be picked up by that work; the vitest store test runs in the normal Test CI lane immediately.
- The spec seeds its repo server-side with `connectAdminItx` + `itx.repos.create` (repos are template-seeded on create), so it drives only public product surfaces after that.
- Pierre tree rows are shadow-DOM buttons with `role=treeitem` and aria-labels — playwright role locators pierce shadow DOM, so no coordinate clicking.

## Implementation log

(nothing yet)
