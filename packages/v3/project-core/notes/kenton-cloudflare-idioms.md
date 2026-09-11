# Kenton / Cloudflare idioms for the primary core

Research date: 2026-09-04. This is deliberately a small-design note, not an
API proposal. The primary evidence is the checked-out `workerd` at
[`c4e03fa`](https://github.com/cloudflare/workerd/tree/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03),
[`capnweb` at `bc4bc45`](https://github.com/cloudflare/capnweb/tree/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3),
and [`cloudflare-os` at `81f3c57`](https://github.com/cloudflare/cloudflare-os/tree/81f3c5732bb8ea17dc75209eef9e521d571d50b1).
`project-worker/research/kentonv` is useful annotated primary-writing context,
but is not treated as the sole authority here.

## The small core shape

### 1. One context DO owns state; callers receive a narrow capability

An authenticated introduction mints a `ProjectEntrypoint` through
`ctx.exports.ProjectEntrypoint({ props: { project, context } })`. That entrypoint
has only the operations it needs: `fetch(request)`, append/read operations, and
perhaps a typed configuration callback. It resolves the owning Context DO
internally. Loaded code receives that entrypoint as both `env.ITX` and
`globalOutbound`; it never receives a Context namespace or a general DO stub.

This is a capability boundary, not a convenience wrapper. Workerd describes
`ctx.exports` as an in-house loopback service/DO capability, specialized with
`props`; an unspecialized loopback stub is intentionally not serializable
([implementation](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/export-loopback.h#L13-L66),
[persistent-stub test](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/tests/persistent-stubs-test.js#L977-L1001)).
The props are injected construction-time capability data, not mutable ambient
configuration ([runtime schema](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/server/workerd.capnp#L213-L230)).
Cloudflare OS applies this exact pattern: an entrypoint specializes a gatekeeper
with account props, then creates its owned DO from those props
([source](https://github.com/cloudflare/cloudflare-os/blob/81f3c5732bb8ea17dc75209eef9e521d571d50b1/packages/gatekeeper-context/src/library-gatekeeper.ts#L116-L145)).

Keep the public RPC surface typed and boring: `append(batch)`, `read(range)`,
`invokeConfiguredMount(name, input)`, not a user supplied object path and member
chain. If a multi-step operation needs affinity, return a narrow `RpcTarget` or
put the whole typed operation in one call; do not assume sequential calls stay
in one live DO incarnation. Capnweb supports promise pipelining and batched
dependent calls ([README](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/README.md#L415-L455)).

### 2. One fetch door, with explicit egress

`ProjectEntrypoint.fetch()` forwards the original `Request` to the Context DO
without rebuilding it, so streaming and WebSocket upgrade semantics stay intact.
The same entrypoint is the loaded worker's `globalOutbound`. Its only allowed
destinations come from the project configuration / connector grants; there is no
ambient `fetch` door. The current worker-loader already has this useful shape:
it gives the same `itxEntrypoint` to `ITX` and `globalOutbound`, and caches only
by deployment/owner/content identity, never request IDs or offsets
([`worker-loader.ts`](../../project-worker/src/context/worker-loader.ts#L103-L138)).

This aligns with workerd's service configuration: global `fetch` is routed to
`globalOutbound`, while targeted external-server bindings are recommended to
avoid SSRF ([schema](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/server/workerd.capnp#L598-L600),
[network policy](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/server/workerd.capnp#L851-L855)).

### 3. Use the runtime gates and storage transactions; do not invent a mutex

For one bounded append batch:

1. Parse and cheaply reject oversized/malformed input before expensive work.
2. In **one** storage transaction, re-read trust/replay/config state, apply the
   authoritative decision, append accepted events, reduce stable state and the
   processor/outbox checkpoint together.
3. Only after that durable decision, schedule / deliver external work. If it
   must retry, persist an explicit obligation/outbox row first.

Workerd's input gate blocks other actor events while storage I/O is outstanding;
its output gate prevents observers from seeing a write that later fails to
flush ([`io-gate.h`](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/io-gate.h#L12-L21)).
Storage transactions themselves are placed under `blockConcurrencyWhile` so an
unrelated event cannot accidentally join a transaction
([`actor-state.c++`](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/actor-state.c%2B%2B#L654-L727)).
Therefore a userland `Mutex`, a global promise chain, or a lock abstraction in
the primary core would obscure the real atomic boundary. A small bounded map
for coalescing an in-flight pager request is different: it represents real
pending work and should have one timeout/cleanup path.

For processors, invoke configuration once for a bounded `{ after, through }`
range, then atomically advance its cursor only after that invocation has
succeeded. Never let the configuration supply `afterOffset`; it is a durable
result of the Context DO's transaction. Do not hold a transaction across fetch,
RPC, or a WebSocket round trip.

### 4. A pager lends liveness, never durable authority

Capnweb terminates at the edge. The Context DO keeps only a tagged hibernatable
WebSocket with a small serializable attachment such as `{ lendingKey, epoch }`.
When it needs a callback it pages the edge; the edge duplicates its live capnweb
capability, lends a fresh native Workers-RPC wrapper through a **private** DO
method, and the DO disposes that wrapper at the next true quiescence, replacement,
or page failure. A durable mount/grant row may retain the key, revocation epoch,
and audit state, but never the live stub. Reconnection restores liveness only;
it does not mint or extend a grant.

That ownership discipline is concrete in capnweb: serialization duplicates a
stub and the recipient owns the duplicate
([serialization](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/src/serialize.ts#L621-L627),
[ownership comments](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/src/core.ts#L579-L593)).
Dispose each retained leg exactly once. Capnweb also makes connection breakage
observable via `onRpcBroken()` ([README](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/README.md#L387-L400)).

The pager must not claim to make arbitrary client-held RPC refs hibernation-safe:
the durable WebSocket attachment is the recovery rendezvous, and a new edge
relay must be lent after recovery. This is the deliberate userspace limit
captured in [`a-websockets-hibernation.md`](../../project-worker/research/kentonv/a-websockets-hibernation.md#L5-L14).

### 5. Do not add facets until an extension needs its own failure domain

The initial core can run its one configuration processor in the Context DO.
When a second independently durable extension actually exists, create it as a
facet with a stable, namespaced facet name and construction props that identify
only its parent/context/config revision. Give the facet a narrow Fetcher/RPC
capability, not the parent's storage or globals. Parent configuration removal
must `delete()` the facet; a deliberate cancellation should `abort()` it. Do
not advance a facet cursor beyond a parent commit which could still roll back.

This is a real local-subobject lifecycle, not a generic plugin registry:
workerd exposes `get`, `abort`, `delete`, and `clone`
([types](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/types/generated-snapshot/index.d.ts#L814-L829));
it deliberately returns a plain `Fetcher` without an ID/name and bounds facet
tree depth ([implementation](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/actor-state.c%2B%2B#L1027-L1115)).
The archived Kenton explanation is especially clear on failure/abort/delete
semantics ([`a-facets.md`](../../project-worker/research/kentonv/a-facets.md#L10-L28)).

## Risks in the current root model

The following was an **early implementation checkpoint**, not a current
completion report. The root `worker.ts` now exists, idle lending/disposal has
network tests, and processor progress is private persisted state. Configured
`afterOffset` now chooses an initial replay position; it does not overwrite a
running cursor. Project-scoped `cd()` currently permits navigation within the
project, so it is not yet a subtree-confined filesystem handle. The proposed
workspace-relative API rejects escape explicitly. Retain these original risks
as design history, not a request for compatibility machinery:

- [`model.ts`](../src/model.ts#L9-L22) permits `..` to pop past `base`. A
  capability-relative `cd()` must reject escape, or root-address parsing must be
  a separately named operation.
- [`TargetSchema` and `MountSchema`](../src/model.ts#L33-L47) encode generic
  `client` IDs, arbitrary context paths, dotted matches, and nullable target
  objects. They risk turning stored names back into ambient authority. Store
  declarative route/config data, but resolve it inside the owning DO to a
  checked, narrow grant.
- [`methodPath`](../src/model.ts#L59-L64) and the edge
  [`EdgeInvoker`](../src/lending.ts#L231-L263) are generic reflective dispatch.
  The former bans several dangerous names, but a denylist is not an interface.
  Prefer one typed callable operation; if reflection remains temporarily, require
  own properties and keep the allowable method set on the server-owned grant.
- [`ProcessorSchema.afterOffset`](../src/model.ts#L43-L48) makes a checkpoint
  caller-supplied. Make it private reducer state written with the event batch.
- [`lending.ts`](../src/lending.ts#L79-L202) already has the right bounded
  in-flight page map and tagged socket direction. It still needs the durable
  grant/epoch check and a Context-DO lifecycle point that drops a borrowed
  invoker on quiescence, revocation, and reconnect. Do not replace that map
  with an explicit mutex.
- `wrangler.jsonc` names `src/worker.ts`, but no such root worker exists yet.
  Until the owner implements it, neither the one fetch door nor the transaction
  boundary is executable evidence.

## Additional direct evidence

- A DO context exposes `props`, `facets`, storage, hibernatable socket APIs, and
  `blockConcurrencyWhile` together ([workerd types](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/types/generated-snapshot/index.d.ts#L695-L706));
  WebSocket attachments are the intended small serializable recovery datum
  ([types](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/types/generated-snapshot/index.d.ts#L3769-L3775)).
- Capnweb supports persistent WebSocket RPC and bidirectional callbacks, but
  requires lifecycle disposal ([README](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/README.md#L463-L499)).
- A capnweb/workerd integration test forwards callbacks through a DO and proves
  the ordinary live case; it should not be read as hibernation persistence
  ([test](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/__tests__/workerd.test.ts#L245-L351)).
