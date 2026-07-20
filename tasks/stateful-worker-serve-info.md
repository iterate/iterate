---
state: todo
priority: medium
size: small
dependsOn: []
---

# Stateful worker serve-info mini PR

Deferred from the worker-serve-overlay work (PR #2071 era) until the sandbox
builder-pool PR (#2083, merged 2026-07-18) landed: surface serve info
(fresh/stale, commit, failure) for STATEFUL dynamic workers the way stateless
serves already carry it, so the overlay and `x-iterate-worker-serve` header
tell the truth for Durable Object-backed apps too. A prepared worktree exists
(agent-ae51d4724056a839d) but predates the pool refactor and needs a rebase
onto main.
