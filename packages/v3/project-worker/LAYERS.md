# The layers — what's built on what

Plain-language map of this package, bottom-up: the onion. Each layer only uses the ones below it,
and each layer's config is its OWN pure event family; anything physical (a socket, a stub, a facet)
lives in a built-in and is named by expression. Written to answer: "capability vs subscription vs
processor vs live stub — which is an example of which?" Answer, up front: **a mount is a name for a
target; a subscription is a name for a delivery; a processor is a subscription whose target is a
facet's `processEventBatch`; a live stub is the physical thing all three may name.**

## Layer 0 — the axioms (built-ins; physical or platform)

Every callable thing is a live object plus a small piece of durable data that gets the object back.

| Built-in / kind                                                     | The durable data                                                            | Who restores it                                                                          | Where                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| a context (`cd`, the DO)                                            | its codec name (`prj_x.iterate/path`)                                       | Cloudflare (`getByName`)                                                                 | `context/durable-object-names.ts`, `iterate-context-durable-object.ts`                   |
| `env.ITX` (a loaded worker's world)                                 | the props `{ contextName }`                                                 | Cloudflare (`ctx.exports`, persistent stubs)                                             | `itx-entrypoint.ts`                                                                      |
| `load(src).getEntrypoint()` / `.getDurableObjectClass(C).get(name)` | cacheKey + source; a facet's `props { contextName, name }` and startup memo | Cloudflare (Worker Loader, `ctx.facets`)                                                 | `context/worker-loader.ts`, the DO's `#facet`                                            |
| **`rpcStubs`** (a live stub)                                        | a stub pager WebSocket attachment                                           | **us** — `{type:"page"}` pages the edge worker, which re-mints the stub over Workers RPC | `context/hibernatable-rpc-stub.ts`, `rpc-stub-directory.ts`, `context/rpc-stub-relay.ts` |
| the stream (`append`/`read`)                                        | the log (SQLite)                                                            | —                                                                                        | `stream/stream.ts`                                                                       |
| `kv`, `whoami`, `fetch`                                             | KV / the address / FALLBACK                                                 | —                                                                                        | `built-ins.ts`                                                                           |

The first three rows are Cloudflare features. `rpcStubs` is ours — a poor-man's sturdy ref whose
restore hook must route through whichever stateless worker holds the client's capnweb socket. The
stub stays warm while traffic flows; the DO's quiesce disposes it (a page gets it back). PRESENCE is
physical — `itx.rpcStubs.list()`, plus two EPHEMERAL events as it changes (`rpc-stub/attached` /
`rpc-stub/detached`); the log never claims a socket is open.

## Layer 1 — the stream (one `Stream` class, held by the one context DO)

`stream/stream.ts` (`Stream`, a dependency-injected JS class) is the commit point: an append-only
event log with monotonic offsets shared by durable AND ephemeral events (an ephemeral consumes an
offset, never a row — and an ephemeral-only batch costs NO write at all: no transaction, not even
the high-water mark; its offsets are unique within the incarnation, and every persisted checkpoint
in the package advances only on a batch that carried a durable), idempotency at the door, the stream/woken wake record, `waitForEvent`,
`read` with the scanned-offset-range proof, and the alarm armer. `iterate-context-durable-object.ts`
(`IterateContextDurableObject`, one DO per `{projectId, path}` context) holds a Stream and drives
it — its injected callbacks run the inline reduces in-transaction (pause/breaker enforcement lives
there) and the post-commit fan-out. Identity is always log-derived: a mount's id IS the offset of
its capability-provided fact; a subscription's, of its subscription-configured fact.

Three reduce-only processors run INLINE at the commit point (`stream/inline-reduces.ts` — zero runner
apparatus): `core` (pause / breaker / incarnation), `capability-table` (layer 2), `subscriptions`
(layer 3). Runtime state IS reduced state: `itx.facets.get('core' | 'capability-table' |
'subscriptions').snapshot()`.

## Layer 2 — mounts (the capability table)

`capability-table.ts`: `capability-provided { path, target }` / `capability-revoked
{ providedAtOffset }` reduce into the mount stack. That is the WHOLE event — no policies, no flags.
One dispatch path: parse → longest-path-prefix match (final segment may consume boundary args, ties
→ newest) → evaluate the target against `{ itx }` → replay the remainder. A built-in root resolves
DIRECTLY (built-ins first); userspace mounts see only `itx` — a bare root is unspellable, so the
built-ins are unshadowable. A live capability is no exception: `itx.provide(path, fn)` is SUGAR that
parks `fn` in `rpcStubs` under `path` and mounts `path ⇒ itx.rpcStubs.get('<path>')`. The door is
idempotent (a reconnect appends nothing).

## Layer 3 — subscriptions (own reduce, ONE delivery loop)

`subscriptions.ts`: `subscription-configured { name, target, consumes? }` (same name REPLACES),
`subscription-removed`, `subscription-delivery-halted` (appended by the loop), `subscription-
delivery-resumed` (appended by an operator; un-halt, optional seek). Pure data; the layer knows only
the stream and the codec.

`subscription-delivery.ts`: after every commit, for each subscription whose `consumes` matches,
evaluate the target and ASK THE VALUE what it is:

- a `FacetHandle` (`itx.facets.get(…)`, `…getDurableObjectClass(C).get(name)`) or an `RpcStubHandle`
  (`itx.rpcStubs.get(…)`) OWNS ITS PROGRESS — a facet keeps its own checkpoint and gap-repairs, a
  live client owns its offset and heals with `read` — so it gets a PUSH of
  `(events, { after, through })`, serialized per subscription (fire-and-forget to a stub, awaited
  to a facet), zero server state;
- anything else (a Worker-Loader entrypoint's `processEventBatch`, a sibling context, a remote)
  cannot, so THE STREAM KEEPS A CURSOR — in memory, written to kv only at durable boundaries — and
  delivers at-least-once (the awaited call is the ack; one retry ladder; halt fact; retries on the
  DO's own alarm).

Nothing is declared or stamped; an alias classifies correctly because it evaluates to the same
handle. `itx.subscriptions.list()` is the read door (rows ⋈ cursors). Edge sugar: `subscribe`,
`unsubscribe`; an unnamed subscription is session-scoped.

## Layer 4 — processors (sugar over layers 0 and 3)

A processor is two classes. `StreamProcessor` (`stream/processor.ts`) is the PURE one the author
writes — a contract plus `reduce` (pure switch), `processEvent` (effect switch), `projectLiveState`;
no constructor arguments, so `new PresenceProcessor().reduce(...)` is a unit test. Its host is a
`StreamProcessorDurableObject` (`sdk/stream-processor-durable-object.ts`, bundled into
`processor.js`) with one field, `processor = new PresenceProcessor()`; the host builds a `ProcessorEngine`
(serial chain, checkpoint, gap repair from the scanned-range proof, at-head pass, version refold,
live-state publishing) over its facet kv and `env.ITX`. A processor class ends in `Processor`, a Durable Object
class in `DurableObject`. The host is hosted like ANY class:
`itx.load(src).getDurableObjectClass('PresenceDurableObject').get('presence')`, identity in
`ctx.props`. `enableProcessor(name, { source, className })` is
`subscribe({ name, target: that chain + ".processEventBatch" })`; `disableProcessor` is
`unsubscribe` + `itx.facets.delete(name)`. There are no built-in processors — `tally` is a fixture.

## Layer 5 — the edge (sessions and the relay)

`session.ts` + `iterate-context.ts`: capnweb terminates in `worker.ts`'s `/api`, never in a DO
(`session.ts`: `UnauthenticatedSession → authenticate() → Session → projects.get(id)`;
`iterate-context.ts`: `IterateContext`, `cd(path)` for the rest). The edge
is a PROXY for the DO's verbs, plus the two jobs only it can do: FOLD dotted sugar into one
`invokeCapability(expression)` (a terminal `.fetch(request)` rides the fetch channel), and PARK
live stubs in the session's `Parking` (`context/rpc-stub-relay.ts`) — the DON'T-PIN relay the pager
pages. Everything a client ever does — Slack-bridge RpcTargets included — is these layers composed.
