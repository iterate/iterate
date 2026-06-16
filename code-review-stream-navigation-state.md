# Code review: fix-stream-navigation-state (5b1b7c82e)

Reviewed against `docs/jonasland-rules.md`, diffed against merge-base with
`origin/main` (b86d71001). Typecheck passes on the branch as submitted.

## What the PR does

- Removes the `descendantPaths` namespace catalog from the stream core
  processor (added in #1449) and bumps `CORE_STATE_VERSION` 2 → 3, so every
  stream DO replays its event log on next wake.
- Removes `streams.list` end to end: os-contract route + `StreamCatalogRecord`,
  oRPC handler, `StreamsCapability.list()`, `ItxStreams.list()`, itx types.
- Introduces `StreamNavigationState`, a lenient subset schema, because
  `StreamState.parse` throws on real persisted processor state (the
  `external-subscriber` `legacy-do-binding` shape doesn't match
  `ProcessorsState`) — this was breaking the stream tree browser.
- Rewrites the terminal script's `listChildren` as a client-side BFS over
  `childPaths`, and updates tests/docs.

## Findings

### F1 (high, correctness) — stale assertion fails the codemode-session test

`apps/os/src/durable-objects/codemode-session.test.ts:375` still asserts
`functionCallRequested(["os", "streams", "list"], ...)` but the legacy
ctx-era script under test had moved to the stream read path. Verified failing.

- **A (chosen):** assert `["os", "streams", "read"]` — keeps coverage that
  nested `os.streams.*` paths produce function-call events.
- B: drop the matcher entirely.

### F2 (medium, rule: few abstractions / greppability) — schema hand-duplication

`apps/os/src/lib/stream-navigation-state.ts` re-declares five `StreamState`
fields by hand and already drifted (`namespace` lost `.max(255)` vs
`StreamNamespace`).

- **A (chosen):** `export const StreamNavigationState = StreamState.omit({ processors: true })`
  — one line, stays in sync, restores the constraint.
- B: keep hand-written but reuse `StreamNamespace`.
- C: fix `StreamState.processors` itself and delete this schema (right
  long-term fix, see F7 follow-up).

### F3 (low, rule: don't declare infrequently used things) — do-nothing wrapper

`parseStreamNavigationState(input)` just calls `StreamNavigationState.parse`.
The codebase idiom is calling `.parse` on the schema directly
(`StreamPath.parse(...)` everywhere).

- **A (chosen):** delete the wrapper; call sites use
  `StreamNavigationState.parse(...)`.
- B: keep only if it's about to grow behavior.

### F4 (low, rule: comments must give context) — the fence has no sign

The new schema file has zero comments. The entire reason it exists — the
canonical `StreamState` schema rejects real persisted processor state — is
invisible; a future reader will "simplify" back to `StreamState` and
reintroduce the bug.

- **A (chosen):** motivating doc comment on the schema (combined with F2's
  one-liner).

### F5 (low) — redundant e2e assertion

`apps/os/e2e/vitest/admin-project.e2e.test.ts:81`
`read.events.some(offset match)` is strictly weaker than the existing
`arrayContaining` assertion at lines 61–69 (same offset, plus payload + type).

- **A (chosen):** delete the line.
- B: replace with a `getState`/`childPaths` discoverability check — there is
  no oRPC getState surface in the e2e client today, so not cheap.

### F6 (low, rule: explicit names) — `rootStreamState` holds read events

`codemode-session.test.ts:345` names the stream read result `rootStreamState`.

- **A (chosen):** rename to `rootStreamRead` (matches the docs/examples which
  use `rootEvents` for the same call).

### F7 (medium) — terminal `listChildren` is one worker isolate per stream

`apps/os/scripts/event-stream-terminal.tsx:225-255` runs `runItxScript` (a
fresh dynamic worker isolate via `/api/itx/run`) once per discovered stream,
sequentially. A 50-stream project costs 51 sequential isolate loads to draw
the tree; the removed `list()` was one call.

- **A (chosen):** do the whole BFS in one itx script — ship the loop as
  `functionSource`, return the collected paths, one round trip.
- B: expose `listChildren`/`getState` on the oRPC contract (reopens the
  contract discussion).
- C: leave it with a depth cap (dev-only tool).

### F8 (flag for human, rule: contracts need explicit human sign-off) — no code change

The PR removes a routed public API (`GET /projects/{...}/streams`,
`StreamCatalogRecord`) and forces a fleet-wide DO event-log replay via
`CORE_STATE_VERSION = 3`, deliberately undoing #1449's one-call catalog.
The mechanics are sound (version-history comment kept, migration test
rewritten to cover the v2 → v3 replay), but the rationale for reverting a
days-old optimization is written down nowhere. Needs an explicit human ack +
a sentence in the PR description.

### Follow-ups (out of scope, not blocking)

- `StreamState` in `packages/shared/src/streams/types.ts` still doesn't parse
  real runtime state (`processors` mismatch) — the new test now permanently
  asserts "our canonical schema rejects our canonical state".
  `toLegacyStreamState` papers over it with `as` casts. Fix `ProcessorsState`
  to match what the core processor actually persists, then
  `StreamNavigationState` can be deleted.
- `StreamSummary.createdAt` is fabricated as epoch in the terminal tree (the
  removed `list()` did the same). Either surface real creation times or make
  the field optional in the TUI.

### Disproved during review

A subagent pass claimed the commit silently reverts #1442/#1451/#1438.
False positive: those landed on main after this branch's merge-base; the
commit doesn't touch those files, and a merge-base diff (what GitHub shows)
contains none of it.

# Plan (TODO)

- [x] F1A — fix stale `streams.list` assertion → `streams.read`
- [x] F2A+F4A — `StreamNavigationState = StreamState.omit({ processors: true })` + motivating comment
- [x] F3A — delete `parseStreamNavigationState`, call `.parse` directly (4 call sites + test)
- [x] F5A — delete redundant e2e assertion
- [x] F6A — rename `rootStreamState` → `rootStreamRead`
- [x] F7A — single-script BFS in event-stream-terminal `listChildren`
- [ ] F8 — human ack on contract removal + CORE_STATE_VERSION bump (flagged, no code change)
