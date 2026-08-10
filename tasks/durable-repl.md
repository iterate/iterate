---
status: in-progress
size: large
---

# Durable REPL

## Status summary

Spec fleshed out; implementation under way. Main pieces: REPL runs execute as
real scope scripts (`runScript`) in a per-user scope, stream-derived history,
session REPL deletion, examples audit, editor types from the scope preamble,
spec updates.

Make the product REPL run scripts through the capability-host script runner on
a dedicated per-user scope, replacing in-browser evaluation. That is the same
path agent scripts take (`itx.capabilityHost.runScript(code)`): typechecked
against scope capability types, journaled as
`script-run-requested`/`script-run-settled` on the scope stream, outcomes
feeding the scope's derived `results` preamble.

## Settled decisions (final)

1. REPL Runs execute as real scope scripts; each Run settles on a stream and
   feeds the same derived `results` preamble agents get (`results[0].data`
   inline, `await results[0].load(itx)` for large —
   capability-host-preamble.ts).
2. NO live persistent-isolate REPL. Continuity is derived-and-durable only.
3. ONE REPL type. DELETE the session REPL: browser-eval
   (src/itx/browser-repl.ts) goes away wholesale; the REPL always has a project
   context. Session-context catalogue examples repointed or retired (audited
   below).
4. Runs execute in a dedicated per-user scope `/repl/<user-id>`, reached via
   `itx.capabilityHosts.get(path)`. Scope birth = the standard
   `capabilityHosts.get(path).create()` batch (default birth certificate
   already records the one-hop fallback to the project root host via
   `capabilityFallbackForScope`), so capability reads resolve project-wide.
5. History is STREAM-DERIVED: the entry list renders from the scope's
   `script-run-requested`/`script-run-settled` events plus local in-flight
   state for the pending Run only. Reload restores the session. No useEffect,
   no useState where tanstack-query derivations work (the raw stream
   connection buffer uses the blessed `useStreamConnection` callback pattern
   from itx-activity-tail.tsx — a push stream is not a query).

## Recommendations (implement, keep cheap)

- In-editor TS: feed the scope's assembled preamble (`getPreamble()`) into the
  codemirror TS worker as a virtual module so `results` autocompletes with real
  types. Best-effort; any failure falls back to today's itx-only types.
- Console capture dropped for v1 — return values are the output. Console UI
  affordance removed.
- Typecheck gate as-is (agent parity). Run latency now includes typecheck +
  dynamic-worker spin-up; noted, not fixed here.
- `/_app/itx-repl` becomes a minimal project chooser linking to per-project
  REPLs. Sidebar link stays pointed at it.
- Stable addressing (`results.byOffset(n)`) out of scope — follow-up.

## Assumptions added while fleshing out (delineated — not from the grill)

- **User identifier**: `useAuthClient().session.user.id` (the auth user id) —
  the only stable identifier the web session exposes; slugs/emails can change.
  Scope path: `/repl/<user-id>`.
