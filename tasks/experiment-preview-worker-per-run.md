---
status: in-progress
size: medium
---

# Experiment: a new OS Worker name for each preview run

Status: harness implemented and live runs are in progress. Initial measurements
reproduce stale routing and resets during retirement, even after exact-version
readiness. Settling-time comparisons and final results remain. Product defaults
are unchanged.

## Ask and assumptions

Try `os-preview-N-<run-id>` while retaining the slot's public hostname. Determine
whether fresh Worker/DO identities avoid the reset and stale-code failures seen
when redeploying a fixed Worker. Exercise actual Cloudflare deployment and routing,
record requests and durable state, and inspect telemetry. Manual deployments and
representative commit/CI experiments are authorized while the user is AFK.

Start with this experiment before generic lease tags / rested-slot selection.
That second idea remains a separate experiment, not a prerequisite or an excuse
to change Semaphore here. The branch starts from `71c486ac2` on
`codex/durable-object-rollout-repro` to reuse the standalone evidence harness.
Keep the earlier no-PR preference: commit and push, publish a compare link.

Only preview resources may be used. Lease a slot before touching its routing.
Preserve the original route owner, restore and verify it before releasing the
lease, and never delete a Worker. Retire experimental DO classes and park the
experimental Workers. Do not change Doppler values. Generated evidence remains
in `evidence.ignoreme/`, never Git. Product defaults and the 90-second gate remain
unchanged unless a later explicit adoption task changes them.

## Predictions, in order

1. A genuinely new Worker with new DO namespaces should avoid old/new DO code
   overlap; direct first-use operations after initial reachability should complete.
2. A stable hostname switched between distinct Workers may still reach the old
   Worker after a new-version readiness response. Assert the exact run identity,
   not merely HTTP 200, and keep first writes unretried.
3. Parking the old Worker immediately may break stale routes or in-flight work;
   keeping it alive through the handoff may preserve completion but still serve
   stale run identities. Measure both without treating stale responses as success.
4. OS naming also controls sidecars, container apps, storage names and bindings.
   A synthetic routing win alone may not translate into a shorter OS CI path.

## Work

- [x] Build a manual Vitest experiment with an explicit opt-in, bounded operations,
  stable-host route changes, exact-version assertions and disposable cleanup.
  *`experiments/preview-worker-per-run/worker-per-run.e2e.test.ts`; three scenarios.*
- [x] Acquire an isolated preview slot and record its original route state.
  *Semaphore leases, explicit preview credentials, and route snapshots in local evidence.*
- [ ] Measure unique Worker direct requests, stable-host cutovers, and handoff timing
  with multiple real changed builds. Preserve failed first calls and final DO state.
- [ ] Verify original routing restored, experimental namespaces retired, and lease released.
- [ ] Trace how a unique OS name changes real deployment resources; if the route
  experiment supports proceeding, exercise a representative OS deployment/smoke
  without silently reusing an old run's Durable Objects.
- [ ] Write a concise results table with timings, failure categories, limitations,
  and an adopt/reject/further-test recommendation. Run appropriate local checks.
- [ ] Commit and push the experiment, with proposed PR body in commit messages; no PR.

## Implementation log

- 2026-09-18: Existing tests reproduced both explicit code-update resets and
  stale parked responses after a successful exact Worker+DO readiness check.
  This experiment changes Worker identity rather than retrying those writes.

- 2026-09-18: Initial matrix: direct new hostname returned 7/24 operation 404s;
  keep-old exhausted the original ~15-second readiness cap; park-old returned
  two explicit resets from the previous Worker, a platform script-not-found 500,
  and one internal error from the new Worker. All slots restored/released.
- 2026-09-18: Extended the observation cap to 90 seconds to measure convergence,
  returning immediately on a match. Added an explicit settling-time variable and
  soft operation assertions so failed first writes remain red without discarding
  subsequent rounds. No write retries. Inspecting live logs after cleanup.
