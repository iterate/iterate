---
status: complete
size: small
---

# Colocate Single-Use Types Lint Rule

Status summary: Done. The branch adds the lint rule, enables it globally, and moves the existing single-use type declarations next to their only consumer functions so lint/typecheck/tests pass.

## Goal

Add an internal lint rule that requires non-exported TypeScript types used in service of a single function to be colocated with that function.

## Decisions

- The rule should live in the existing internal oxlint plugin.
- The rule should be enabled in the root oxlint config so CI reports existing violations.
- The initial PR was opened with the rule only so CI showed the violation set; cleanup was added after the keep-and-fix decision.
- Exported type declarations are exempt.
- Type declarations with two or more read references are exempt.
- The first implementation should target `type` aliases and `interface` declarations.
- A single-use type is compliant when its declaration is part of a contiguous type block immediately before or immediately after the function declaration/variable declaration that uses it.

## Checklist

- [x] Add an internal lint rule for single-use type colocation. _Implemented as `iterate/colocate-single-use-types` in `oxlint-plugin-iterate.js`._
- [x] Enable the rule in `.oxlintrc.json`. _Registered globally as an error so CI shows existing violations._
- [x] Run a focused lint command to confirm the rule reports existing violations. _`pnpm lint` reports 49 errors from the new rule and exits 1._
- [x] Push the worktree branch and open a draft PR. _Opened draft PR #1572 against `main`: https://github.com/iterate/iterate/pull/1572._
- [x] Fix the existing violations. _Moved reported single-use type aliases/interfaces beside their only consumer functions; the rule now permits contiguous adjacent type blocks._
- [x] Verify the cleanup. _`pnpm format`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass._

## Implementation Log

- Created worktree `/Users/mmkal/src/worktrees/iterate/colocate-single-use-types` on branch `lint/colocate-single-use-types` from `origin/main`.
- Added `iterate/colocate-single-use-types`, targeting non-exported `type` aliases and `interface` declarations with exactly one read reference.
- Confirmed the first lint run fails with existing colocation violations and no plugin crash.
- Opened draft PR #1572 so CI can show the full current violation set before cleanup work.
- Refined adjacency to allow contiguous type-only blocks beside the consumer function; this handles functions with multiple local supporting types without requiring unnecessary inlining.
- Moved the existing reported types across scripts, OS components/domains, shared helpers, UI, Semaphore, mock-http-proxy, and e2e helpers.
- Verified cleanup with `pnpm format`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
