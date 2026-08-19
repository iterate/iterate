# The core processor — folding the iterate context inline, the apps/os way

2026-08-19. The owner's question: "would it make sense to move parts of iterate-context into
the stream parent?" — with the constraints that built-in FACET processors remain a thing
(apps/os has them), and that whatever runs inline must still be WRITTEN like a normal
processor. This memo is the thought-through answer. Verdict: yes, and apps/os already proved
the exact shape.

## The apps/os precedent (read 2026-08-19)

`apps/os/src/domains/streams/core-processor-contract.ts` + `stream-durable-object.ts`:

- The stream DO's `append` is "the synchronous commit point. Offsets are assigned, the core
  state is reduced, and event rows are persisted in one await-free turn."
- The CORE processor is an ordinary `defineProcessorContract` contract with a synchronous
  `validate → reduce` — run INLINE during append, "instead of through the normal event-batch
  runner".
- Its reduced state owns exactly the parent's derived truth: max offset, stream config,
  **configured subscriptions**, whether appends are paused, and **the token-bucket
  circuit-breaker state**.
- Checkpoint = ONE versioned DO-KV value (`MAX_CORE_PROCESSOR_STATE_BYTES` = 1 MiB police),
  rebuilt from the SQL event log when missing or version-skewed.
- Delivery is "reconciled from the resulting state after commit rather than dispatched from
  one-shot event hooks".
- Every OTHER processor (repo, sandbox, agent, secret, scheduler) runs through the async
  runner/registry — the clean room's facets.

## The insight that makes it elegant

The entire async runner apparatus — serial chain, cursors, scan windows, gap repair, the
resurrection pass — exists to cope with being AWAY from the commit point. A fold that runs AT
the commit point, synchronously, before append returns, needs none of it: there are no gaps to
repair when you never leave the source. **The runner is the price of distance; the core pays
zero because it has zero distance.**

And the authoring surface survives untouched: `IterateContextStreamProcessor`'s `reduce` is
already a PURE fold (no `processEvent`, no effects — the provide/revoke side effects live in
the VERBS, which just append). A pure `contract + reduce` pair can be hosted by a ~30-line
synchronous inline runner exactly as well as by the full async one. Same
`defineProcessorContract`, same `reduce({event, state})` signature — "written like a normal
processor" holds by construction.

## The placement rule (one sentence each)

- **INLINE (parent-hosted core):** processors whose `reduce` is pure and cheap and whose state
  the PARENT itself needs in order to act — the routing table, delivery config, and later the
  breaker/pause state. Folded synchronously at commit; checkpointed as one versioned kv value;
  rebuilt from the log on skew or eviction. No chain, no cursor, no facet, no races.
- **FACET (built-in class in ProcessorFacet):** processors with effects — `processEvent`,
  `blockProcessorWhile`, emissions, retries. They need the full async runner, their own
  storage, and quiesce isolation. This lane STAYS (the owner's requirement; apps/os's repo/
  sandbox/agent analogues).
- **USERSPACE (loader facet):** unchanged.

The rule is CHECKABLE: inline hosting requires a pure-fold processor — defining `processEvent`
disqualifies a contract from the core.

## What moves, what dies, what stays

MOVES INTO THE PARENT (hosted inline, authored unchanged):

- `IterateContextStreamProcessor`'s contract + reduce → the parent's core fold, run per fresh
  durable event inside append's commit turn.
- `resolve`/`route`/`deliverTo`/`resolveFetch`/`#itxAtDepth` — functions over (state, scope);
  the host scope builds parent-side (the parent has the same env and ctx.exports the facet
  inherits today).
- `provide`/`revoke` — parent verbs (append + the must-use/target-root/named-capture gates).

DIES:

- The DOUBLE FOLD: `#foldSubscriptionProjection` becomes a derived view of core state (push
  rows = mounts at `itx.subscribers.*`); the pump-races-the-provide class becomes UNSPELLABLE
  because the table is synchronously exact as of the last committed event.
- A facet RPC + snapshot barrier on EVERY dispatch (the system's hottest path — most of the
  measured ~8 ms in-isolate hop).
- The delivery facet lane entirely: increment 53's parked-callback short-circuit generalizes
  to every target — all deliveries become parent-local substitute+apply.
- The ictx cases of the resurrection pass and the quiesce dance; `#pushedHead` for the core
  (facet built-ins keep it).
- ProcessorFacet's ictx-specific surface (~100 lines: invoke/provide/revoke/
  deliverSubscription/fetch + seeds wiring). The `x-itx-cap` facet-fetch tunnel — the parent
  resolves the fetch lane directly (101s get simpler, not harder).

STAYS:

- ProcessorFacet as the GENERIC built-in facet host (configure/processEventBatch/snapshot/
  waitUntilProcessed + facetInvoke) — ready for the next built-in with effects.
- The pump/ladder/cursors — already parent-side, where the alarms natively live. workerd#6810
  stops being load-bearing for anything.
- `StreamProcessor` (async base class) for facet + userspace processors, unchanged.
- `itx.facets.get('iterate-context')` as an alias to the inline core (addressing uniformity).

LATER, ON THE SAME SEAM (the apps/os trajectory):

- Circuit breakers = more fields on the core contract's state, folded inline, enforced at
  append/dispatch — apps/os's token-bucket-in-the-core-reducer, verbatim.
- Append pause, config generations, inbound fencing — all the same shape: core state fields.
- A `MAX_CORE_STATE_BYTES` police when mounts can grow unboundedly.

## Costs, stated honestly

- The core reduce runs on the append hot path — it must stay O(1)-ish per event (today it is:
  an array push/filter). The placement rule polices this.
- A wedged resolve (pathological match) now wedges the DO instead of an abortable facet; the
  depth-32 guard bounds the known case. This is the one genuine isolation loss, accepted on
  the grounds that the parent already cannot serve any verb without the ictx facet answering.
- The parent file grows (~+250 in) while the package shrinks (~−350 out, two concepts dead);
  "LOG + SOCKETS + DOORS" gains "+ THE CORE FOLD" — which is the truer sentence anyway, and
  the one apps/os already wrote.

## The new one-line story

A stream folds its OWN truth inline at the commit point (the core: routing table, delivery
config, breakers) and hosts every processor that needs distance — effects, isolation, retries
— as a facet. Same contract, same reduce, two runners: a 30-line synchronous one for zero
distance, the full async one for any distance at all.
