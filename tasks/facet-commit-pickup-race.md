---
status: ready
size: large
---

# A running userspace facet sometimes never picks up a source commit

## Status summary

Bug record, not yet started. A config-repo commit reaches a RUNNING
userspace facet only when a workerd-internal race resolves the right way;
when it resolves the wrong way, the facet serves stale code for the life of
the parent incarnation — indefinitely, for a stream that never hibernates
(an open outbound WebSocket blocks hibernation, which is exactly what a
live voice call holds). This used to be pinned by a
`failing(test, /SAME-BOOT STALENESS/)` test; the pin was removed because a
racy bug cannot be pinned deterministically
(tasks/facet-source-version-pin-flake.md has that story). The fix work
lives here now.

## The mechanism

`StreamDurableObject.#dialProcessorFacet` re-resolves the facet's source on
every delivery and calls `#abortFacetOnVersionChange` before every
`ctx.facets.get`. The marker compare works: after a commit, the very next
dial logs `stream facet source changed; aborting` and calls
`ctx.facets.abort`, then updates the KV marker. The race is what happens
next: the immediately following `ctx.facets.get` either

- builds a fresh facet from the new startup class (pickup — observed), or
- reattaches the aborted-but-still-running facet, which keeps serving the
  old code (staleness — observed). Because the KV marker was already
  updated, no later dial ever aborts again: the facet is stale until the
  parent incarnation dies.

## Evidence

- Authoring time (2026-08-27, #2534): staleness 5/5 — a running facet
  answered 15-172 consecutive deliveries over 45s from one boot id on the
  old key after a commit; one `stream.kill()` brought it back rebuilt. Two
  server-side fixes were tried and measured (abort + scheduler yield;
  marker write + abort + storage sync + `this.ctx.abort()`); neither
  worked, both reverted.
- 2026-08-28, preview-9 (Depot run `4pfjnjw0gn`, PR #2543): both outcomes
  within minutes on one deployment. Attempt 1: three commits, three prompt
  replacements (~one 3s poll each); Workers Observability shows the abort
  log commit-correlated at 18:51:15/:27/:40Z. Attempt 2: staleness for
  45s+ on the first try (the then-pin passed on retry).

No relevant OS code changed between those two dates — the odds moved with
the platform, which points at workerd's facet abort/get semantics
(`ctx.facets` is a beta surface).

## Impact

A stream that never hibernates never retires its incarnation, so "stale
until the incarnation dies" is unbounded. Concretely: commit a fix to a
voice-agent processor while a call is up, and the call may keep running the
old code with no signal anywhere that it did.

## Fix directions (from tasks/platform-stall-repros.md thread 5, extended)

- [ ] Make the abort actually take effect before the next `ctx.facets.get`,
  or detect reattachment: after an abort, verify the facet that `get`
  returns was built from the new class (e.g. challenge it for its
  `ITERATE_WORKER_VERSION` and abort again on mismatch — bounded retries,
  loud failure). The 2026-08-27 attempts show naive yields are not enough;
  measure any candidate against the race on a real deployment, both
  quiet and busy.
- [ ] Rebuild provenance: facet rebuilds record their trigger
  ("source-commit <key>" vs "cold-boot"), the way subscription halts
  record `workerVersion`. Makes the race observable in production and
  gives any future test causality instead of coincidence to assert on.
- [ ] If workerd's semantics are the blocker, reduce to a minimal repro and
  file/track upstream (cloudflare/workerd) — `ctx.facets.abort` followed
  by `ctx.facets.get` with a new startup class reattaching the old
  instance is either a workerd bug or a contract we're misreading.

## Testing note

Do not re-add a `failing()` pin for the stale side of the race — that is
the flake generator this task replaced
(tasks/facet-source-version-pin-flake.md). The deterministic surrounding
contract (marker stable while unchanged; fresh facet after a kill serves
the committed source) is covered by
`apps/os/e2e/vitest/userspace-facet-source-version.e2e.test.ts`. Once a fix
makes pickup deterministic, extend that test with the running-facet
assertion (commit → the SAME parent incarnation replaces the facet) and it
becomes the regression test.
