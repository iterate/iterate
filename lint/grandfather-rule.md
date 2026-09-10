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

On GitHub PR runs with `GH_TOKEN`, the plugin reads the event metadata and
fetches the PR diff once, pinned to the event's base/head SHAs. **Only
added/changed lines are checked; the date cutoff does not apply.** Untouched
lines are trusted. An old commit on a PR branch can therefore pass local lint
but fail PR lint.

There is no setup script or extra Git fetch. PR checkouts stay shallow;
local/main runs keep using blame. The two CI lint steps just receive the
existing GitHub token. API failures fail lint rather than exempting code.

For autofix, the helper reverses each file's PR patch against the committed
head to recover its original text, then compares that with each lint pass.
This keeps line numbers correct after fixes. Renamed files use their PR patch;
new files are checked in full. Reports with unknown locations are checked.

## Shared behavior

Rules keep their metadata, listeners, options, messages, suggestions and fixes.
Suppressed reports do not apply fixes. Comparisons run lazily on the first report
and are reused for subsequent reports from that rule on the file.

Unexpected Git failures stop linting. Without PR mode, files without history
and shallow boundary lines are checked because their true age is unknown.

The shouting rule uses the example cutoff above. In local/main mode, until
that date, committing an edit can make it exempt even though it was flagged
while uncommitted. PR mode always checks changed lines regardless of that date.
