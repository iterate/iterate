# Pull requests

Do not commit, push, open, or merge a PR unless asked.

Before opening a PR, run the applicable typechecks, tests, lint, and formatting checks. Describe the concrete behavior change and validation. Address every review thread before merging.

The Preview OS-Next workflow owns per-PR previews and their integration/browser tests. For operational changes, inspect the preview's resulting state and telemetry in addition to test results. Production rollout remains gated on the [engineering invariant](engineering-invariants.md).
