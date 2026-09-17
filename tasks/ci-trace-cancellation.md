---
status: ready
size: small
---

# Render CI traces after cancellation

Worktree created; the failure is diagnosed. Regression coverage, the renderer fix, and real-run replay remain.

## Request and scope

Fix and worktreeify the CI trace renderer failure for cleanup that continues after Depot records cancellation. Open a draft PR, commit and push the implementation, and register it with the global PR monitor.

The cancelled preview `9dsvdkskfv` records its finish job ending at `2026-09-17T08:22:19Z`. Its `erase` shell starts at `08:22:21.311Z` without an exit marker. Rendering uses the earlier job finish as the shell end and throws `Invalid span interval`. The scheduled reconciler retries the missing report every 15 minutes. This run predates the force-green change in #2695.

## Acceptance

- [ ] Add a failing renderer regression for work starting after cancellation.
- [ ] Keep unfinished steps, operations, and tests renderable and explicitly incomplete; inferred ends cannot precede their own starts.
- [ ] Preserve measured start/end times and Depot timestamps; still reject invalid measured intervals.
- [ ] Replay the original cancelled preview and check its report, including normal completed work.
- [ ] Document the timing limitation, run required checks, and address PR review.

## Decisions

No workflow, cancellation, early-green, or repair-schedule changes. Correct only inferred endpoints; do not silently clamp malformed measured intervals or claim unfinished work passed. A start after its enclosing finish can be shown as a zero-duration incomplete span when no later endpoint is known.

## Implementation log

- 2026-09-17: Captured the cancelled run's Depot metadata and trace markers locally; reproduced the renderer error. Raw logs and credentials will not be committed.
