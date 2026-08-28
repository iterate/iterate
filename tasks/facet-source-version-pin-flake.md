---
status: in-progress
size: medium
---

# Facet source-version pin flip-flops: demote the racy pin, keep the deterministic contract

## Status summary

Investigated and decided; implementation in this branch. The pinned bug
("a running userspace facet never picks up a source commit") turns out to be
a **race**, not a deterministic behavior — the same CI run produced both
outcomes minutes apart. A `failing()` pin requires the bug to fail
deterministically, so no version of this pin can be green-stable. Plan:
replace the pin with a plain test of the deterministic halves of the
contract, delete the companion blind-spot pin, and move the racy-pickup bug
to its own task (`tasks/facet-commit-pickup-race.md`).

## Evidence (2026-08-28, PR #2543 preview CI, slot preview-9)

Depot run `4pfjnjw0gn`, preview job, both attempts, same deployment:

- **Attempt 1 (~18:50Z): the bug did not manifest at all.** The pin's three
  rounds each saw the running facet replaced by one serving the
  just-committed revision within one or two 3s polls (whole test 84.9s).
  Workers Observability for `os-preview-9` shows
  `stream facet source changed; aborting` firing 12s apart for the pin's
  three transitions (18:51:15 / :27 / :40 — cacheKeys chain v1→v2→v3→v4) —
  perfectly commit-correlated, so these were NOT coincidental evictions:
  the marker-compare abort fired and the facet actually let go, three times
  in a row. Body succeeded → `failing()` inverted to red ("The test should
  have failed with /SAME-BOOT STALENESS/ but it succeeded").
- **Attempt 2 (~18:54–18:59Z): the bug manifested.** The pin failed once,
  then passed on the vitest retry — green for a `failing()` pin means the
  body threw the SAME-BOOT STALENESS error, i.e. a running facet ignored
  the commit for 45s+ on that try.
- Earlier run `62rpqlxqj3` on the same PR: the companion pin
  (`userspace-facet-recycle-false-alarm.e2e.test.ts`) also needed a vitest
  retry; it retried again in both attempts of `4pfjnjw0gn`.

Conclusion: `#abortFacetOnVersionChange` detects every commit promptly
(server logs prove the abort fires), but whether `ctx.facets.get` then
reattaches the aborted-but-running facet (staleness) or builds fresh
(pickup) is a workerd-internal race the test cannot control. The pin's
round design assumed replaces were *independent coincidences* ("roughly the
cube of an already-uncommon event") — they are neither independent nor
uncommon: they are the race resolving the same way, commit-correlated, all
three rounds. No boolean over rounds is deterministic when a bug-run and a
fixed-run can produce identical observable traces.

## Plan

- [x] Investigate the flip-flop: CI logs (both attempts), Workers
  Observability on `os-preview-9`, code path in
  `stream-durable-object.ts` (`#dialProcessorFacet` /
  `#abortFacetOnVersionChange`) _race confirmed; evidence above_
- [x] Rework `userspace-facet-source-version.e2e.test.ts` into a plain
  (non-`failing()`) test asserting only the deterministic contract
  _same probe instrument; keeps the marker-stability half verbatim, adds
  commit → kill → fresh-facet-serves-v2, documents the unasserted race_
- [x] Delete `userspace-facet-recycle-false-alarm.e2e.test.ts` _it pinned
  the OLD pin's blind spot, which no longer exists, and could never flip
  red on a platform fix_
- [x] New bug task `tasks/facet-commit-pickup-race.md` _evidence, workerd
  race mechanism, fix directions carried from platform-stall-repros
  thread 5_
- [x] Update `tasks/platform-stall-repros.md` thread-5 exit note _dated
  follow-up notes appended in both places_
- [x] Update the `failing()` docs _determinism rule added to
  failing-test.ts and docs/testing.md; worked-example pointers moved to
  project-create-concurrency + guarantees-not-given_
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format`, one green
  run of the reworked test against a live deployment, PR CI green
  _static checks green locally; live run in progress_

## Assumptions made while AFK

- "Deterministically hit the pinned bug" is not achievable from the client
  side: the race lives between `ctx.facets.abort` and the immediately
  following `ctx.facets.get` inside the Stream DO, and its odds visibly
  shift with platform conditions (5/5 stale at authoring on 2026-08-27;
  0/3 rounds stale in attempt 1 a day later, no relevant code change in
  between). So the task's "or re-evaluate the pin" arm applies.
- The deterministic replacement test keeps the file name
  `userspace-facet-source-version.e2e.test.ts` (same subject, same probe
  instrument).
