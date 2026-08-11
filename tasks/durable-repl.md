---
status: in-progress
size: large
---

# Durable REPL

## Status summary

Implementation complete; CI fully green (incl. preview e2e after main's
mobile-approvals fix merged); all four Bugbot threads fixed and resolved.
Live-verified: runs execute server-side via
`runScript` in `/repl/<user-id>`, history restores from the scope stream on
reload (verified in a real browser, incl. a typecheck-gate error entry and a
`results[0].data` continuity run), all checks green. Remaining: review.

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
4. Runs execute in SESSION STREAMS `/repl/<timestamp-slug>` (REVISED by
   Misha a second time — supersedes the shared-singleton `/repl`, which
   itself superseded per-user `/repl/<user-id>`): now that REPLs are real
   streams they get full agent-style paths (the `/agents/web/<timestamp>`
   convention, see ~/lib/repl-session.ts), the URL carries the suffix
   (`/projects/<slug>/repl/<timestamp-slug>` — the URL IS the stream path,
   so sharing it shares the console), and `/repl` joins the sidebar's
   path-style surfaces. Bare `/repl` resumes the MOST RECENT session
   (a console should be where you left it), minting a fresh stream only
   when none exists (router `replace`, so back-button behavior stays sane);
   a "New REPL" header button mints a fresh session explicitly. Birth is
   unchanged: the standard `capabilityHosts.get(path).create()` batch with
   the one-hop fallback to the project root host, so capability resolution
   is identical. `results` continuity is per-session — a fresh console is a
   fresh Out[n] — and stable byOffset addressing is per-stream, unaffected.
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
- ~~Stable addressing (`results.byOffset(n)`) out of scope — follow-up.~~
  _Pulled INTO the task with the shared-scope revision: every results row now
  carries its settlement's stream `offset`, the assembled array wears
  `results.byOffset(n)` (throws outside the retained window), and the REPL
  labels each entry `#<offset>`. Lives in capability-host-preamble.ts, so
  agents get it too; documented in that file's header._

## Assumptions added while fleshing out (delineated — not from the grill)

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
- **`/_app/itx-repl` deleted** (revision follow-through): briefly a project
  chooser; with the route settled as `/projects/<slug>/repl` (matching the
  `/media` convention) the session-level page and its global sidebar entry
  went away — the project sidebar's `/repl` entry (path-style group,
  alongside /repos, /agents, /integrations; OS app only, NOT the mobile
  drawer) is the way in.
