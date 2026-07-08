---
status: done
size: small
branch: repo-ide-specs
---

# Tests for the repos mini IDE

## Status summary

Done: 11 vitest store tests + a passing golden-path playwright spec, plus a small product a11y fix the spec surfaced (activity-strip buttons' accessible names). Ready for review.

## Ask (from Misha)

"do we have playwright tests for it?" → no → "add em"

## Scope

- [x] Vitest unit tests for the working-tree store (`staged-changes.test.ts`): working/staged slot semantics, the equal-content normalizations, stage/unstage/discard/clearStaged, commitPlan's staged-vs-everything modes, git-status derivation, and localStorage persistence (fake storage): per-oid keying, stale-key sweep, migrateTo.
- [x] Playwright spec (`specs/repo-ide.spec.ts`) covering the golden path as a readable product spec: open a seeded repo → edit a file (dirty badge + change gutter) → survive a reload (localStorage) → inline diff ("(Working Tree)") → stage → SCM sections + "Commit N staged" → edit-after-stage lands the file in both sections → the staged row opens the readonly "(Index)" pseudo-file → commit → clean state.
- [x] Run both locally (vitest lane + `pnpm spec` against the auto-started local dev server) and record results.

## Notes

- The playwright spec lane (`specs/*.spec.ts`, root config) does NOT run in Depot CI yet — `ci/playwright-preview-specs` is in flight separately. This spec lands in the local/manual lane and will be picked up by that work; the vitest store test runs in the normal Test CI lane immediately.
- The spec seeds its repo server-side with `connectAdminItx` + `itx.repos.create` (repos are template-seeded on create), so it drives only public product surfaces after that.
- Pierre tree rows are shadow-DOM buttons with `role=treeitem` and aria-labels — playwright role locators pierce shadow DOM, so no coordinate clicking.

## Implementation log

- Store tests: 11 passing; a fake localStorage fixture with a unique repo identity per test (the module caches store instances per key, so identity reuse would leak state across tests). Rehydration is exercised by seeding storage JSON directly for a never-seen key.
- Spec: passes locally in ~11s (twice consecutively). Findings along the way:
  - Two seeded README.md files (root + integrations/waitrose) — tree rows are targeted by pierre's `data-item-path` attribute, which playwright pierces through the shadow root.
  - Product a11y fix: the SCM activity button's dirty-count badge was its accessible name ("1"), beating the title — both activity buttons now carry explicit aria-labels.
  - `waitFor({ state: "hidden" })` fights the middlewright spinner-waiter (it waits for the locator to be VISIBLE first); the spec asserts positive states instead.
- The playwright lane still doesn't run in Depot CI (`ci/playwright-preview-specs` is in flight); the vitest test rides the normal Test lane.
