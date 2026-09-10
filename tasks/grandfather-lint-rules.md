# Grandfather existing lint violations

Status: specified; implementation and validation remain.

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

- [ ] Integration spec using real dated Git commits and real oxlint.
- [ ] Reusable wrapper with lazy blame lookup per linted source.
- [ ] Carry over and enable the shouting rule with the wrapper.
- [ ] Check cutoff boundary, edits/new files, report locations, and metadata/fixes.
- [ ] Run validation, update draft PR, and arrange review monitoring.

## Implementation log

Created from current origin/main, carrying only the relevant rule from
`no-shouting-constants`; the old worktree remains available.
