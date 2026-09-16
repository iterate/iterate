---
status: complete
size: large
---

# Optional project lifetimes

Review branch against `main`, replacing the design in
`codex/preview-run-retirement`. PR #2659 has merged. No PR and no live rollout.

Status: review implementation complete. Generic lifetimes, ordinary creation
metadata, runtime guards and the opt-in CI path are implemented. Local checks
pass; the experiment remains off pending the live checks in
`docs/project-lifetimes.md`.

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

- [x] Implement lifetime evaluation with tests for expiry, group retirement and persistent projects. _Shared schema and src/lib/project-lifetime.ts; remembered deadlines and terminal expiry survive eviction._
- [x] Preserve creation metadata through Auth and the OS project directory; test actual creation/cache behaviour. _Auth create/update boundaries validate lifetime metadata; OS passes it through and the Auth-first directory test preserves it._
- [x] Guard recurring runtime work and prove retirement survives Stream eviction/rearming. _Stream, Scheduler, StatefulWorker and Sandbox use the generic decision; Stream behaviour is exercised with the real runtime fixture._
- [x] Connect test creation and opt-in CI lifecycle without adding test concepts to runtime code. _Explicit test creation metadata, browser Auth-request fixture, and scripts/lib/preview-lifetimes.ts; workflow switch stays false._
- [x] Document remaining live proof and run relevant tests/type/lint checks. _34 runtime/creation tests, 13 Auth tests and 214 preview/tooling tests; OS, Auth, Auth-contract, scripts, streams, shared and specs type checks. CLI help and scoped lint/format checked._
- [x] Commit, push and provide a compare link against main. _codex/project-lifetimes against main; no PR._

## Implementation notes

The group is a general resource lifetime group. A distinct group per CI attempt
is deliberately simpler than maintaining a shared mutable generation counter
in eventually consistent KV. The runtime needs no knowledge of how CI names it.

- No preview/test names or environment checks were added to runtime policy.
  The optional PROJECT_LIFETIMES binding controls availability in any environment.
- Auth contracts share the pure Zod schema; the contract import allowlist gained
  one exact entry. No server/Node dependencies were introduced there.
- Explicit-ID admin recreation is KV-backed; its concurrency needs deployed
  proof before enabling, alongside custom clients and retained global state.

- Merged main at `17e937695` after PR #2659 landed. The restored old branch
  is no longer the comparison base.