- **Explicit `return`**: `runScript` executes `async (itx) => { ... }` bodies;
  the browser REPL's "last expression is the result" magic dies with the
  in-browser evaluator. The REPL wraps the typed body as
  `async (itx) => {\n<body>\n}` (injecting `const vars: Record<string, any> = {}`
  only when the body doesn't declare its own `vars`), and the default snippet
  and help copy now use explicit `return`. History unwraps the deterministic
  wrapper for display.
- **`$_` / `_` die**: the mutable browser scope is deleted; continuity is
  `results[0].data` / `results[N].load(itx)` — same as agents.
- **npm imports die**: the old REPL rewrote `import` lines to esm.sh in the
  browser; server-side scripts have no module loader (agent parity — agents
  can't import npm packages in scripts either). No catalogue example used
  top-level imports.
- **`/admin/repl` deleted**: it was a session REPL for admins; admins use
  per-project REPLs like everyone else. Admin sidebar link removed.
- **Examples audit outcome**:
  - Session-context entries (`whoami`, `list-projects`) lose the `browser`
    runtime (node/cli reading material; the examples sheet marks them
    not-runnable-here).
  - Live-capability entries (`provide-live-capability`,
    `provide-live-flattened`) lose the `browser` runtime: Runs execute
    server-side, so the browser can no longer be the live provider process
    from the REPL. Node/cli e2e matrix coverage keeps them proven.
  - `specs/repl-examples.spec.ts` filters to browser-runnable cases instead of
    throwing on non-browser cased examples; the matrix meta-assertion is
    relaxed the same way.
- **Entry statuses**: requested-without-settlement renders as running;
  settlement renders success (settlement.result) or error (settlement.error).
  The stream is the source of truth as soon as the request event lands; the
  local pending row exists only for the append round-trip window.

## Checklist

- [x] Task file committed, draft PR opened _initially as `repl-on-script-door`; renamed to `durable-repl` (jargon purge), PR reopened_
- [ ] `ItxScopeRepl` container: per-user scope path, host `create()` via
      suspense query, `useStreamConnection` history buffer, run mutation
      through `capabilityHosts.get(path).runScript(wrapped)`
- [ ] Presentational `itx-repl.tsx` reworked: stream-derived entries,
      running/success/error states, console affordance removed, copy updated
      (`return`, `results[0]`)
- [ ] Delete `src/itx/browser-repl.ts` + `browser-repl.test.ts`; REPL routes
      re-wired (`/projects/$slug/repl` project REPL, `/_app/itx-repl` project
      chooser, `/admin/repl` removed)
- [ ] Editor scope types: worker `setScopeContext` + preamble query feeding a
      virtual module; `results` autocompletes; failure falls back silently
- [ ] Examples audit implemented (runtimes updated, generated file regenerated
      via `pnpm generate:itx-examples`)
- [ ] Specs updated: repl-examples filters to browser-runnable; forged-session
      spec still passes on the new run path; matrix meta-assertion relaxed
- [ ] Unit tests: entry derivation (requested/settled interleavings, unwrap,
      pending dedupe) + repl-types test updated
- [ ] Live verification: run entries, reload restores history
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test`

## Follow-ups (deliberately out of scope)

- **Scope picker**: let the REPL attach to other scopes — most notably an
  agent's scope, making the REPL a shared console with that agent (you see its
  `results`, it sees yours).
- **Stable addressing**: `results.byOffset(n)` or similar, so an entry can be
  referenced durably instead of by newest-first index.
- **Journaled console output**: capture console from script execution into the
  settlement (or a sibling event) so the REPL can render logs again — needs a
  settlement schema change, punted with the console UI affordance.
- **Run latency**: each Run pays typecheck + dynamic-worker spin-up. If it
  feels bad, consider a warm worker per scope or an optimistic
  skip-typecheck-for-repl mode (explicitly NOT done here — agent parity).

## Implementation log

- Studied surfaces on origin/main post-#2395: runScript lives on
  `CapabilityHostRpcTarget` (rpc-targets.ts ~5927) over
  `runCapabilityHostScript` (capability-host-script-run.ts); host birth =
  `capabilityHostCreationEvents` (capability-host-defaults.ts); preamble
  assembly in capability-host-preamble.ts; settlement schema in
  packages/shared/src/script-execution.ts (`succeeded.result` carries the full
  JSON result — the REPL renders it straight off the settled event).
- Stream reading: `useStreamConnection((itx) => itx.streams.get(path).openConnection({replayAfterOffset: 0, processEventBatch}))`
  per itx-activity-tail.tsx; offsets dedupe replay overlap on reconnect.
- Renamed from `repl-on-script-door` to `durable-repl` mid-flight: "script
  door" jargon banned; prose now says what it is — runs execute as real scope
  scripts via `runScript`, the same path agent scripts take.
