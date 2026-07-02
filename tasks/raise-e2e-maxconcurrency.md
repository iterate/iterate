---
state: todo
priority: high
size: medium
tags: [os, e2e, ci, performance]
---

# Raise e2e maxConcurrency back up (currently pinned to 2)

`apps/os/e2e/vitest.config.ts` runs the e2e suite with `sequence.concurrent`

- `maxWorkers: 4` + **`maxConcurrency: 2`** (peak ~8 concurrent tests). 2 is a
  deliberate stopgap: higher values overloaded the deployed preview slot —
  `maxConcurrency: 6` (peak ~24) hit "Durable Object storage operation exceeded
  timeout", and `3` (peak ~12) still failed a timing-sensitive teardown test.
  The slot, not the runner, is the bottleneck: every e2e test creates a project
  (a whole DO chain), so concurrency multiplies cold/near-cold creates against
  one slot.

Goal: get back to ~6+ concurrent (the itx suite is 38 tests in one file and
dominates the vitest lane) without slot overload. Approaches, likely combined:

- **Split the itx monolith** (`e2e/vitest/itx.e2e.test.ts`, 38 tests, ~287s
  sequential) into several files. File-level parallelism (`maxWorkers`) then
  speeds it up at a _safe_ per-file concurrency — the clean way to get speed
  without cranking `maxConcurrency`.
- **Fix cold-slot create latency** ([[project_preview_e2e_speedup]] and
  tasks/os-cold-create-latency.md — someone is already on the 30-90s cold
  OAuth-callback / create-saga issue). Faster, more robust creates raise the
  concurrency ceiling directly.
- Consider a bigger/reserved preview slot, or pre-warming more of the create
  path at deploy.

Validate each bump with a preview dispatch and watch for "DO storage exceeded
timeout" / timing-teardown flakes.
