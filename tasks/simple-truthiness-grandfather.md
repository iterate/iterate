---
status: in-progress
size: medium
---

# Prefer simple truthiness in new code

The closed reference PR is [#2491](https://github.com/iterate/iterate/pull/2491).
Its roughly 4,600-site sweep was too large. This rollout is specified; implementation and validation remain.

## Request and decisions

Prefer direct optional properties over conditional spreads, trust declared types,
and treat empty strings as absent when choosing a fallback. Use the existing
`grandfatherRule` with `allowedUpTo: new Date("2026-09-08T00:00:00Z")` (three
calendar days before this request). Leave older lines alone.

- [ ] Add `iterate/simple-truthiness-check`, with real oxlint integration tests.
- [ ] Flag conditional spreads that merely omit an unchanged property value.
- [ ] Flag null/undefined comparisons and `??` for known string/object/array values; flag redundant `Array.isArray` on typed arrays.
- [ ] Preserve meaningful number/boolean checks and actual unknown-input validation. Document narrow exceptions for external protocols where absence has meaning.
- [ ] Apply the grandfather cutoff, inspect the resulting violations, and fix the recent sites with the simplest correct code.
- [ ] Run lint tests, typecheck, lint, format, knip, and repository tests; address CI/review feedback.
- [ ] Keep a draft PR updated and register it with the global PR monitor.

## Assumptions

The requested rule is a code-design constraint, not a semantics-preserving codemod.
It will report without automatic fixes: a direct property can affect a downstream
merge, and replacing `??` with `||` deliberately changes empty-string handling.
Types containing numbers, booleans, bigint, unknown, or any do not justify blindly
replacing precise presence checks with truthiness. No ambient type changes or broad
legacy sweep from #2491 will be imported. The existing logical-and-spread rule stays.

## Implementation log

- 2026-09-11: Created an isolated worktree from `origin/main` at `2e6aa7ac6`.
