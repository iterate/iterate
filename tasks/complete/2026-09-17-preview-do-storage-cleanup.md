---
status: complete
size: large
---

# Experiment: clear preview DO storage without replacing the deployment

Experiment complete; do not adopt the inventory-and-wipe implementation.
PR #2693 includes the implementation, six runtime probes, all three controlled
cancellations, mature usage observations and a measured report. Normal cleanup
is restored; the observed slot was fully reclaimed. Final CI/PR-lease release
is tracked in the PR. The conditional planner follow-up is separate.

## Request

Try `deleteAll()`, `sync()`, and aborting the current Durable Object incarnation
instead of retiring its whole class through a replacement Worker deployment.
Keep the preview application usable. Containers owned by old tests may be killed.
Open a draft PR early, exercise pushes during different CI phases, and measure
post-cleanup DO active time with Cloudflare GraphQL. Do not merge automatically.

## Working assumptions

- Start from current `origin/main`, including the merged parallel preview and
  main-branch preview workflows. Keep unrelated retirement prototypes separate.
- The experiment may add a small authenticated operator cleanup surface and
  small DO lifecycle methods. Do not introduce a pervasive CI-specific policy
  into the product just to make this succeed.
- Restrict destructive experiments to the preview slot leased to this PR.
  Production and other PRs' slots are outside scope. Retain existing full erase
  as a recovery/backstop; never silently claim a failed sweep was successful.
- A wipe must cover background schedulers, stream processors and containers,
  not just the root project object. Explicitly investigate in-flight requests,
  late delivery, object discovery, facets, alarm retries and constructor effects.
- Reusing a deployment does not require restoring old test objects. Preserve
  shared application configuration when possible; report retained test data.
- Finish with a written report containing commits/run IDs, timing, unchanged
  deployment identity, cleanup coverage, request/error telemetry and measured DO
  active time. Distinguish measurement limits from proven quietness.
- If this finishes before 05:00 Europe/London, refresh the existing lightweight
  change-type planner as a stacked no-PR branch, including the discussed
  ancestry-result inheritance and narrower Docs globs. Publish a compare link.

## Work

- [x] Implement the smallest useful cleanup experiment with a real runtime test. *`storage-cleanup.ts` plus six Miniflare probes and live trials.*
- [x] Open a draft PR and register it with the global review monitor. *PR #2693, registered through September 17.*
- [x] Establish a baseline and test normal post-test cleanup and reuse. *Baseline/full normal trials and fresh heartbeat on the unchanged deployment; reuse proof is limited to a partial sweep.*
- [x] Push during preparation, active tests and cleanup; record outcomes. *Runs B/C/D deliberately cancelled at all three phases; E used normal erase afterward.*
- [x] Probe active alarms, late delivery, in-flight work and container teardown. *Local runtime tests plus known-ID heartbeat and native reset-to-alarm correlation.*
- [x] Measure post-cleanup active time and inspect relevant logs/errors. *Stable30/35-minute GraphQL captures, confirmed discovery delay,17 failed resets,21 successfully reset IDs with later work.*
- [x] Run required checks and obtain an independent review; address findings. *All checks passed at98f89966e; independent code/report review addressed. E app timeout recorded without weakening tests; final CI on PR.*
- [x] Write the viability report and leave the experiment resources clean. *docs/experiments/preview-do-storage-cleanup.md; preview15 fully reclaimed, preview16 normal erase completed; final lease release follows CI.*
The conditional change-type planner follows in its own stacked worktree/task.
It must retain fallback deployment: this experiment did not unblock general
preview reuse.

## Implementation log

- 2026-09-16 22:18 UTC: base `5a37ad44ac`; PR #2659 and #2658 are merged.
  Existing Stream `reset()` already implements deleteAll/sync/abort. Several
  other DO constructors expect a name, while the Cloudflare inventory returns
  opaque IDs; discovery and cleanup after cold restart need explicit proof.

