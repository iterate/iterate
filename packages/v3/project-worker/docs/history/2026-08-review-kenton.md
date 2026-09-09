> **HISTORY (2026-09-03).** The Kenton-bar review of increment 30. Every path it names under
> `src/core/` has since moved (`src/core/*` → `src/context/*` and `src/stream/*`), so read the
> findings, not the file names. The surface as built is `docs/itx-surface-as-built.md`.

# REVIEW-KENTON — the Kenton-bar review (increment 30, `kenton-1`)

Owner's instruction: "review everything for simplicity, clarity, elegance — it should be as
Kenton Varda would have written it." Bar: boring primitives obviously composed; one honest way
per thing; comments state design pressure + invariants; fail early in the caller's vocabulary;
subtractive final pass. Scope: all of `src/` at `ictx-facet-1`.

Verdict up front: the architecture holds the bar — the op-set really is get+call+hole, the DO
really is log+sockets+doors, the registry really is five rules. What fell short was REPETITION
(three identical proxies, three identical loader wirings, two spellings of the expression
schema), a lying signature (`deliver(events, head)` that ignores both), and a drawer of dead
exports. All fixed below. Nothing needed a new concept.

## FIX-NOW (applied in this commit)

1. **ONE `pathProxy`** (`core/expression.ts`) — the accumulating dotted proxy existed three
   times, verbatim (`#itxAtDepth` in the iterate-context processor, `facetClientsView`, the
   stateful-worker proxy in roots-builder). One builder now; the stateful `fetch` special case
   moved from get-time to apply-time (observably identical: the proxy is function-typed either
   way). The dead "cannot call a call result" branch died with it (segments are strings by
   construction).
2. **ONE `confinedWorker`** (`core/agent-runtime.ts`) — the loader wiring (compat date, `itx.js`
   injection, `env.ITX` + `globalOutbound` = the owning context) existed three times (stateless
   code caps, userspace facet processors, the stateful runner). The confinement invariant — a
   loaded worker's whole world is its host — is now stated once, where the injected module lives.
3. **ONE `ExpressionSchema`** — the structured-half zod schema was spelled twice (`core/config.ts`,
   `iterate-context-stream-processor.ts`). The codec now owns its wire schema.
4. **BUG — the must-use walker disagreed with the codec.** `walkHoles` had its own hole detector
   that descended into `$`-escapes, so a `$`-escaped `{"?": "x"}` in a pattern wrongly counted as
   a binding (provide would throw must-use) and in a target wrongly counted as a use (masking a
   real violation). It now classifies via `holeKind`, exactly as match/substitute do.
   Regression test added.
5. **BUG (latent) — the user-tally demo folded the delivered batch, not its cursor.** Drives are
   fire-and-forget; a dropped drive would have left a permanent gap (later batches advance the
   cursor past the hole). It now folds from its own cursor on every wake — the same
   "the batch is only a wake-up" doctrine every registry-backed processor already follows.
6. **`registry.deliver()` is now nullary** — it ignored both parameters since delivery went
   cursor-driven (increment 25); the signature lied about the batch mattering. The facet
   duck-contract `deliver(events, head)` keeps them (userspace processors really use them);
   `ProcessorFacet.deliver` documents the drop.
7. **`#ictx()` no longer re-implements `enableProcessor`** — the Stream DO's lazy capability-host
   enable duplicated the entry-registration logic; it now calls `enableProcessor(ICTX_SLUG)`
   (one way to enable a facet processor), keeping only the configured-once marker.
