---
status: ready
size: large
blocks: agent-birth-userland-refactor
---

# Worker delivery obligations: the config-worker event feed becomes load-bearing

## Status summary

Not started. Fully specced via plannotator review of the agent-birth refactor
plan (local explainer: `explainers.ignoreme/agent-birth-refactor-plan.html`,
gitignored — key facts inlined below). Prerequisite for
[agent-birth-userland-refactor](agent-birth-userland-refactor.md): that
refactor makes every agent birth *and every turn* depend on this delivery
path, and readiness holds hang forever on dropped deliveries.

## Problem

The subscription that delivers committed stream events to a project's config
worker is "observation-grade": skip-on-failure (a failed delivery advances
the cursor — events are dropped, never retried), and the cursor starts at
"now" (events committed while the worker is still building are never seen).
Observed consequences: birth handovers dropped during a project's first
~1-minute build; "minutes late" conversions rescued only by sweeps. Jonas:
"quite a few bugs in the vibeslopped dynamic worker invocation and stream
processor subscription paths" — this task is where those get enumerated and
fixed.

## Checklist

- [ ] Audit the dynamic worker invocation + subscription delivery paths
      (`apps/os/src/domains/streams/`, worker dispatch in
      `apps/os/src/domains/workers/`); write up the failure modes found
      (append to this file)
- [ ] Park-and-retry with backoff replaces skip-on-failure for the
      project-worker delivery (at-least-once, per-stream ordered)
- [ ] Defined start cursor: events queue while the worker is building; the
      first successful delivery starts from the subscription's start point,
      not "now" — no missed births, ever
- [ ] Dead-letter visibility: after N failures, a loud, queryable record
      (project-level event), not silence
- [ ] Watchdog groundwork if cheap: "expected follow-up event didn't arrive
      within X ms" detection (full primitive can be a follow-up)
- [ ] Tests per docs/testing.md: dropped-then-recovered delivery, worker
      cold-build window, handler-throws retry/backoff/dead-letter,
      ordering preserved across retries
- [ ] No regression to the "can't wedge the stream" property: delivery
      failures must never block appends or other subscribers

## Notes

- Latency is explicitly out of scope (separate speed round after the birth
  refactor); this task is about *never losing* deliveries, not making them
  fast.
