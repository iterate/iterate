---
status: complete
size: medium
---

# Experiment: a new OS Worker name for each preview run

Status: complete for the unique-Worker experiment. Ten live cases measured 288
operations at 0/15/30/90-second delays. Immediate routing is unsafe; inactive DO
resets also occurred after 90 seconds. Results and a repeatable harness are ready
for review; all cloud resources were restored/retired and leases released.
The separate rested-slot/tagging experiment and full-OS adoption remain future work.

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
- [x] Measure unique Worker direct requests, stable-host cutovers, and handoff timing
  with multiple real changed builds. Preserve failed first calls and final DO state.
  *All four timing groups complete; 24 measured rounds, 288 unretried operations.*
- [x] Verify original routing restored, experimental namespaces retired, and lease released.
  *Final independent audits: ten original route owners, 35 parked Workers, zero
  owned namespaces, and zero remaining owned leases.*
- [x] Trace how a unique OS name changes real deployment resources; if the route
  experiment supports proceeding, exercise a representative OS deployment/smoke
  without silently reusing an old run's Durable Objects.
  *`RESULTS.md` maps buckets, services and container bootstrap. Immediate and
  15-second failures rule out immediate adoption; no full-OS/CI result is claimed.*
- [x] Write a concise results table with timings, failure categories, limitations,
  and an adopt/reject/further-test recommendation. Run appropriate local checks.
  *`experiments/preview-worker-per-run/RESULTS.md`; targeted typecheck, lint,
  formatting and opt-out discovery verified. No full-OS or main-CI result claimed.*
- [x] Commit and push the experiment, with proposed PR body in commit messages; no PR.
  *`codex/experiment-preview-worker-per-run`, based on the existing repro branch;
  spec and harness commits followed by the final results commit.*

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

- 2026-09-18: Repeated immediate handoffs exposed 18 successful writes on the wrong
  build, explicit resets during old-Worker retirement, and an inactive-instance
  reset inside a fresh Worker. The latter left persisted progress unfinished.
- 2026-09-18: The 15-second matrix completed 107/108 operations correctly. One new
  DO still became inactive with no concurrent retirement; logs confirm the version
  and the record remained started at progress 38. Increased the next comparison to
  30 seconds rather than pursuing a shorter 5-second candidate.
- 2026-09-18: Added an explicit account namespace audit after retirement. Strengthened
  route restoration to compare the saved public response as well as the route owner.

- 2026-09-18: The 30-second run also interrupted a fresh DO, leaving progress 59.
  Added a 90-second deployment-age control with old Workers left live; the fixture
  bounds the explicit experiment delay to 90 seconds. This changes no product gate.
- 2026-09-18: Independent read-only audit of the first nine cases confirmed 31
  parked Workers, zero remaining owned namespaces, and all original route owners.

- 2026-09-18: The 90-second control also interrupted one fresh DO (progress 34,
  unchanged code version, new boot ID). All delayed groups routed to the intended
  build, but none establishes a reliable operation-completion guarantee. The
  inactive-instance cause and repeated third-round pattern remain unresolved.
- 2026-09-18: Final independent audits confirm all ten route owners restored,
  all 35 experimental Workers parked, no owned DO namespaces, and no owned leases.
  Root worktree and product deployment policy were left untouched; no PR opened.
