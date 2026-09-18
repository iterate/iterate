# EXPERIMENT: rotate previews into rested slots

Status: starting. Based on main `97ffd6fd65` including #2712. No production policy changes or PR. The existing Worker-per-run experiment is parked.

## Agreed behavior and assumptions

A successful preview stays usable until its replacement is ready (or the PR closes). A new deployment claims a different available slot, leaving the old lease intact. After publishing the replacement, a separate cleanup job owns and renews the old lease through parking, waiting, full Worker deletion, and cooling. It releases only after verified completion. Pool exhaustion or failed replacement leaves the previous preview usable. Cleanup does not block green.

#2712's docs-only result inheritance and tests-only deployment reuse must survive; slot rotation applies only when deployment is required. Current post-test erase/restore and settlement provenance need explicit reconciliation. Stale runs must never publish over newer previews or clean their slots.

Assumptions while the user is AFK: begin with an isolated, manually invoked experiment using the real Semaphore and exclusively held preview slots, not a production Semaphore rollout. Full deletion is specifically authorized for the experiment; restrict it to owned preview Workers and prove route/container recreation before proposing adoption. Keep raw output in evidence.ignoreme/. Run representative OS deploys and agent-smoke where possible, and distinguish synthetic/model results from live evidence. Do not silently retry failing work. Preserve the root worktree. Commit and push, no PR.

## Work

- [ ] Inspect #2712 and deployment, cleanup, lease, settlement dependencies.
- [ ] Write behavior tests for replacement failure, ordered publication, cleanup ownership and selection/reuse.
- [ ] Build an opt-in experiment with bounded cleanup, evidence checkpoints and recovery commands.
- [ ] Exercise actual preview deploy/park/delete/recreate and 0/short/90-second smoke gates on exclusively leased slots.
- [ ] Record total timing, slot occupancy, version/route evidence and any counterexamples; keep an old preview healthy until replacement readiness.
- [ ] Verify final resource/lease disposition and document reproducible commands and adoption constraints.

## Proposed PR body (no PR)

Experimental lease cycling keeps the previous preview usable while deploying its replacement into another slot. Retired slots stay exclusively leased through cleanup and cooling. This branch investigates whether previously torn-down slots can avoid the postdeploy 90-second wait; it does not change production defaults.

| Change | Purpose |
| --- | --- |
| Experiment specification | Preserve lifecycle, human-preview and #2712 compatibility requirements before implementation. |

Risk map: Worker deletion/recreation and external cleanup after lease expiry are highest risk. Live mutations require current ownership; uncertain cleanup must never certify a clean slot. Read experiment results before considering production adoption.

Session: Codex `01a0b054-bdd8-7d52-9c01-30d9b92576c8`.

## Implementation log

- 2026-09-18: fetched main and branched from #2712's merge, leaving the root worktree unchanged. Initial specification committed separately.
- Added an opt-in manual CLI and 12 passing lifecycle tests; 39 existing #2712 planner/settlement/CI tests pass unchanged. No production Semaphore or workflow changes.
- Live run `sept18` acquired preview-10 for full cleanup/cooling and preview-15 for the 90-second baseline. Both acquired without force from available inventory.
- The package publisher runs for main/PRs, not arbitrary branch pushes. Product code and immutable package references are therefore pinned to merged main `97ffd6fd65`; a diff guard rejects accidental mismatch. Repeated deployments still produce distinct Worker versions.
- Raw evidence and command logs remain in `experiments/preview-lease-cycling/evidence.ignoreme/sept18/`. Cleanup jobs persist intent/checkpoints locally and can be resumed; this is explicitly not the final distributed CI implementation.
