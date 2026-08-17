---
state: todo
priority: medium
size: small
tags: [os, template, observability, fleet]
---

# Patch existing projects' seeded worker.ts (template fixes only reach new projects)

Every project repo carries its own frozen copy of the seeded
`configs/default/worker.ts`; template fixes only apply to projects
created after the fix ships. Known drift in old copies:

- **Stub-disposal leak (#1845 follow-up)**: the agent-birth reaction drops its
  `env.ITX.get()` root stub, so every agent birth in an OLD project emits one
  workerd "An RPC stub was not disposed properly" warning into prd
  observability logs. New projects release the stub via try/finally (guarded —
  a throwing dispose after the append would double-apply birth defaults on
  redelivery, since those events carry no idempotency key by design per
  #1831).
- Whatever else has accumulated since each project's creation (this stacks on
  the older "patch old prd repos' worker.ts" note from the userspace project
  processor work, #1761/#1778).

Approach sketch: a one-shot admin script that walks projects, diffs their
`worker.ts` against the current template, and commits the delta where the file
is unmodified from ITS seeded version (projects that customized their worker
need a human or an agent to merge). The warning is benign noise, not
breakage — prioritize accordingly.
