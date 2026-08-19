# Defect ledger — the bug hunt's 41 verified failures, with proposed fixes

Source of truth for the fix campaign (goal step 1). Every entry is a verified `test.fails` in
the three lanes (commit cfe9d32f2). Severity: ☠ = data/authority loss, ⚠ = wrong behavior,
◇ = missing parity feature. Fix costs are NET lines (negative = code shrinks).

## Family A — print↔parse asymmetry (silent authority loss) ☠

Tests: src/core/expression.failing.test.ts, src/capability-table-processor.failing.test.ts

1. Exponent numbers don't round-trip (`1e+21`): `#number` regex lacks exponent branch.
   FIX: add `(?:[eE][+-]?\d+)?` to the number regex (~1 line).
2. `-0` prints as `"0"`. FIX: `Object.is(n, -0) ? "-0" : ...` in printValue (~1 line).
3. Non-identifier object keys print unquoted → unparseable. FIX: quote keys failing the
   identifier regex in printValue + accept string keys in #object (~4 lines).
4. `__proto__` object key pollutes prototypes. FIX: build with `Object.create(null)` or apply
   the existing reserved-name check in #object (~2 lines). ☠ security.
5. THE AMPLIFIER: provide() returns providedAtOffset "success" while reduce drops the mount as
   malformed. FIX: provide() must parse(print(target)) round-trip BEFORE appending (throw
   VALIDATION-style codedError on mismatch) (~4 lines). This alone converts the family from
   silent authority loss to loud input error even if 1-3 linger.

## Family B — commit-point mismatches ☠

