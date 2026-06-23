---
status: waiting-on-decision
size: small
---

# Colocate Single-Use Types Lint Rule

Status summary: Draft PR is open with the rule only and intentionally leaves 49 current lint violations unfixed. Waiting for the keep-and-fix-vs-scrap decision after CI/review.

## Goal

Add an internal lint rule that requires non-exported TypeScript types used in service of a single function to be colocated with that function.

## Decisions

- The rule should live in the existing internal oxlint plugin.
- The rule should be enabled in the root oxlint config so CI reports existing violations.
- For the initial PR, do not fix violations.
- Exported type declarations are exempt.
- Type declarations with two or more read references are exempt.
- The first implementation should target `type` aliases and `interface` declarations.
- A single-use type is compliant when its declaration is the sibling statement immediately before or immediately after the function declaration/variable declaration that uses it.

## Checklist

- [x] Add an internal lint rule for single-use type colocation. _Implemented as `iterate/colocate-single-use-types` in `oxlint-plugin-iterate.js`._
- [x] Enable the rule in `.oxlintrc.json`. _Registered globally as an error so CI shows existing violations._
- [x] Run a focused lint command to confirm the rule reports existing violations. _`pnpm lint` reports 49 errors from the new rule and exits 1._
- [x] Push the worktree branch and open a draft PR. _Opened draft PR #1572 against `main`: https://github.com/iterate/iterate/pull/1572._

## Implementation Log

- Created worktree `/Users/mmkal/src/worktrees/iterate/colocate-single-use-types` on branch `lint/colocate-single-use-types` from `origin/main`.
- Added `iterate/colocate-single-use-types`, targeting non-exported `type` aliases and `interface` declarations with exactly one read reference.
- Confirmed the first lint run fails with existing colocation violations and no plugin crash.
- Opened draft PR #1572 so CI can show the full current violation set before cleanup work.
