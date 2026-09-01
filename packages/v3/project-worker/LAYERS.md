# The five layers — what's built on what

Plain-language map of this package, bottom-up. Each layer only uses the ones below it. Written
to answer: "capability vs subscription vs processor vs connection — which is an example of
which?" Answer, up front: **everything above layer 2 is a capability mount; the differences are
just which policy rides the mount event and which lane serves it.**

## Layer 1 — restorable references (things you can call after a restart)

Every callable thing is a live object plus a small piece of durable data that gets the object
back later.

| Kind                       | The durable data                      | Who restores it                                                                          | Where                                                                     |
| -------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Durable Object by name     | its codec name (`prj_x.iterate/path`) | Cloudflare (`getByName`)                                                                 | `core/durable-object-names.ts` (`DurableObjectNameCodec`)                 |
| Worker entrypoint by props | the props object                      | Cloudflare (`ctx.exports`, persistent stubs)                                             | `itx-entrypoint.ts`                                                       |
| Loaded isolate / facet     | cacheKey + source modules             | Cloudflare (Worker Loader, `ctx.facets`)                                                 | `core/worker-loader.ts` (`confinedWorker`, `versionedFacet`, `asModules`) |
| **Hibernatable RPC stub**  | a stub pager WebSocket attachment     | **us** — `{type:"page"}` pages the edge worker, which re-mints the stub over Workers RPC | `core/hibernatable-rpc-stub.ts` (`HibernatableRpcStubManager`)            |

The first three are Cloudflare features. The fourth is ours — a poor-man's sturdy ref whose
restore hook must route through whichever stateless worker holds the client's capnweb socket.
The stub stays warm while traffic flows; the DO's quiesce disposes it (a page gets it back).

## Layer 2 — the stream (one `Stream` class, held by the one context DO)

`core/stream.ts` (`Stream`, a dependency-injected JS class) is the commit point: an append-only
event log with monotonic offsets shared by durable AND ephemeral events (ephemerals consume
offsets, never rows), idempotency at the door, the stream/woken wake record, `waitForEvent`,
`read` with the scanned-offset-range proof, and the alarm armer. `stream-durable-object.ts`
(`IterateContextDurableObject`, one DO per `{projectId, path}` context) holds a Stream and
drives it — its injected callbacks run the inline reduces in-transaction (pause/breaker
enforcement lives there) and the post-commit fan-out. Identity is always log-derived: a mount's
id IS the offset of its capability-provided fact.

## Layer 3 — the capability table (one reduce, resolved at zero distance)

`capability-table-processor.ts`, hosted INLINE at the commit point: capability-provided/-revoked
events (string-at-rest expression halves) reduce into the mount stack. One dispatch path:
parse → longest-path-prefix match (final segment may consume boundary args, ties → newest) →
substitute → evaluate → replay the remainder. A built-in root (`built-ins.ts`) resolves DIRECTLY
(built-ins first); userspace mounts see only `itx` — a bare root is unspellable, so the built-ins
are unshadowable. EVERY attachment is a mount here: plain capabilities, subscriptions (delivery
policy + the stamped lane on the event), processors (processor policy: source/className), live
capabilities (an ORDINARY mount whose target is `itx.rpcStubs.get('<path>')` — the stub itself is
parked in the `itx.rpcStubs` built-in under that path; the row is pure data, the log records the
mount and never the socket). One reduce for all of them: a shadow stack — newest same-path row
wins, revoke-by-offset pops one — and the provide door is IDEMPOTENT (same winner target +
policy ⇒ nothing appended), so a reconnect's re-provide adds no row.

## Layer 4 — processors (cursor + two switches + declared dependencies)

`core/processor.ts`: contract + `reduce` (pure switch) + `processEvent` (effect switch) +
declared deps; the runner (serial chain, cursor, gap repair from the scanned-offset-range
proof) lives in the same class. Two seats, chosen by shape: reduce-only → INLINE at the commit
point (the capability table, the core processor — zero runner apparatus); has effects → a
workerd FACET (`processor-facet.ts`), built-in by slug or userspace via the Worker Loader +
injected SDK. Stateful loaded classes are facets here too (the dedicated runner DO died).
`subscription-forwarder-processor.ts` is the model citizen: contract, two switches, one
`readonly #pump` dependency.

## Layer 5 — rpc stubs and delivery (the edges of the system)

`core/itx-surface.ts`: capnweb terminates at `/api`, never in a DO. A client offers a live
capability through the ONE provide door — `itx.provide(path, stub)` — sugar over two axioms: the
callback is PARKED in the `itx.rpcStubs` built-in under `path` (retained relay-side, paged into
the DO on demand — the poor-man's sturdy ref, `hibernatable-rpc-stub.ts`), then the ordinary
mount `path ⇒ itx.rpcStubs.get('<path>')` is appended. Calling it is just
`itx.<path>.method(...)` (or, registry-direct, `itx.rpcStubs.get('<path>').method(...)`).
PRESENCE is PHYSICAL — `itx.rpcStubs.list()`, the keys with an open transport right now — never
the table; the whole socket census is `transportState()`, a DO-only verb.

A subscriber mount's delivery LANE is a DECLARED fact — `laneOf` stamps it ONCE on the
capability-provided event at the provide door (`SubscriptionLane`), never re-sniffed from the
target's shape at delivery time. Three lanes:

- **facet** (`itx.facets.get('slug')`): a co-located facet the commit PUMP drives — a processor.
- **connected** (target `itx.rpcStubs.get('…')` — a LIVE callback parked at the subscription's own path): fire-and-forget batches + the GLOBAL
  ScannedOffsetRange over the paged-in stub, straight from the commit path — no acks, no server
  cursor, no coalescing; the client holds its own offset and heals by pull. Live-state deltas ride
  the same lane, revision-chained, door-healed. Measured: p50 ~215ms end-to-end, ~50× batching
  (prove_ephemeralflood).
- **durable** (any other expression): the subscription-forwarder facet holds a
  SubscriptionDeliveryProgress cursor per mount and applies the ONE failure policy — bounded
  retries → HALT + audit fact; recovery is a durable subscription-resumed event.

A live stub that dies leaves only its absence: it drops out of `itx.rpcStubs.list()`, while its
mount STAYS — calls answer CONNECTION_OFFLINE — until someone revokes it or the provider re-parks
the same path (reconnect). Nothing auto-revokes; the table never claimed liveness. Everything a
client ever does — Slack-bridge RpcTargets included (prove_slack) — is these five layers composed.