8. **`ProcessorFacet.snapshot()` reached into the registry's private storage key** (a second way
   to read a fold). Now `registry.reads(processor).snapshot()` — which also fixes the
   empty-stream answer: schema-initial state (e.g. `{counts: {}}`), not `{}` (which does not even
   satisfy the contract's stateSchema).
9. **resolveCurrent wired by the factory, not by instanceof** — the iterate-context factory
   already holds the `invoke` seam; `#boot`'s `instanceof` special case deleted. `#ictx()`
   returns the processor (not `{processor}`), and typed `reads` kills the `as Parameters<...>`
   cast dance in `invoke`/`fetch`.
10. **Redundant refold deleted** — `processBatch` re-ran `refoldIfNeeded` that its only caller
    (`catchUpBody`) had just run.
11. **Dead code deleted:** `parentPath` (names.ts, unused), `isFetchTerminal` + its test (the
    lane rule lives in `resolveFetch`; the door is header-driven — nothing ever consulted the
    predicate), `registry.names`, the unused public `itx` getter on the processor, the empty
    `processEvent` override, the `tag` field on `CF_VERSION_METADATA`.
12. **Fail-early identity:** a Stream DO or stateful runner reached without a name (id-addressed)
    now throws in the caller's vocabulary instead of silently fabricating a `"?"` project /
    garbage host stub.
13. **Env interfaces tell the truth:** stream DO dropped `STATEFUL_WORKER`/`ITX_KV`/`APP_CONFIG`
    (unused since the facet move); worker.ts needs only `CONTEXT`.
14. **One `disposeStub`** — the defensive `Symbol.dispose` helper existed twice
    (hibernatable-stub.ts, itx-surface.ts); exported once.
15. **Honest param types in itx-surface** — `string | Expression` instead of `string | unknown[]`
    plus inline `import("./expression.ts")` casts.
16. Micro: `new Date(Date.now())` → `new Date()` (×2); the parser's object-key
    `as '"'`/`as string` cast dance removed.

Test count stays 70: −1 (isFetchTerminal spec died with the export), +1 ($-escape must-use
regression).

## DISCUSS (found, deliberately NOT changed)

- **The registry hosts N processors but every facet hosts exactly one.** A one-processor runner
  would delete the Map/waiters bookkeeping — but the registry API mirrors apps/os on purpose
  (processors port both ways) and the multi-processor tests exercise real contract rules.
  Collapse only if the mirror stops paying rent.
- **`waitUntilProcessed` has no production caller.** Kept: it is part of the mirrored apps/os
  reads API; deleting it makes porting harder for one screenful saved.
- **`Itx.whoami()`** duplicates the generic `invokeCapability` door as a convenience — removing
  it changes the public client surface (proof harnesses call it). Owner's call.
- **`ClientsView` reads return `unknown[]`** — honest about the RPC-backed case but weakly typed
  for in-DO callers; a shared row shape would touch the Roots surface.
- **The duck contract requires `configure` even when a processor ignores it** (user-tally
  no-ops). Optional would shrink userspace boilerplate by one line; explicit first-contact is
  the current doctrine. Left as is.
- **Bare `itx(...)` (calling the scope symbol itself)** resolves as `[["itx", ...args]]` —
  boundary args for a bare default route. Preserved verbatim through the pathProxy move; whether
  it should instead be a loud error is a semantics question, not a cleanup.

## TASTE (noted, no action)

- `route()`'s self-referential `ReturnType<...["route"]>` typing is cute but compact; fine.
- The 500-event page size appears as a literal four times in processor.ts — house rule prefers
  inline literals over indirection constants; left.
- `deliver`'s `wasRunning` dance is subtle but carries its own comment; a helper would not make
  it clearer.
- HibernatableStubs error messages could carry the socketId; they are relay-internal and the
  relay logs the id — left.

## RESOLVED (owner annotations, applied in `annotations-1`)

- **Registry-of-N vs one-processor facets** → this is the next design leg. Owner's direction:
  processors run ONLY as facets for now, extending a base class that carries the machinery; keep
  a future door open for a CPU-heavy processor running as its own DO woken the same way (maybe
  by an itx expression). Jam doc: `apps/os/docs/simplification/wayfinder/innermost-core/processors-jam.md`.
- **`waitUntilProcessed`** → investigated apps/os: ~25 production call sites in `rpc-targets.ts`,
  all the read-your-writes barrier (append → waitUntilProcessed → snapshot). Not incidental
  complexity there; KEPT here (it is ~20 lines). Its home in the collapsed design is in the jam doc.
- **`Itx.whoami()`** → DELETED. `invokeCapability({ path: ["whoami"] })` is the one door.
- **`configure`** → explained in the jam doc; the collapse proposal makes it host-internal so
  userspace never writes it.
- **Bare `itx(...)`** → now a LOUD ERROR at all three doors: the parser (`itx(1)` no longer
  parses), `pathProxy` (zero-segment apply throws), and `route` (a hand-crafted
  `[["itx", …]]` Expression throws). One greppable message: "cannot call the scope symbol
  itself — name a capability first". +2 tests.
- **HibernatableStubs error messages** → every throw now carries the socketId.
