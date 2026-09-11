---
status: complete
size: medium
---

# Prefer simple truthiness in new code

The closed reference PR is [#2491](https://github.com/iterate/iterate/pull/2491).
The rule and recent fixes are complete. Human review is addressed. Main is merged with its caller-supplied OpenAI cache keys preserved; final CI is rerunning before the requested merge.

## Request and decisions

Prefer direct optional properties over conditional spreads, trust declared types,
and treat empty strings as absent when choosing a fallback. Use the existing
`grandfatherRule` with `allowedUpTo: new Date("2026-09-11T00:00:00Z")`. Leave older lines alone.

- [x] Add `iterate/simple-truthiness-check`, with real oxlint integration tests. _Implemented in `lint/rules/simple-truthiness-check.ts`; CLI and editor-buffer specs cover the public lint behavior._
- [x] Flag conditional spreads that merely omit an unchanged property value. _Logical and ternary omission forms report a direct-property recommendation._
- [x] Flag null/undefined comparisons and `??` for known string/object/array values; flag redundant `Array.isArray` on typed arrays. _Native TypeScript types distinguish trusted references from numbers, booleans, and unknown inputs._
- [x] Preserve meaningful number/boolean checks and actual unknown-input validation. Document narrow exceptions for external protocols where absence has meaning. _Negative cases cover real type discrimination and shadowed globals; adjacent rule docs explain protocol exceptions._
- [x] Apply the grandfather cutoff, inspect the resulting violations, and fix the recent sites with the simplest correct code. _Midnight September 11 yields 13 sites across nine files, rather than 405 with September 8._
- [x] Run lint tests, typecheck, lint, format, knip, and repository tests; address CI/review feedback. _Full CI, including preview deployment/e2e, passed at `a4f245d7c`; all 56 lint tests, typecheck, and lint also pass for the message-only review follow-up._
- [x] Keep a draft PR updated and register it with the global PR monitor. _[#2632](https://github.com/iterate/iterate/pull/2632) registered through September 12, 19:39 UTC._

## Assumptions

The requested rule is a code-design constraint, not a semantics-preserving codemod.
It will report without automatic fixes: a direct property can affect a downstream
merge, and replacing `??` with `||` deliberately changes empty-string handling.
Types containing numbers, booleans, bigint, unknown, or any do not justify blindly
replacing precise presence checks with truthiness. No ambient type changes or broad
legacy sweep from #2491 will be imported. The existing logical-and-spread rule stays.

## Implementation log

- 2026-09-11: Created an isolated worktree from `origin/main` at `2e6aa7ac6`.

- September 8 caught 405 violations, so the rollout moved to midnight September 11 to honor the requested small diff: 13 recent sites. The scope choice was raised in chat.

- Local validation: full typecheck, lint, knip, formatting, and monorepo tests pass (OS: 3,129 passed, 20 expected failures, one existing skip). Eight new rule tests cover real oxlint, unsaved buffers, and dated Git history.

- Human review: added the terse design rationale beside the rule and centralized every diagnostic under `meta.messages`; visitors use `messageId` and fallback operator data. Detection is unchanged.

- CI completion: all required checks and preview deployment/e2e passed at `a4f245d7c`. Task moved to complete; the global monitor retains follow-up coverage for later commits and comments.

- Main merge: preserve streaming usage and caller-supplied prompt cache keys; three regression cases cover missing, empty, and explicit overrides. The new lint rule also caught one newly merged optional egress-rule check, now `if (!rule)`. Full repository tests pass (OS: 3,130 passed, 20 expected failures, one existing skip); the final transport suite also passes with the added empty-string case.
