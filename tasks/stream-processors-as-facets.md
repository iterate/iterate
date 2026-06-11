---
state: todo
priority: medium
size: large
tags: [os, streams, processors, itx, facets]
---

# Stream processors as Durable Object facets

Owner direction from the itx address-unification review (2026-06-11):
the in-class processor hosting pattern —

```ts
class AgentDurableObject extends DurableObject {
  agentProcessor = new AgentProcessor({
    readState: () => this.ctx.storage.get("agent:checkpoint"),   // shared storage,
    writeState: (s) => this.ctx.storage.put("agent:checkpoint", s), // key prefixes,
    ...                                                           // per-host wiring
  });
}
```

— shares the host DO's storage between host and processors (key-prefix
discipline, checkpoint plumbing repeated per host, "the weird processor
host thing"). Replace it with facets: each processor (or a per-host
processor-composition subclass) runs as a facet of the host DO, with its
OWN private SQLite.

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
  (packages/streams/src/workers/durable-objects/stream-processor-runner.ts).

## Open questions (verify against the facets beta before building)

1. **Can a facet own a stream subscription and alarms?** If yes, the
   facet feeds itself (subscribe → ingest) and the host knows nothing.
   If facets cannot hold subscriptions/alarms, the HOST keeps the one
   stream subscription and fans batches into facet `ingest()` — still
   removes all storage sharing, keeps one feeding seam.
2. Per-facet checkpoints diverge by design (each has its own offset) —
   confirm the delivery path tolerates facets at different offsets
   (replay-per-facet on wake).
3. Migration: none needed (no-backcompat posture; checkpoints are
   disposable folds — facets rebuild by replay).
4. Facet lifecycle on host deletion (should be automatic — verify).

## Relation to in-flight work

The itx finishing wave makes the context host (`ItxDurableObject`) the
runner for stateful source capabilities; this task generalizes the same
move to ALL processor hosting. Sequencing: after the itx unification PR
lands and the facets API has been exercised by it.
