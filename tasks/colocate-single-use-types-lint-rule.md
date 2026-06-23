---
status: in-progress
size: small
---

# Colocate Single-Use Types Lint Rule

Status summary: Spec captured. Implementation has not started yet. The intended first PR should add only the rule, leaving existing violations unfixed so CI shows the blast radius.

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

- [ ] Add an internal lint rule for single-use type colocation.
- [ ] Enable the rule in `.oxlintrc.json`.
- [ ] Run a focused lint command to confirm the rule reports existing violations.
- [ ] Push the worktree branch and open a draft PR.

## Implementation Log

- Created worktree `/Users/mmkal/src/worktrees/iterate/colocate-single-use-types` on branch `lint/colocate-single-use-types` from `origin/main`.
