# Use PR changed lines for grandfathered rules

Status: implemented. PR comparison and CI wiring are in place. Focused tests
pass; full repository checks and CI are running.

Keep the existing `grandfatherRule({ allowedUpTo, ...rule })` API.
Local and main checks retain author-date blame behavior. PR checks ignore the
cutoff and report only on added/changed lines, trusting unchanged base code.

CI resolves the PR merge base through GitHub metadata and fetches that one
commit. Diff its file contents against the actual linted source, so autofix
passes retain correct line numbers. This is the PR comparison base, not a
permanent exemption snapshot. PR checkouts stay shallow; non-PR jobs retain
full history for blame. Missing/invalid PR comparison data must fail clearly.

- [x] Spec: PR changes are checked regardless of dates; unchanged lines are exempt.
- [x] PR comparison includes additions, edits, renames, and in-memory autofix changes. _`lint/pr-changed-lines.ts` compares current source on each pass._
- [x] Wire lint/autofix CI to PR comparison without fetching full history. _`scripts/ci/prepare-pr-lint.ts` resolves and fetches the PR merge base._
- [ ] Document the local/PR distinction; run checks and monitor the draft PR.

## Implementation log

Created from origin/main after #2620 merged. Removed its clean worktree and
paused its monitor.
