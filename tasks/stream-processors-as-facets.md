---
state: todo
priority: high
size: large
tags: [os, streams, processors, itx, facets]
---

# Stream processors as Durable Object facets

Owner direction from the itx address-unification review (2026-06-11):
the in-class processor hosting pattern —

```ts
class AgentDurableObject extends DurableObject {
  // every processor's progress lands in the HOST's own kv under
  // `stream-processor:<slug>:progress` (durable-object-processor-durability.ts)
  #registry = createStreamProcessorRegistry(this.ctx, { ... });
}
```

— shares the host DO's storage between host and processors (key-prefix
discipline; the DO classes are 80–150-line shells around the registry).
Replace it with facets: each processor (or a per-host
processor-composition subclass) runs as a facet, with its OWN private
SQLite.

## Decision (2026-08-03): endeavour to use facets

Owner call after full platform verification (workerd source `dbc16042d`
plus a deployed probe worker — evidence below). Direction sharpened: the
processor host should be ONE class that runs in either placement —

- its own Durable Object (today's topology), or
- **a facet of the Stream DO itself** —
  `ctx.facets.get(name, () => ({ class: ctx.exports.<HostClass> }))` —

chosen per processor, not per architecture. Placement policy:

| Processor kind | Placement | Why |
| --- | --- | --- |
| Light projections (device, secret, collection, notification) | facet of their stream | small state, no long-running effects; crash isolation suffices |
| Heavy/effectful (agent, capability host) | own DO | `ctx.exports` facets share the parent's isolate (OOM couples) and a live facet keeps the parent resident — transcript-sized state and multi-minute keepalive work stay off the stream |
| Userspace/repo code | worker-loader facet (own isolate), nested under a runner facet | real memory isolation; buildable/killable/deletable without touching the Stream DO (nesting depth allows stream → runner facet → dynamic facet) |

Delivery to a colocated facet becomes a direct parent→facet call —
replacing the retained-callback wake leg for that placement only; the
transport remains for own-DO, userspace-remote, and browser hosts.
`durableObjectProgressStore` runs verbatim on a facet's private
`ctx.storage`; the only adapter that differs between placements is the
keepalive alarm (facet mode uses the parent-owned alarm proxy already
shipped for stateful workers).

## Platform verification (2026-08-03)

workerd source (`dbc16042d`) + deployed probe (dev/preview account,
worker deleted after; ramp tests with control loops):

- **API surface (deployed):** `ctx.facets` = `get / abort / delete /
  clone`. `delete(name)` aborts + permanently deletes the facet's SQLite
  DB, recursively including descendants; parent unaffected; next `get()`
  starts empty. `abort(name, reason)` kills only the incarnation —
  storage survives, existing stubs throw `reason` verbatim. A running
  facet is reused WITHOUT invoking the startup callback, so class/id
  swaps require `abort()` first (the version dance
  `stateful-worker-durable-object.ts` already does).
- **Wiring constraint:** the startup callback must return
  `ctx.exports.<Class>` (loopback namespace) or a WorkerLoader
  `DurableObjectClass` — a raw JS class throws a TypeError.
- **Subrequests:** facet calls are metered in the in-house "API
  requests" pool, identically to DO-stub RPC (probe: hard stop at
  exactly 10,000 default; `limits.subrequests` governs the pool — a
  20,000 override was honored). The OS worker's
  `limits.subrequests: 10_000_000` (#2378) therefore covers facet
  delivery. Each facet gets its own IoContext and thus its own outbound
  budget; the parent pays one in-house subrequest per hop.
- **Perf:** 10,000 facet pings completed in 0–8 ms observed wall time
  (in-process loopback) vs ~8 s for 10,000 same-script DO-stub pings
  (~0.8 ms/hop).
- **Crash isolation: downward only.** A broken/aborted facet detaches
  from the parent's facet map — no upward propagation; the next `get()`
  restarts it fresh. Parent abort/eviction kills the whole subtree. A
  thrown exception in a facet method is an ordinary rejected promise.
  BUT no memory isolation for `ctx.exports` classes: same V8 isolate and
  heap as the parent (facets also guarantee co-residence on the parent's
  machine). Separate isolates require a different service binding or a
  worker-loader class.
- **Old Q1 answered:** facets CAN own stream subscriptions (proven
  PR #2073) but CANNOT have alarms — structural in workerd
  (`server.c++:1211-1214` `TODO(someday)`; the runtime error is the
  generic "alarms are not yet implemented for SQLite-backed Durable
  Objects", maximally confusing). `getAlarm()` reads fine; a persisted
  facet alarm would never fire. The parent-owned alarm proxy
  (tasks/facet-alarms-for-userspace-processors.md, done) is the pattern.
- **Nesting:** max tree depth 4 including the root DO; a facet's
  `ctx.facets` is full-featured (grandchild proven on the deployed
  probe, including from cross-isolate dynamic facets).
- **Old Q4 answered:** parent `deleteAll()` recursively wipes descendant
  facet storage (transactional in production per a workerd source
  comment) — lifecycle on host deletion is automatic.
- **Facet stubs are not serializable** — a facet can never hand a
  callback to a remote DO; colocated delivery must be parent→facet
  direct.
- **Caveats:** open beta, Workers Paid plan only, no GA date;
  workerd#6800 (open, unanswered): SQLite facets prevent parent
  hibernation, so facet activity bills duration through the parent
  (moot for already-pinned Stream DOs, real for quiet hosts); 65,536
  facet-name lifetime cap per DO.

## Target shape

```ts
// generic base lives with the streams package; per-host composition is a
// SUBCLASS (constructor args live where the storage lives — the host can
// never pass arguments to a facet, and shouldn't need to):
export class AgentProcessors extends ProcessorFacet {
  processors = [new AgentProcessor({ ...derived from this.ctx/this.env }), ...];
}

class AgentDurableObject extends DurableObject {
  processors() {
    return this.ctx.facets.get("processors", () => ({ class: this.ctx.exports.AgentProcessors }));
  }
}
```

- Facet classes are EXPORTED ENTRYPOINTS (the class-level address) —
  same rule as everything else post-unification.
- Identity derives from names (host's structured name + facet name);
  anything names can't carry arrives per the creation-is-an-event
  doctrine (docs/domain-objects-and-stream-processors.md) — no
  initialize RPC, no idempotency keys.
- Checkpoints + projection tables live in the facet's private storage:
  zero collisions with the host, per-processor GC (delete the facet,
  the projection dies), and `readState`/`writeState` wiring is written
  once inside ProcessorFacet instead of per host.
- Processors become addressable through the uniform door scheme
  (`{ binding, name, path: ["processors", …] }`) since StreamProcessor
  already extends RpcTarget.
- This is the same supervisor pattern as ItxDurableObject hosting
  stateful source capabilities — one doctrine, two instances. It should
  converge with / replace `StreamProcessorRunner`
  (packages/iterate/src/processors/stream-processor-runner.ts).

## Still open (Q1/Q4 answered above; migration still none needed)

1. Per-facet checkpoints diverge by design (each has its own offset) —
   the stream's `subscription_cursors` rows already track per-subscriber
   positions, so divergence is the normal case, but confirm
   replay-per-facet on wake.
2. The Phase-2 gate from docs/stream-processor-runner-redesign.md
   applies to any stream-side hosting: benchmark that facet delivery
   leaves the Stream DO's synchronous append turn untouched.
3. workerd#6800 pinning cost if facets ever land on quiet (non-stream)
   parent DOs.

## Relation to in-flight work

The itx finishing wave makes the context host (`ItxDurableObject`) the
runner for stateful source capabilities; this task generalizes the same
move to ALL processor hosting. Sequencing: after the itx unification PR
lands and the facets API has been exercised by it.

**Companion design (2026-08-03):**
[Stream subscription model redesign](../docs/stream-subscription-model-redesign.md)
— the other half of the same rebuild. This task decides *where processors
run*; that doc decides *how anything attaches to a stream and how it is
identified* (subscription names as the one identity — name = facet name =
progress key — the delivered/confirmed cursor split, the `parked` state,
and readers as a first-class pull surface). Its naming and cursor changes
can land before facet placement; the facet placement of the wake arm
lands here.
