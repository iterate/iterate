# Grandfather existing lint violations

Status: implemented. Wrapper, shouting-rule rollout, and 47 lint tests pass.
Repository lint, typecheck, format, and knip pass; full tests and PR CI/review remain.

## Request and decisions

Add `grandfatherRule(rule: StrictRule, { allowedUpTo: Date })` and carry over
`no-shouting-constants` from the existing worktree, enabling it with the wrapper.
Use the requested example cutoff, `2026-11-10T00:00:00Z` (inclusive).

Blame the source actually being linted. A diagnostic's start line determines
its age, using Git author time. Uncommitted/untracked lines remain violations,
even before a future cutoff. Only proven old lines are suppressed. Missing
history must not silently exempt code: report violations when no repository or
file history exists, and surface unexpected Git failures. Shallow boundary
commits cannot prove a line's age. Preserve rule metadata, listeners, and fixes.

## Checklist

- [x] Integration spec using real dated Git commits and real oxlint. _Nine wrapper tests in `lint/grandfather-rule.test.ts`._
- [x] Reusable wrapper with lazy blame lookup per linted source. _`lint/grandfather-rule.ts`; documented in the adjacent Markdown file._
- [x] Carry over and enable the shouting rule with the wrapper. _Plugin registration uses the requested cutoff; root config sets error severity._
- [x] Check cutoff boundary, edits/new files, report locations, and metadata/fixes. _Real Git/oxlint coverage also includes shallow clones, worktrees, and Git errors._
- [ ] Run validation, update draft PR, and arrange review monitoring.

## Implementation log

Created from current origin/main, carrying only the relevant rule from
`no-shouting-constants`; the old worktree remains available.

CI lint and autofix now fetch full history. Monitor `monitor-grandfather-lint-pr`
checks PR #2620 every 20 minutes through 2026-09-11 10:00 UTC.
