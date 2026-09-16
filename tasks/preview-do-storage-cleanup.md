---
status: in-progress
size: large
---

# Experiment: clear preview DO storage without replacing the deployment

Draft PR #2693 is open. The operator sweep and real-runtime probes are in place;
six runtime checks pass. The first live suite passed, but REST discovery missed
at least 1,045 new DOs and reset only 403 old sandbox objects. Reuse probes,
interruption cases, delayed metrics and the final recommendation remain.

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

- [x] Implement the smallest useful cleanup experiment with a real runtime test. *`storage-cleanup.ts` plus six Miniflare probes; live proof pending.*
- [x] Open a draft PR and register it with the global review monitor. *PR #2693, registered through September 17.*
- [ ] Establish a baseline and test normal post-test cleanup and reuse.
- [ ] Push during preparation, active tests and cleanup; record outcomes.
- [ ] Probe active alarms, late delivery, in-flight work and container teardown.
- [ ] Measure post-cleanup active time and inspect relevant logs/errors.
- [ ] Run required checks and obtain an independent review; address findings.
- [ ] Write the viability report and leave the experiment resources clean.
- [ ] If time permits before 05:00, stack the change-type planner without a PR.

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
