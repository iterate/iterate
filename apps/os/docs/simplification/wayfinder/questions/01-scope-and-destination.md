# Q01 — Scope & destination: is the deliverable a clean-room permutation lab?

**Round 1. Status: open.**

## The question

Is the immediate deliverable a **clean-room (`apps/kernel`) experimentation harness** — each lattice
rung a minimal, runnable, provable profile — with the `apps/os` migration treated as a **separate,
later track**? Or do we drive the os-migration now, in lockstep?

## Why it's the root

Everything else (bundle count, capability shape, which permutations, how we prove them) hangs off
whether we're building a _lab_ or _productionizing os_. fable-migration is an entire proposal about the
os-migration path (9 PRs, "os becomes the runner"); the other 7 are about the target architecture.
These are two different jobs with two different risk profiles.

## Options

- **(A) Clean-room lab first.** Harness `apps/kernel` so each rung spins up minimally; prove each works;
  os-migration is Part 2. _Matches Jonas's stated end-goal ("harness the clean room to explore the
  smallest possible version of each permutation")._
- **(B) Os-migration now.** Follow fable-migration's 9-PR sequence against real `apps/os`; the lab falls
  out as a side effect. Higher stakes, real data gravity, slower to explore.
- **(C) Both in parallel.** Lab drives design; migration lands incrementally behind it.

## Recommendation: **(A).** The clean room is the cheap, safe place to find the smallest elegant version

of each rung. Migration is a downstream consequence once the shapes are proven — and fable-migration's
own thesis (data gravity, os-becomes-runner) is _easier to commit to_ after the lab shows the target.