- **Bare-`/repl` resume policy** (delineated, per Misha's stated assumption):
  most-recent-session resume, fresh mint only when the project has none. No
  session switcher for now (the resolver + New REPL cover the flows; a
  listing UI is a follow-up if sessions proliferate).
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
- [x] `ItxScopeRepl` container: per-user scope path, host `create()` via
      suspense query, `useStreamConnection` history buffer, run mutation
      through `capabilityHosts.get(path).runScript(wrapped)` _apps/os/src/components/itx-scope-repl.tsx; pure derivation in itx-scope-repl-entries.ts_
- [x] Presentational `itx-repl.tsx` reworked: stream-derived entries,
      running/success/error states, console affordance removed, copy updated
      (`return`, `results[0]`) _same testids kept so the Playwright specs' contract held_
- [x] Delete `src/itx/browser-repl.ts` + `browser-repl.test.ts`; REPL routes
      re-wired (`/projects/$slug/repl` project REPL, `/_app/itx-repl` project
      chooser, `/admin/repl` removed) _routeTree regenerated; admin sidebar entry dropped_
- [x] Editor scope types: worker `setScopeContext` + preamble query feeding a
      virtual module; `results` autocompletes; failure falls back silently _replScopeModules in itx-repl-types.ts; preamble refetched after every settled run_
- [x] Examples audit implemented (runtimes updated, generated file regenerated
      via `pnpm generate:itx-examples`) _LIVE_SESSION_RUNTIMES → node/cli; new INTERACTIVE_RUNTIMES keeps browser for model/account reading material_
- [x] Specs updated: repl-examples filters to browser-runnable; forged-session
      spec still passes on the new run path; matrix meta-assertion relaxed _90s budget for the cold path; spinner-waiter bypassed for the run wait_
- [x] Unit tests: entry derivation (requested/settled interleavings, unwrap,
      pending dedupe) + repl-types test updated _itx-scope-repl-entries.test.ts (8 tests); repl-types tests cover the typed results modules_
- [x] Live verification: run entries, reload restores history _local dev + real browser: describe run, results[0].data continuity run, typecheck-gate error entry; hard reload restored all three from the stream. forged-session-repl + describe-project/run-script playwright specs green against dev. Re-verified after the shared-scope revision: entries labeled #16/#21, `results.byOffset(16)` returned the first run's data from the second run, reload restored both_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test` _all green locally (2743 vitest passes in apps/os)_

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
- Live verification notes: nested `runScript` from a REPL run works (the
  "run-script" catalogue example passes through the REPL in 6.5s — no
  deadlock); a provable typo (`awaitt`) settles as a journaled error entry
  carrying the compiler diagnostics; the dev-server OOM auto-restart
  (dev.ts, PR #2401) tripped once mid-verification — unrelated to this
  change, restart resumed cleanly.
- Shared-scope revision (Misha, mid-review): scope `/repl` (not per-user),
  route stays `/projects/<slug>/repl`, stable addressing pulled in. byOffset
  is rendered by the preamble assembler as `Object.assign(__resultRows, {
  byOffset })` so the tuple keeps per-index literal types while the helper
  rides the same value; the settled event's offset doubles as the UI label.
- Bugbot round (all four real, all fixed): (1) cross-project state leak —
  ItxScopeReplConnected + ItxActivityTail now key by projectId:scopePath;
  (2) same-code rerun swallowed the pending row — the run mutation carries a
  submit-time stream-offset anchor; (3) byOffset union types — now generic
  over the tuple's literal offsets (Extract per offset), proven through the
  real tswasm gate; (4) activity tail pointed at /repl with script-run
  friendly renderers. Bonus find while re-verifying with the dev typechecker
  sidecar down: the injected vars line was TS syntax, a SyntaxError on the
  no-emit fallback path — now `const vars = JSON.parse("{}")` (JS-safe,
  any-typed so vars-reading snippets stay clean through the gate).
- REPL-echo round (Misha, live-testing the preview): bare expressions
  returned null because the wrapper only surfaced explicit `return`. Fixed in
  the wrap decision (itx-scope-repl-entries.ts): the whole input parsing as
  one expression auto-returns parenthesized (`{ a: 1 }` stays an object
  literal); otherwise a Node-REPL-style trailing-line-run rewrite
  (`const x = 5;\nx * 2` answers 10); otherwise run-as-written. `new
  Function` is the parser — synchronous, dependency-free, the deleted
  browser evaluator's own trick; TS-only syntax falls back conservatively.
  Display unwraps the echo rewrite so history shows what was typed. Also
  value-less successes now render "undefined (nothing returned)" instead of
  a dishonest null (the settlement carries no `result` key for undefined;
  null is preserved as null). Live-verified: `1 + 1` → 2, bare `results[0]`
  echoes the retained row, trailing expression after statements works,
  value-less run renders the undefined note.
- Session-streams revision (Misha, third scope shape): /repl/<timestamp-slug>
  session streams with the web-agent slug convention; URL = stream path;
  bare /repl resumes newest (itx.streams.list() filtered on the /repl/
  prefix — streams register in project state via stream/created); New REPL
  button mints; sidebar /repl moved into the path-style nav group (fuzzy
  match keeps it active on session URLs; mobile drawer deliberately
  untouched). Live-verified end to end: mint → URL replace → reload resume →
  bare-/repl resume → two tabs sharing one console live → New REPL fresh
  stream → sidebar navigation.
- Laziness revision (Misha): nothing exists until the first Run. Key fact:
  ANY wake of a Stream Durable Object births it (stream/created on first
  boot), so pre-birth the page makes NO session-stream calls — existence
  comes from itx.streams.list() (a project-root read, non-suspending with a
  30s staleTime), and the stream connection, preamble query, and activity
  tail are all gated on `born` (exists || this component submitted a Run ||
  events already buffered). The Run mutation is the ONE creating code path:
  mint path (bare visits mint at Run time, so the timestamp reflects when
  work started) → idempotent create (identical default batch — a racing
  second tab dedupes and both proceed) → prime the known-streams cache →
  router-replace the URL (bare case) → runScript. Pre-birth editor typing
  falls back to itx-only types (preamble query disabled until born).
  - Delineated deviation from the suggested New-REPL shape: New REPL
    navigates to a fresh /repl/<ts> URL (still unborn — a URL costs
    nothing) rather than bare-/repl-plus-ephemeral-intent. Same laziness
    guarantee, no intent state, and it makes the not-yet-born shared-link
    case (open a session URL before anyone ran) first-class; reloading an
    unborn URL keeps you on that empty console instead of resume-latest —
    arguably truer to "where you left it" than the suggested fallback.
  - Platform note: the first child birth also registers the PARENT /repl
    stream (stream/child-stream-created) — that is platform bookkeeping
    after the first Run, not an early wake; the lazy spec's prefix filter
    accounts for it.
  - specs/repl-lazy.spec.ts proves it end to end: visit + New REPL create
    nothing (settle window + streams.list []), first Run births exactly one
    stream at the URL's path.
