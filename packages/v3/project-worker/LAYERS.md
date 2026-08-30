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

## Layer 2 — the stream (one Durable Object class, the only one)

`stream-durable-object.ts`: an append-only event log with monotonic offsets shared by durable
AND ephemeral events (ephemerals consume offsets, never rows), idempotency at the commit point,
`read` with the scanned-offset-range proof, and pause/breaker enforcement reduced inline. One
DO per `{projectId, path}` context. Identity is always log-derived: a connection's id IS the
offset of its ephemeral connection-opened fact.

## Layer 3 — the capability table (one reduce, resolved at zero distance)

`capability-table-processor.ts`, hosted INLINE at the commit point: capability-provided/-revoked
events (string-at-rest expression halves) reduce into the mount stack. One dispatch path:
parse → longest-path-prefix match (final segment may consume boundary args, ties → newest) →
substitute → evaluate → replay the remainder. Config mounts see the built-ins
(`built-ins.ts`); event mounts see only `itx` (the provenance gate is scope-key absence).
EVERY attachment is a mount here: plain capabilities, subscriptions (delivery policy on the
event), processors (processor policy: source/export/props), live-capability aliases
(`path ⇒ itx.connections.get(id)`).

## Layer 4 — processors (cursor + two switches + declared dependencies)

`core/processor.ts`: contract + `reduce` (pure switch) + `processEvent` (effect switch) +
declared deps; the runner (serial chain, cursor, gap repair from the scanned-offset-range
proof) lives in the same class. Two seats, chosen by shape: reduce-only → INLINE at the commit
point (the capability table, the core processor — zero runner apparatus); has effects → a
workerd FACET (`processor-facet.ts`), built-in by slug or userspace via the Worker Loader +
injected SDK. Stateful loaded classes are facets here too (the dedicated runner DO died).
`subscription-forwarder-processor.ts` is the model citizen: contract, two switches, one
`readonly #pump` dependency.

## Layer 5 — connections and delivery (the edges of the system)

`core/itx-surface.ts`: capnweb terminates at `/api`, never in a DO. `connect()` attaches an
**ItxConnection** to a context (client-chosen connectionKey; the session rule files durable
ItxConnectionSession facts; T = 15 min); the `connections` view addresses them
(get/each/list/close). Delivery is TWO lanes, chosen by the mount target's shape alone:

- **Connected** (`itx.connections.get(…)`): fire-and-forget batches + the GLOBAL
  ScannedOffsetRange over the paged-in stub, straight from the commit path — no acks, no server
  cursor, no coalescing; the client holds its own offset and heals by pull. Live-state deltas
  ride the same lane, revision-chained, door-healed. Measured: p50 35ms end-to-end, 20×
  batching (prove_ephemeralflood).
- **Absent** (any other expression): the subscription-forwarder facet holds a
  SubscriptionDeliveryProgress cursor per mount and applies the ONE failure policy —
  bounded retries → HALT + audit fact; recovery is a durable subscription-resumed event.

Mounts targeting a dead connection auto-revoke on close. Everything a client ever does —
Slack-bridge RpcTargets included (prove_slack) — is these five layers composed.
