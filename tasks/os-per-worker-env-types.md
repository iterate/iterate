---
state: todo
priority: low
size: medium
tags: [os, workers, typescript]
---

# Per-worker Env precision (post worker split)

The worker split (worker-topology.md) kept ONE global `Env` type: the union
of every worker's bindings (`src/lib/worker-env.d.ts`, interface-extends to
dodge the TS7022 cycle). That means `env.ANYTHING` typechecks everywhere
even when the binding only exists in some workers — runtime presence is
enforced by which worker the module runs in, plus the narrow per-class Env
types some classes already declare.

Possible deepenings, in rough order of value:

- lint rule: modules under `src/workers/<w>`-reachable graphs may only read
  bindings the worker actually declares (needs an import-graph pass — maybe
  too clever);
- make more DO/entrypoint classes declare narrow Env types (cheap, local,
  already idiomatic — `ProjectIngressEntrypointEnv` pattern);
- per-worker `Env` aliases exported from `worker-env.d.ts` so new code can
  opt into precision (`StreamWorkerEnv` etc. already exist there as
  internals).

Deliberately not done in the split PR: a tsconfig-project-per-worker setup.
Too much build machinery for the payoff.
