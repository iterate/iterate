# EXPERIMENT: rotate previews into rested slots

Status: complete. Final independent audit verified all three slots available with no experiment Workers, namespaces, container applications or pending cleanup. Both aged parked and fully deleted slots passed zero-gate agent smoke and real container execution. One earlier full recreation failed with HTTP 500. Handoffs preserved the old previews, and independent retirement released the old slot after about 6½ minutes. No production policy changes or PR.

## Agreed behavior and assumptions

A successful preview stays usable until its replacement is ready (or the PR closes). A new deployment claims a different available slot, leaving the old lease intact. After publishing the replacement, a separate cleanup job owns and renews the old lease through parking, waiting, full Worker deletion, and cooling. It releases only after verified completion. Pool exhaustion or failed replacement leaves the previous preview usable. Cleanup does not block green.

#2712's docs-only result inheritance and tests-only deployment reuse must survive; slot rotation applies only when deployment is required. Current post-test erase/restore and settlement provenance need explicit reconciliation. Stale runs must never publish over newer previews or clean their slots.

Assumptions while the user is AFK: begin with an isolated, manually invoked experiment using the real Semaphore and exclusively held preview slots, not a production Semaphore rollout. Full deletion is specifically authorized for the experiment; restrict it to owned preview Workers and prove route/container recreation before proposing adoption. Keep raw output in evidence.ignoreme/. Run representative OS deploys and agent-smoke where possible, and distinguish synthetic/model results from live evidence. Do not silently retry failing work. Preserve the root worktree. Commit and push, no PR.

## Work

- [x] Inspect #2712 and deployment, cleanup, lease, settlement dependencies. *The README records inheritance/reuse/restoration constraints; 39 existing planner/settlement/CI tests pass.*
- [x] Write behavior tests for replacement failure, ordered publication, cleanup ownership and selection/reuse. *14 lifecycle/receipt tests cover the experiment; existing #2712 tests remain unchanged.*
- [x] Build an opt-in experiment with bounded cleanup, evidence checkpoints and recovery commands. *The experiment CLI retains leases, journals transitions, fences publication and launches independent local cleanup processes.*
- [x] Exercise actual preview deploy/park/delete/recreate and 0/short/90-second smoke gates on exclusively leased slots. *Ran the 90s control and zero-gate parked/full-deletion arms; omitted 15s because these samples cannot estimate a safe minimum. RESULTS.md retains the failed first recreation.*
- [x] Record total timing, slot occupancy, version/route evidence and any counterexamples; keep an old preview healthy until replacement readiness. *RESULTS.md compares command totals, documents three-slot peak occupancy, and records 398 healthy samples across two handoffs.*
- [x] Verify final resource/lease disposition and document reproducible commands and adoption constraints. *The 20:22 UTC independent Cloudflare/Semaphore audit found all three slots available and empty of their Workers/DOs/container apps. README and RESULTS document commands and limits.*

## Proposed PR body (no PR)

Experimental lease cycling keeps the previous preview usable while deploying its replacement into another slot. Retired slots stay exclusively leased through cleanup and cooling. This branch investigates whether previously torn-down slots can avoid the postdeploy 90-second wait; it does not change production defaults.

| Change | Purpose |
| --- | --- |
| Guarded live harness and lifecycle tests | Exercise replacement, oldest-available selection, cleanup ownership and receipt validity without a production rollout. |
| Agent/container probes and measured results | Compare immediate work and total deployment cost, preserving all failed attempts. |
| Separate project-creation timeout task | Keep the unrelated traced control failure visible. |

Risk map: Worker deletion/recreation and external cleanup after lease expiry are highest risk. Live mutations require current ownership; uncertain cleanup must never certify a clean slot. Read experiment results before considering production adoption.

Session: Codex `01a0b054-bdd8-7d52-9c01-30d9b92576c8`.

## Implementation log

- 2026-09-18: fetched main and branched from #2712's merge, leaving the root worktree unchanged. Initial specification committed separately.
- Added an opt-in manual CLI and 12 passing lifecycle tests; 39 existing #2712 planner/settlement/CI tests pass unchanged. No production Semaphore or workflow changes.
- Live run `sept18` acquired preview-10 for full cleanup/cooling and preview-15 for the 90-second baseline. Both acquired without force from available inventory.
- The package publisher runs for main/PRs, not arbitrary branch pushes. Product code and immutable package references are therefore pinned to merged main `97ffd6fd65`; a diff guard rejects accidental mismatch. Repeated deployments still produce distinct Worker versions.
- Raw evidence and command logs remain in `experiments/preview-lease-cycling/evidence.ignoreme/sept18/`. Cleanup jobs persist intent/checkpoints locally and can be resumed; this is explicitly not the final distributed CI implementation.
- Control preview-15 passed unretried agent smoke (29.3s) after its 90s gate; its published URL is sampled every five seconds during replacement. Its postdeploy error-only Worker Logs query returned zero events.
- Preview-10 full removal succeeded (eight scripts, zero OS namespaces/container apps; zone routes disappeared). The first cleanup took 5m50s from its parked checkpoint to release (excluding the initial erase). Renewal updates Semaphore's lastAcquiredAt, so the first receipt check conservatively rejected the reclaimed slot. Fixed receipt validation to compare release timestamps before/after claim; reverified actual absence and waited another 150s under ownership for this first candidate. This harness failure is not a Cloudflare failure.
- Early cost observation: fresh Docs uploaded 463 assets again (38.9s), while the control reused its assets. Total deployment cost, not just smoke time, matters.
- Full-deletion trial 1 failed before smoke: OS uploaded successfully but the first container application creation returned HTTP 500, “can't create application at this time”. The old preview remained current; failed candidate cleanup was queued independently. No zero-wait agent result exists for this failed deploy.
- A settled preview-15 Project.create probe timed out after 91.849s (offset 8), before reaching sandbox creation. Recorded separately in `tasks/project-create-offset-eight-timeout.md`; another fresh agent smoke then passed in 22.7s. Original durable agent events remained readable without version pins after replacement failure.
- Added a parked-and-aged comparison on exclusively leased preview-17, while preview-10 is deleted/cooled for another full-recreation measurement. At most three slots are held; no other holder was evicted.

- Aged parked preview-17 passed its first zero-gate agent run (process started at OS age 1.454s, completed in 30.055s), then a separate container create/exec/destroy probe (22.797s). Publication moved from 15 to 17 only after agent success; retirement of 15 began independently. Initial inspection: 15 namespaces, six container apps, zero postdeploy error-level log events.

- Longer-rest preview-10 recreation succeeded after 15m09s absent before deployment. Zero-gate agent smoke passed in 29.812s (test process OS age 2.720s); separate container execution passed in 19.620s. Full recreation deployed in 485.277s vs 344.538s for parked and 333.160s for the control. Slot 17 stayed healthy through handoff and began independent retirement.
- Finished the experiment after the container proof; current pointer cleared and the final slot queued for cleanup. No production gate removal is proposed from this sample size.

- Final independent audit at 20:22:02 UTC: preview-10/15/17 available, null holders, zero matching Workers/namespaces/container applications; registry current=null and pendingCleanup=[]. DNS and storage infrastructure retained intentionally. Root worktree unchanged.
