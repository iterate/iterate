---
status: complete
size: small
---

# Render CI traces after cancellation

Implementation and local validation are complete. The original cancelled report was successfully published from this branch; independent review found no blocking issues. The draft PR is under CI and monitoring.

## Request and scope

Fix and worktreeify the CI trace renderer failure for cleanup that continues after Depot records cancellation. Open a draft PR, commit and push the implementation, and register it with the global PR monitor.

The cancelled preview `9dsvdkskfv` records its finish job ending at `2026-09-17T08:22:19Z`. Its `erase` shell starts at `08:22:21.311Z` without an exit marker. Rendering uses the earlier job finish as the shell end and throws `Invalid span interval`. The scheduled reconciler retries the missing report every 15 minutes. This run predates the force-green change in #2695.

## Acceptance

- [x] Add a failing renderer regression for work starting after cancellation. *Observed `Invalid span interval` in the shell, operation, and test cases before each fix.*
- [x] Keep unfinished steps, operations, and tests renderable and explicitly incomplete; inferred ends cannot precede their own starts. *`assembleTrace` bounds inferred endpoints at their own start and explains that the enclosing finish was earlier.*
- [x] Preserve measured start/end times and Depot timestamps; still reject invalid measured intervals. *Regression cases check recorded parent timestamps, valid measured intervals after cancellation, and reversed endpoints.*
- [x] Replay the original cancelled preview and check its report, including normal completed work. *`9dsvdkskfv`: 206 valid spans, two zero-duration incomplete cleanup steps; successful `tmnqx7jv18`: 217 valid spans.*
- [x] Document the timing limitation, run required checks, and address PR review. *Docs explain unknown zero-duration spans; install, typecheck, lint, Knip, format and the full test suite passed. Independent review found no blockers; the PR monitor owns new feedback.*

## Decisions

No workflow, cancellation, early-green, or repair-schedule changes. Correct only inferred endpoints; do not silently clamp malformed measured intervals or claim unfinished work passed. A start after its enclosing finish can be shown as a zero-duration incomplete span when no later endpoint is known.

## Implementation log

- 2026-09-17: Captured the cancelled run's Depot metadata and trace markers locally; reproduced the renderer error. Raw logs and credentials will not be committed.
- 2026-09-17: Added six regression cases; all 23 trace tests pass. The first full test run hit the existing readiness subprocess watchdog under concurrent local load; that test passed in isolation and the full suite passed on rerun without any test changes.
- 2026-09-17: Depot collector `rcqlnm3692` successfully rendered and uploaded source `9dsvdkskfv`. Its previously missing CI trace status now links to a working report. A headless browser showed the incomplete markers without errors.
- 2026-09-17: Browser review also found that the chart clipped cleanup after the root finish. Its initial/reset range now includes all observed span ends, while the workflow wall-time statistic retains Depot's original finish. No workflow or scheduling changes.