Tests: **tests**/failing-event-log.test.ts 6. In-batch dedupe hit reduced TWICE (hit's offset > scannedAfterOffset). FIX: track
freshly-inserted offsets in the transaction; #reduceInlineAtCommit skips committed entries
whose offset is a dedupe hit (pass `fresh: Set<number>` or filter `committed` to
newly-inserted before reducing) (~3 lines). ☠ breaks bit-identical rebuild + double drives. 7. Breaker taxes idempotent retries (counts before dedupe). FIX: move breaker check INSIDE the
transaction after dedupe resolution, count only genuinely-inserted durables; keep the
pre-check as a fast reject for oversize fresh batches only (~6 lines). 8. Payload-less pause/breaker events silently no-op (destructure of undefined throws in
reduce, caught+skipped). FIX: `event.payload ?? {}` in CoreStreamProcessor.reduce (2×1 line). 9. read(afterOffset beyond head) fabricates scannedThroughOffset. FIX:
`scannedThroughOffset: Math.max(Math.min(afterOffset, head), ...)` — clamp to head; beyond-
head reads answer scannedThroughOffset = afterOffset only if ≤ head else head (~2 lines).
(Also heals forwarder defect 17's root.)

## Family C — delivery lanes ⚠

Tests: **tests**/failing-delivery.test.ts 10. `consumes: ["*"]` black hole, connected lane. FIX: mirror the processor rule in the filter:
`row.consumes.includes("*") ? !e.ephemeral || row.consumes.includes(e.type) : ...` — reuse
the exact #consumes logic (extract tiny `consumesEvent(consumes, event)` into
core/events.ts, use in BOTH lanes + processor) (~8 lines, deletes 2 divergent copies). 11. Same black hole, forwarder pump. FIX: same shared helper (covered by 10). 12. Ghost HALT on unsubscribe-during-flight (deleted progress CAS-coerces to rev 0). FIX:
in the pump's success/failure CAS, treat `fresh === undefined` as "row revoked — abandon,
write nothing" (~3 lines). Kills the spurious audit fact + orphaned record. 13. resume afterOffset beyond head wedges silently. FIX: resumeSubscription (DO) clamps
afterOffset to current head and/or the pump detects cursor > head and clamps once (~3
lines; defect 9's read fix makes the wedge self-heal too).

## Family D — connections/sessions ⚠ (one ☠)

Tests: **tests**/failing-connections.test.ts 14. ☠ Dirty deaths filed as CLEAN ends (relay closes 1000 both paths → storm clause
unreachable). FIX: relay closes with 1011 (or 4000-range app code) in onRpcBroken, keeps
1000 only for deliberate dispose; directory already keys on code===1000 (~2 lines). 15. Concurrent same-key connects never collapse (replace scan races pager-open round trip).
FIX: at attach(), also check #pendingConnectionRecords for the same connectionKey and drop/
supersede the pending one (record connectionKey→pending connectionId map) (~6 lines). 16. In-flight invoke on killed provider leaks uncoded transport error. FIX: wrap
`retained.invoker.invoke` result in the manager's invoke(): catch, if socket now gone →
rethrow codedError("CONNECTION_OFFLINE", original message) (~5 lines).

## Family E — processor base class ☠

Tests: src/core/processor.failing.test.ts 17. ☠ waitUntilProcessed-first disables the version refold → whole log replays WITH side
effects. FIX: #loadProgress must NOT cache the version-mismatch fallback: when stored
version ≠ contract version, return the fallback WITHOUT setting this.#progress (let
#rereduceIfVersionChanged run first) (~3 lines). 18. Version refold swallows an in-flight push (refolds to head; queued push judged stale).
FIX: refold only to the PERSISTED cursor's offset, not the live head — the queued push then
processes normally with effects (~2 lines: read stored reducedThroughOffset as the refold
ceiling). 19. Nested blockProcessorWhile escapes the hold. FIX: loop `await blockers` until the chain
stops growing (compare identity before/after await) (~4 lines). 20. At-head stall on exact 500-multiples. FIX: in #catchUpBody, when a full page's
scannedThroughOffset === head, pass atHead=true (compare to stream head — one extra read
already available via page.scannedThroughOffset vs a follow-up empty page: simplest — do
the follow-up read and let IT deliver at-head with zero events instead of returning early)
(~3 lines). 21. Named ephemerals dropped on non-contiguous push. FIX: on gap, FIRST repair from log to
window.scannedAfterOffset, THEN process the pushed batch (which carries the ephemerals)
instead of discarding it (~5 lines). 22. Idempotent retry of 64-deep payload throws (dedupe deep-walks, commit doesn't). FIX:
jsonEqual gets a depth budget matching or exceeding parse's, or sameIdempotentEvent
compares canonical JSON strings (JSON.stringify equality — cheaper AND depth-free) (~2
lines, deletes the recursive walk risk).

## Family F — capnweb disposal ⚠

Tests: **tests**/failing-capnweb-wire.test.ts 23. CapabilityProvision lacks Symbol.dispose → `using` leaks mount+connection+relay. FIX: add
`[Symbol.dispose]() { void this.revoke().catch(...) }` (same defensive-symbol trick as
ProjectSession) (~4 lines).

## Family G — missing parity features ◇ (not bugs; owner-commissioned)

24. Natural dotted client surface (9 tests, apps/os path-proxy parity): server-side fallback on
    Itx (+ returned stubs): unknown property → pathProxy accumulating segments, terminal call →
    invokeCapability; unify the three miss vocabularies into one path-miss grammar
    (isPathMissMessage-style, adapted not copied). Est +40 lines, reuses core/expression
    pathProxy. NOT a no-brainer (design: which names are reserved on Itx).
25. Row chunking for arbitrary-size payloads (6 tests, apps/os EVENT_CHUNK_SIZE contract):
    event_chunks table, 512KiB JS-side split, offset-per-event, reassembly validation,
    idempotency over reassembled bodies. Est +60/-10 lines in StreamEventLog. NOT a no-brainer
    but well-specified by the extracted contract.

## Family H — WebSocket fetch through a live capability (verdict: hop-by-hop, 2026-08-19)

Tests: \_\_tests\_\_/failing-ws-fetch-capability.test.ts (2 pass / 2 fails / 1 todo)

26. PINNED WORKING: live-capability HTTP fetch end to end — eyeball → /cap → DO fetch lane →
    connections alias → invoker → relay → capnweb → Node provider's fetch() and back (201 +
    body + headers intact). Also pinned: an UPGRADE Request reaches the provider with its
    Upgrade header intact, and provider throws ride back as the fetch lane's 500.
27. ⚠ The 101 ANSWER is impossible from a Node provider: no WebSocketPair; undici Response
    rejects status 101. NOT our bug — but the platform half (would OUR lane forward a genuine
    101 from a live capability?) is untestable until defect 28 is fixed or capnweb serializes
    WebSocket-in-Response. FIX options: (a) document Node providers as HTTP-fetch-only and
    route WS-serving capabilities through loaded workers (works in prod — prove_crisp1); (b) a
    relay-side upgrade adapter: the RELAY (workerd!) mints the WebSocketPair and bridges frames
    to the provider over capnweb callbacks (+~40 lines, real design work — NOT a no-brainer).
28. ⚠ HARNESS-LANE BUG: the loaded-worker lane is dead under createTestHarness — workerd
    rejects the experimental allow_irrevocable_stub_storage flag on DYNAMIC loader children
    without --experimental, and TestHarnessOptions has no passthrough. Production fine
    (prove_crisp1 passes live). FIX candidates: wrangler issue/patch for a flag knob; or the
    pool lane carries all loader coverage (it accepts the flag) — zero code, document it.

## Family I — processor lifecycle (wave 2: **tests**/failing-lifecycle-races.test.ts)

29. ⚠ Enable-vs-configure drive race: enableProcessor's own provide commit drives the fresh
    facet BEFORE configure() runs — every enable logs "not configured" and drops that batch
    (named ephemerals in the configure window are lost; durable heal only). FIX: subsumed by
    30(a).
30. ☠ THE HALF-ENABLED PROVIDE DOOR: #facetEntries derives enablement from any
    itx.processors.<slug> mount (any provide can mint one — the validated relay passes the
    undeclared `processor` field through), but the facet only works after the second,
    NON-event-sourced leg (configure → facet kv). Provide-only = permanent per-commit error
    storm that /state reports as healthy; rebuild-from-log replays mounts but not identity kv.
    FIX (recommended, net ~0 lines): kill the side-channel — derive FacetIdentity entirely from
    the mount + the parent's own address and configure IDEMPOTENTLY inside #facet() at every
    materialization; delete enableProcessor's configure call; #facet(slug) throws NO_FACET for
    unknown slugs (also stops silent resurrection of deleted facets). Fixes 29 + 30 + 32.
31. ⚠ Unsubscribe leaks the parked anonymous transport (pager socket + retained stub +
    registry record) until the whole session dies — verified 20/20 cycles. FIX: on revoke, if
    the mount's target is itx.connections.get(id), the connection is anonymous, and no other
    mount names it → close it (the exact mirror of onFinalClose auto-revoke, ~8 lines).
32. ⚠ Warm facet keeps STALE props: configure() writes new identity kv but never drops the
    memoized #processor — new props take effect only after a quiesce abort. FIX: configure()
    invalidates #processor on identity change (~2 lines; 30(a) covers materialization time).
33. ◇ Client Itx.enableProcessor cannot spell props (DO verb takes them; the client door
    doesn't) — per-instance configuration unspellable except via broken door 30. FIX: add +
    plumb the parameter (~2 lines).
    Also pinned passing: 10-way provide/revoke races, double-enable lineage, disable-mid-drive,
    append-during-delivery reentrancy (bounded + loud), waiter hygiene. Infra note: the validated
    relay does NOT strip undeclared fields — a deliberate strict-vs-passthrough decision is owed.

## Infra findings (not defects in our code)

- Harness lane can't boot the Worker Loader (workerd --experimental knob missing in
  TestHarnessOptions); pool lane CAN. Loader regression coverage → pool lane.
- vite8 oxc won't lower standard decorators; pool lane carries an esbuild lowering plugin;
  unit lane shares the hazard silently (no decorated imports today).
- WS-fetch-through-live-capability verdict pending (agent running).

## No-brainer set (goal step 5): high consequence, net-zero-or-negative complexity

Defects 1,2,3,4,5,6,8,9,10+11,12,13,14,16,17,18,22,23 — every one ≤8 lines, several negative.
Defer (design decisions): 7 (breaker placement), 15 (pending-attach bookkeeping), 19-21
(runner semantics — fix with care + soak), 24, 25.
