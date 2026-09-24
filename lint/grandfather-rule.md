# Grandfather existing violations

```ts
import { grandfatherRule } from "./grandfather-rule.ts";

export const noShoutingConstants = grandfatherRule({
  allowedUpTo: new Date("2026-09-10T10:04:56Z"),
  meta: {
    /* normal rule metadata */
  },
  create(context) {
    /* normal rule listeners */
  },
});

// Or wrap a pre-built StrictRule:
const wrapped = grandfatherRule({ allowedUpTo: new Date("2026-09-10T10:04:56Z"), ...existingRule });
```

Reports at or before the cutoff are suppressed using the start line's Git
**author timestamp**. An explicit report location takes precedence over the
node location. A date-only string means midnight UTC, not the end of that day.

The wrapper blames the actual linted source, including unsaved edits. Changed
and uncommitted lines always count as new. Adding lines above an unchanged
violation does not change its age. Blame measures when the line last changed,
not when the surrounding code first became a violation.

Rules keep their metadata, listeners, options, messages, suggestions and fixes.
Suppressed reports do not apply fixes. Git runs lazily on the first report. One
lint process blames each file text once for every grandfathered rule that
reports on it, and asks each repository once whether HEAD exists and whether the
clone is shallow: a Git spawn costs about 80 ms inside oxlint. New text (an edit,
an autofix pass) is blamed afresh. A commit made while a long-lived process
holds an unchanged text can only leave its lines checked.

Files without history and reports without a known start line are checked.
Shallow boundary lines are also checked because their true age is unknown;
the CI lint job fetches full history. Unexpected Git failures stop linting
instead of silently granting exemptions. No Git fetch or write is performed.

Use the rule's rollout instant, in UTC, as its cutoff. A future cutoff exempts
every line committed before it, so CI, which lints committed lines, could not
fail on the rule until then; grandfather-rule.test.ts fails on one.
