---
status: in-progress
size: large
---

# Experiment: clear preview DO storage without replacing the deployment

Spec committed first. Implementation and live experiments are pending. The
deliverable is an evidence-backed viability report, including a negative result
if safe cleanup needs disproportionate product machinery.

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

- [ ] Implement the smallest useful cleanup experiment with a real runtime test.
- [ ] Open a draft PR and register it with the global review monitor.
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
