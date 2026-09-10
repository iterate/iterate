# Grandfather existing violations

```ts
import { grandfatherRule } from "./grandfather-rule.ts";

export const noShoutingConstants = grandfatherRule({
  allowedUpTo: new Date("2026-11-10"),
  meta: {
    /* normal rule metadata */
  },
  create(context) {
    /* normal rule listeners */
  },
});

// Or wrap a pre-built StrictRule:
const wrapped = grandfatherRule({ allowedUpTo: new Date("2026-11-10"), ...existingRule });
```

## Local and main-branch checks

Reports at or before the cutoff are suppressed using the start line's Git
**author timestamp**. An explicit report location takes precedence over the
node location. A date-only string means midnight UTC, not the end of that day.

The wrapper blames the actual linted source, including unsaved edits. Changed
and uncommitted lines always count as new. Adding lines above an unchanged
violation does not change its age. Blame measures when the line last changed,
not when the surrounding code first became a violation.

## Pull requests

CI sets `ITERATE_LINT_PR_BASE` to the PR's merge-base SHA. In this mode,
**only added/changed lines are checked; the date cutoff does not apply**.
Untouched lines are trusted, even if their blame dates are after the cutoff.
An old commit on a PR branch can therefore pass local lint but fail PR lint.

`scripts/ci/prepare-pr-lint.ts` asks GitHub for the merge base of the event's
base/head SHAs, verifies that the checked-out HEAD matches, and fetches only
that commit. The PR checkout stays shallow. Main and other non-PR jobs retain
full history for blame. API/fetch failures stop the job before lint runs.

The helper compares the base file with the actual linted source on each pass,
so autofix edits and shifted line numbers work. Git-detected renames preserve
unchanged lines; new files are checked in full. Unknown report locations are
checked rather than silently exempted. It needs no network calls while linting.

## Shared behavior

Rules keep their metadata, listeners, options, messages, suggestions and fixes.
Suppressed reports do not apply fixes. Comparisons run lazily on the first report
and are reused for subsequent reports from that rule on the file.

Unexpected Git failures stop linting. Without PR mode, files without history
and shallow boundary lines are checked because their true age is unknown.

The shouting rule uses the example cutoff above. In local/main mode, until
that date, committing an edit can make it exempt even though it was flagged
while uncommitted. PR mode always checks changed lines regardless of that date.
