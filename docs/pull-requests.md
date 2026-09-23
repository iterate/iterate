# Pull requests

Do not commit, push, open, or merge a PR unless asked.

Before opening a PR, run the applicable typechecks, tests, lint, and formatting checks. Describe the concrete behavior change and validation. Address every review thread before merging.

The Preview OS-Next workflow owns per-PR previews and their integration/browser tests. For operational changes, inspect the preview's resulting state and telemetry in addition to test results. Production rollout remains gated on the [engineering invariant](engineering-invariants.md).

## Body

CI writes managed sections into the PR body on each push: `<!-- loc-report -->…<!-- /loc-report -->` (the LOC table, `scripts/ci/loc-report.ts`), `<!-- os-next-preview:begin -->…<!-- os-next-preview:end -->` (the preview links), and Bugbot's `<!-- CURSOR_SUMMARY -->…<!-- /CURSOR_SUMMARY -->`. Editing the description does not rewrite them.

To edit a body, fetch the current one and change only your own text around those sections. Never PATCH a body written from scratch after the last push: that deletes the sections for good, and the squash commit ships without the LOC table.
