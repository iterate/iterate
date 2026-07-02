---
state: todo
priority: high
size: medium
tags: [os, itx, performance, projects]
---

# Cold-slot project creates can exceed 60s — find and fix the slow step

`projects.create` resolves only when the project is usable (auth register →
repo seed → project worker probe → onboarding agent birth). Warm, this takes
~5–7s (see any e2e run). On a freshly deployed stage, first-touch creates
have been observed to exceed 120s under concurrent suite load (preview CI
runs on 2026-07-02: rotating "Timed out waiting for stream event … saw 0
events" failures across admin-project / stream-security / agent-tools, each
a create stuck in the saga).

The saga timeout is deliberately tight (60s in rpc-targets.ts) so this
surfaces as failure signal instead of being waited out; preview CI warms
slots with one sequential onboarding-smoke create before the suites.

Suspects to measure (per-step timing events on the create saga would settle
this quickly):

- CF Artifacts repo creation + seed commit on first touch
- sequential cold DO chain (project → stream → repo → worker → agent), each
  paying isolate spin-up
- the project worker probe compiling the seeded worker via the dynamic
  worker loader on a cold isolate

Fix ideas once measured: parallelize independent saga steps, pre-warm the
loader path at deploy, batch the birth appends.
