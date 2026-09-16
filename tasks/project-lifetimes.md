---
status: in-progress
size: large
---

# Optional project lifetimes

New review branch from `codex/playwright-full-parallel`, replacing the design
in `codex/preview-run-retirement`. No PR and no live rollout.

Status: design specified; implementation and local proof next.

## Request

Stop abandoned recurring work through a general project lifetime, without
teaching core objects about previews, CI attempts or tests. Keep generated
project IDs and DO addresses unchanged. Preserve deployments for humans and
defer full data deletion to environment handover/release.

## Design

- A project's creation metadata may contain a lifetime: a fixed expiry and
  an optional retirement group. No lifetime means ordinary persistent behaviour.
- Group retirement can shorten a project's lifetime. CI assigns a distinct
  group to each attempt; retiring it is an immutable, idempotent operation,
  so stale finalizers cannot affect a new attempt or move a cutoff backwards.
- Runtime helpers live under `src/lib`, know only project metadata/lifetimes,
  and separate the decision from stopping alarms or container keepalive.
- Lifetime travels through ordinary project creation, including Auth-first
  creation. No test headers, preview checks, auth WeakMap or special Stream RPC.
- CI attempt bookkeeping and environment-reuse decisions stay in scripts.
- Keep the experiment off until browser/custom-client coverage, preserved-state
  isolation and deployed quieting have been proved. Local tests are not rollout proof.

## Work

- [ ] Implement lifetime evaluation with tests for expiry, group retirement and persistent projects.
- [ ] Preserve creation metadata through Auth and the OS project directory; test actual creation/cache behaviour.
- [ ] Guard recurring runtime work and prove retirement survives Stream eviction/rearming.
- [ ] Connect test creation and opt-in CI lifecycle without adding test concepts to runtime code.
- [ ] Document remaining live proof and run relevant tests/type/lint checks.
- [ ] Commit, push and provide a compare link against the parallelisation branch.

## Implementation notes

The group is a general resource lifetime group. A distinct group per CI attempt
is deliberately simpler than maintaining a shared mutable generation counter
in eventually consistent KV. The runtime needs no knowledge of how CI names it.
