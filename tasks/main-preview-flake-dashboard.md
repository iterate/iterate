---
status: needs-design-review
size: large
---

# Main preview runs and a current flake dashboard

Status: PR #2658 is closed at the user’s request; branch retained for review through the compare link. Dashboard changes and preview implementation are preserved, but the preview-1 reservation design is rejected for excessive special-casing. Reconsider that requirement before further implementation; validation remains incomplete.

## Original scope (reservation design needs reconsideration)

- [ ] Keep `pnpm preview run --pull-request-number <n>` working. Add `pnpm preview run-main --commit <sha>` for the exact checked-out main commit.
- [ ] Share deployment, readiness, tests and cleanup between PR/main callers. Extract PR reporting/context from the shared implementation where needed; keep the extraction focused.
- [ ] Reserve preview-1 for main; exclude it from ordinary PR/manual allocation and protect it from PR cleanup/reclaim. Do not evict an existing holder while validating this change.
- [ ] Trigger the full preview suite on main pushes. Serialize main deployment/test/cleanup on the reserved slot without cancelling an active run; newer queued commits replace older queued commits. Keep current PR cancellation behavior.
- [ ] Upload complete suite results even when no unknown flakes occur. Only a completed full main result replaces that suite's current unknown-flake list; partial/cancelled/missing results must not look like a clean run. Preserve historical records.
- [ ] Show unknown flakes from the latest complete main run per suite, with run/commit provenance. Remove the 14-day accumulation from the current unknown table.
- [ ] Explain all outcome emojis, including unexpected errors (❌).
- [ ] Collapse the Failures table with test counts per suite in its summary.
- [ ] Put collapsible Sentinels last. Render unknown test names as plain text with safe Markdown escaping.
- [ ] Test main/PR ownership isolation, pinned commit validation, complete-zero-flake replacement, partial-run handling, and the rendered issue through real public boundaries/harnesses.
- [ ] Validate the shared path against a preview and inspect its results/artifacts. Check the new main workflow using supported Depot execution before merge; do not claim automatic main triggers are live before merge.
- [ ] Complete required repository checks, review the PR, handle CI/review feedback and update the PR body with evidence.

## Decisions and limits

- `run-main` fixes the slot and full-suite policy; it does not expose a collection of redundant environment/branch flags.
- Main results measure the shared baseline. PR results still remain in their CI reports and historical telemetry.
- A disappearing unknown row means it did not recur in the latest full run, not that its cause is proven fixed.
- This work does not fix the outstanding child-agent delegation orphaned-script flake or disable retries. A green check is not proof of zero retries; validation will inspect recorded retries explicitly.
- Reserving one slot adds main CI compute and reduces the PR pool by one. The main check runs after merges and is not on the PR critical path.
- Existing main worktree edits belong to the user and remain untouched. Work is isolated on `ci/main-preview-dashboard`.

## Implementation log

- 2026-09-15: Created this scope from the agreed dashboard and main-preview design before implementation. Starting from main commit `611c3769bfe50cace2601e9315cc415911f6decc`.

Codex session: `01a0a1e6-0135-7902-91aa-b4bb07026de2`.

- 2026-09-15: Added complete-suite summaries with retry-record count validation, main-only current snapshots and dashboard layout changes; 29 dashboard tests and 162 focused CI/runner tests pass. Extracted GitHub transport, revision/report context and preview state from the CLI. Main refuses to start against a Semaphore that lacks the reservation policy. GC remains allowed to acquire an expired main slot without force, so cancellation still has a cost-control backstop.

- 2026-09-15 review: fixed branch provenance when multiple Depot runs share a SHA; report summaries now carry their own branch/commit. Captured Vitest module/import and nested suite-hook errors in canonical telemetry, with real Vitest subprocess regression tests. Incomplete summaries no longer advance tracked-test retirement. Main is restricted to the serialized workflow, waits on reserved-slot contention, and cannot force-renew over GC. The reservation test tags and recovers its own inventory after cancelled runs.
- First preview validation (`22f55968b`): unit CI passed 5,461 tests and uploaded a complete summary with zero unknown retries. The real Semaphore preview reservation test passed. Final browser/OS results and validation of the review fixes remain in progress.

- 2026-09-15 user review: closed PR #2658 without deleting the branch. Continue review at https://github.com/iterate/iterate/compare/main...ci/main-preview-dashboard. The user rejected special-casing preview-1 throughout allocation and deployment; do not treat the original reservation requirement as settled or reopen a PR without a new request. Existing review fixes are preserved as a checkpoint, not an accepted design.