- 2026-09-16 22:29 UTC: real-runtime probes cover opaque-ID lookup after
  eviction, SQL/KV/alarm/memory wipe, version mismatch, in-flight request
  cancellation, explicit facet deletion and late recreation. Reset leaves no
  retirement marker. Product DOs persist their original name so ID-only operator
  calls can initialize them after eviction. Auth and artifact state is retained.
- Baseline run `v11zj80d0s`: all six browser shards passed. App tests failed on
  the existing `abandoned-project-goes-quiet` expected-failure test (its setup
  timed out). Full erase succeeded in 69.0 seconds (71.2s command wrapper).
  Namespace deletion prevents a complete delayed GraphQL cost baseline; do not
  misreport empty/deleted namespace metrics as zero usage.

- Independent review: cold Stream initialization can announce to ancestors,
  potentially recreating an already-wiped parent; removed/relocated facets are
  not enumerable through the current subscription catalog. Measure both rather
  than asserting a successful sweep means permanent retirement. Reset also
  removes the persisted name, so a stale ID-only retry can fail initialization.
  Post-run unsupported/503 must fail instead of falling back to full erase.
- Full repository typecheck, tests, lint, knip and formatting passed locally.

- 22:36 UTC: first implementation run failed before OS deployment because
  SHA-pinned packages were absent. PR had become conflicting with main's #2680,
  suppressing GitHub PR publication. Merged current main (including #2680,
  CLI-help fixes and os-next SDK moves); full `down` remains outside the
  experiment, and only normal `reset` selects storage cleanup.

- 22:44 UTC: normal run `t1vb9scrlp` passed all consumers and reset 403/403
  inventoried sandbox objects in 61.6s (65.1s wrapper). Tail-to-inventory
  correlation proves at least 1,045 new non-container DOs were omitted. A
  subsequent inventory starts returning those objects only after the sweep.
  This invalidates the current discovery strategy despite a green job.

- 22:52 UTC: starting controlled cancellation run B at `a614c4a11`, workflow
  `ddx7qrf5pn`. The next push will intentionally interrupt its prepare phase.
  Before this push, a fresh project ran a real five-second heartbeat on the
  unchanged deployment; direct scheduler and source-stream resets returned
  success and the native tail showed no subsequent calls to that pair.

- 22:56 UTC: pushed `e474dafb8` at 22:53:06 while B's pre-deploy sweep was
  active. Depot cancelled all B jobs. Replacement C (`7zzc4tr2fv` /
  `8jp447qqgm`) inventoried 6,339 objects and is progressing through its sweep.
  Known heartbeat pair had no native invocations for 124s after both resets;
  this is positive primitive evidence, separate from incomplete discovery.

- 23:09 UTC: C completed 6,322/6,339 reset requests in 457.9s; 11 Scheduler
  and six Stream requests failed. Existing acquisition retried on fresh preview-16, so its
  later readiness is not proof of repaired preview-15. Held preview-15 under
  `manual-pr2693-storage-observation` while collecting delayed analytics.
- All 256 native DO calls observed in preview-15 from 23:02–23:04:49 hit
  21 successfully reset IDs, including 97 alarms. No root product reads
  contaminated this interval. Unreset actors may still be driving them.
- Pushed `b1c9ca14c` during actual tests at 23:06:24. Replacement D is
  `4bgd89g8qg` / `0z958pn7qw`. Prepared a final push that removes automatic
  opt-in; it will interrupt post-test cleanup and exercise normal full erase.

- 23:16 UTC: third push interrupted D post-test sweep after4,876 inventory
  entries and at least1,638 logged successful resets. Replacement E normal
  erase took16.4s before deploy and17.3s afterward. All browser shards passed;
  one existing facet-source-version test failed with a different stream-timeout
  error. The report records this; no test changes were made.
- Mature observations:113.61 reported active-time-equivalent hours in the first
  post-sweep window; separate aggregate query agrees. Known scheduler/source
  pair has no later rows through the124s quiet interval. Report distinguishes
  analytics sums from verified billing and complete retirement.
- Observation lease15 fully reclaimed in69.8s after snapshots were saved.
  Collectors and tails stopped. Final report review narrowed the registry
  recommendation and added the central discovery/pair proofs to checked-in JSON.
