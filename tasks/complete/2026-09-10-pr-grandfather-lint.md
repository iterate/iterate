# Use PR changed lines for grandfathered rules

Status: implementation complete. PR comparison, CI wiring, and all local
checks pass. PR #2622 CI and review monitoring are active.

Keep the existing `grandfatherRule({ allowedUpTo, ...rule })` API.
Local and main checks retain author-date blame behavior. PR checks ignore the
cutoff and report only on added/changed lines, trusting unchanged base code.

The plugin reads PR event metadata and fetches the pinned PR diff directly
from GitHub once. CI only supplies its token. PR checkouts stay shallow;
non-PR jobs retain full history for blame. API errors fail lint. Autofix
compares each pass against the original text recovered from the PR patch.

- [x] Spec: PR changes are checked regardless of dates; unchanged lines are exempt.
- [x] PR comparison includes additions, edits, renames, and in-memory autofix changes. _`lint/pr-changed-lines.ts` compares current source on each pass._
- [x] Wire lint/autofix CI to PR comparison without fetching full history. _The lint steps supply `GH_TOKEN`; there is no setup step or extra fetch._
- [x] Document the local/PR distinction; run checks and monitor the draft PR. _`lint/grandfather-rule.md`; frozen install, full tests, typecheck, lint, knip, and format pass. Monitor `monitor-pr-changed-line-lint` runs for 24 hours._

## Implementation log

Created from origin/main after #2620 merged. Removed its clean worktree and
paused its monitor.

Full local tests passed: 53 lint tests; 3,121 OS tests with 18 existing expected
failures and one existing skip. Workflow checks cover PR checkout and token wiring.

Simplification follow-up: removed `scripts/ci/prepare-pr-lint.ts` and the
`ITERATE_LINT_PR_BASE` variable. The plugin gets a pinned PR diff directly
from GitHub once at load time; CI only supplies its token. No extra commit
fetch. Existing PR/autofix tests now serve actual Git-generated diffs over HTTP.

Simplified version: 53 lint tests, lint typecheck, 34 workflow tests, focused
lint, and root lint against the actual GitHub PR diff all pass.
