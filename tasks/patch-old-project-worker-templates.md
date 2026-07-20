---
state: todo
priority: high
size: small
tags: [os, template, observability, fleet]
---

# Patch existing projects' seeded worker.ts (template fixes only reach new projects)

Every project repo carries its own frozen copy of the seeded
`config-repo-template/worker.ts`; template fixes only apply to projects
created after the fix ships. Known drift in old copies:

- **Worker-bundler ref migration (#2144 rollout requirement)**: projects
  created before the direct worker-bundler API shipped contain frozen dynamic
  worker refs in the retired `{ files, options }` / Vite recipe shapes. The new
  public boundary deliberately returns 400 for these refs instead of carrying
  a compatibility shim. Existing repos must be migrated to
  `source: { createWorker: ... }` or `source: { createApp: ... }` before the
  breaking deployment reaches production.
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

Approach sketch: a one-shot admin script that walks projects, identifies the
retired ref shapes, and commits the minimal source migration. It can also diff
`worker.ts` against the current template and apply other deltas where the file
is unmodified from ITS seeded version; projects that customized their worker
need a human or agent merge. The ref migration is breaking and must gate the
#2144 production rollout. The disposal warning alone remains benign noise.
