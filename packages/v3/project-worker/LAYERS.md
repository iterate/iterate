# The layers — what's built on what

Plain-language map of this package, bottom-up: the onion. Each layer only uses the ones below it,
and each layer's config is its OWN pure event family; anything physical (a socket, a stub, a facet)
lives in a built-in and is named by expression. Written to answer: "rewrite rule vs subscription vs
processor vs lent rpc stub — which is an example of which?" Answer, up front: **a rewrite rule is a
name for a target; a subscription is a name for a delivery; a processor is a subscription whose
target is a facet's `processEventBatch`; a lent rpc stub is the physical thing all three may name.**

Two vocabularies run through everything, and they are kept apart on purpose. **(a) rpc stubs** are
physical: a live capnweb value a session LENDS under an OPAQUE `rpcStubKey`, which the DO BORROWS
and RETURNS at idle; a PAGER (one hibernatable WebSocket per key) is how the DO asks the edge to
lend it back. **(b) itx-expression rewrite rules** are pure data: `{ match, target }` — "a call
starting with `match` runs as the same call with `match` replaced by `target`" — kept in a MAP by
canonical match and written by ONE event.

## Layer 0 — the axioms (built-ins; physical or platform)

Every callable thing is a live object plus a small piece of durable data that gets the object back.

| Built-in / kind                                                     | The durable data                                                                   | Who restores it                                                                                         | Where                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| a context (`cd`, the DO)                                            | its codec name (`prj_x.iterate/path`)                                              | Cloudflare (`getByName`)                                                                                | `context/durable-object-names.ts`, `iterate-context-durable-object.ts` |
| `env.ITX` (a loaded worker's world)                                 | the props `{ iterateContextName }`                                                 | Cloudflare (`ctx.exports`, persistent stubs)                                                            | `itx-entrypoint.ts`                                                    |
| `load(src).getEntrypoint()` / `.getDurableObjectClass(C).get(name)` | cacheKey + source; a facet's `props { iterateContextName, name }` and startup memo | Cloudflare (Worker Loader, `ctx.facets`)                                                                | `context/worker-loader.ts`, the DO's `#invokeFacet`                    |
| **`rpcStubs`** (a lent rpc stub)                                    | a pager WebSocket attachment `{ transportId, rpcStubKey }`                         | **us** — `{type:"page"}` pages the edge worker, which lends a fresh Workers-RPC stub over `lendRpcStub` | `context/rpc-stub-directory.ts`, `context/rpc-stub-relay.ts`           |
| the stream (`append` / `read` / `waitForEvent`)                     | the log (SQLite)                                                                   | —                                                                                                       | `stream/stream.ts`                                                     |
| `kv`, `whoami`, `fetch`                                             | KV / the address / FALLBACK                                                        | —                                                                                                       | `context/built-ins.ts`                                                 |
| `expressionRewriteRules`, `subscriptions` (read views)              | slices of the core reduce (layer 1)                                                | —                                                                                                       | `context/built-ins.ts`, the DO                                         |

The first three rows are Cloudflare features. `rpcStubs` is ours — a poor-man's sturdy ref whose
restore hook must route through whichever stateless worker holds the client's capnweb socket. Its
backing table has TWO layers, in the order the tutorial builds them (`rpc-stub-directory.ts`): the
BORROWED table (`#borrowedRpcStubs` — anyone with a route to the DO can `lendRpcStub` under a key;
the DO keeps it borrowed while traffic flows and `returnBorrowedRpcStubs` at its idle quiesce, so
it hibernates with any number of clients attached), then the PAGERS — the second `if`: a call that
finds its key not borrowed pages the edge, the edge answers with a lend, and layer 1 takes over.
`invokeRpcStub` IS the two `if`s: have we got it? call it · else is there a pager? page it · else
`RPC_STUB_OFFLINE`. PRESENCE is physical — `itx.rpcStubs.list()` (borrowed ∪ pager-backed), plus
two EPHEMERAL events as it changes (`rpc-stub/attached` / `rpc-stub/detached { rpcStubKey }`); the
log never claims a socket is open.

## Layer 1 — the stream (one `Stream` class, held by the one context DO)

`stream/stream.ts` (`Stream`, a dependency-injected JS class) is the commit point: an append-only
event log with monotonic offsets shared by durable AND ephemeral events (an ephemeral consumes an
offset, never a row — and an ephemeral-only batch costs NO write at all: no transaction, not even
the high-water mark; its offsets are unique within the incarnation, and every persisted checkpoint
in the package advances only on a batch that carried a durable), idempotency at the door, the wake record, `waitForEvent`,
`read` with the scanned-offset-range proof, and the alarm armer. `iterate-context-durable-object.ts`
(`IterateContextDurableObject`, one DO per `{projectId, path}` context) holds a Stream and drives
it — its constructor calls `Stream.appendCreatedAndWokenEvents()` before any door opens (the first incarnation appends
`stream/created { projectId, path }` at offset 1, every incarnation `stream/woken { incarnation }`,
so any door materializes a context), its injected callbacks run the core reduce in-transaction and
the post-commit fan-out, and the pause check is one `if` in `Stream.append` reading the reduce's
`paused` slice (control events — created/woken/paused/resumed — are exempt). Identity is
log-derived where there is one: a subscription's id is the offset of its subscription-configured
fact; a rewrite rule has no identity beyond its `match` (one map entry per match).

ONE reduce-only processor runs INLINE at the commit point: `CoreStreamProcessor`
(`stream/core-processor.ts`, slug `core`, contract 4.0.0), owned by the `Stream` itself (`#coreReducedState`) with
zero runner apparatus. It reduces the context's own control events into
`{ projectId, path, createdAt, incarnation, paused, itxExpressionRewriteRules, subscriptions }` —
layer 2's rules and layer 3's rows are slices of that one state, each layer keeping its OWN event
family. Runtime state IS reduced state: `itx.facets.get('core').snapshot().state`. Policy is not
in core: a token-bucket breaker is a facet processor that appends `stream/paused { reason }` (layer 4).

## Layer 2 — itx-expression rewrite rules

`context/itx-expression-rewriting.ts` is ONE concept in one file: the five matching rules (its
header), the ONE command that builds `itx/rewrite-rule-configured { match, target | null }`
(`rewriteRuleConfiguredEvent` — string at rest, both halves canonicalized through the codec), and
the READER (`ItxExpressionResolver`, which rewrites a call through the current rules and runs it).
The core reduce reduces the event into `state.itxExpressionRewriteRules`, a MAP by canonical match:
a configured target REPLACES the entry, `null` DELETES it — no shadow stack, no removal by identity,
no offset on a row. That is the WHOLE event — no policies, no flags.

One dispatch path: parse → a built-in root resolves DIRECTLY (built-ins first) → else the most
SPECIFIC matching rule (longest match, then most pinned args; a match step may pin literal args —
`itx.ai.run('gpt-5')` — which are CONSUMED) rewrites the call, and rewriting repeats until the root
is a built-in (32 rewrites is the budget; a call no rule matches is `NO_ITX_EXPRESSION_MATCH`,
default-deny). A target must be rooted at `itx`, so a bare root is unspellable and the built-ins
are unshadowable. A lent rpc stub is no exception: `itx.provide(rpcStubKey, stub, { rewrite })` lends
`stub` to `rpcStubs` under the opaque key and configures the pure-data rule
`rewrite ⇒ itx.rpcStubs.get('<rpcStubKey>')` — the log records the rule, never the socket. The rule
dies with the stub: the handle's dispose un-sets it from the edge, and when the key's LAST pager
closes the DO un-sets every rule and subscription whose target is that stub (a reconnect replaces
the pager and is not a close).

The edge verb `itx.rewrite(match, target | null)` is literally "build the event, append it", and
hands back a DISPOSABLE handle (`ProvidedRpcStubHandle` / `RewriteRuleHandle` / `SubscriptionHandle`): disposing it — or the session ending, when capnweb
disposes every exported handle — un-sets the rule. So a rule made through the verb is
SESSION-SCOPED; a rule that must outlive its session is the raw event,
`itx.append(rewriteRuleConfiguredEvent(match, target))` — the verb minus the handle. The read
view is `itx.expressionRewriteRules.list()` / `.get(match)`.

## Layer 3 — subscriptions (own events, ONE delivery loop)

Three events of its own: `subscription-configured { name, target | null, consumes? }` (same name
REPLACES; `target: null` removes the row and, for a cursor target, its cursor),
`subscription-delivery-halted` (appended by the loop), `subscription-delivery-resumed` (appended by
an operator; un-halt, optional seek). The core reduce reduces them into `state.subscriptions`;
`stream/subscriptions.ts` is the ONE command that builds the first (`subscriptionConfiguredEvent`).
Pure data; the layer knows only the stream and the codec.

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

Nothing is declared or stamped; a rule whose target names another rule's prefix classifies
correctly because it evaluates to the same handle. `itx.subscriptions.list()` is the read door
(rows ⋈ cursors). Edge sugar: `subscribe({ name?, target | null, consumes? })` → a DISPOSABLE
`SubscriptionHandle` (its `name` getter is the generated one when none was given); a live callback
is lent under `subscription:<name>` and targeted as `itx.rpcStubs.get('…')`. Disposing the
handle, or the session ending, removes the row; the durable spelling is the raw event.

## Layer 4 — processors (sugar over layers 0 and 3)

A processor is two classes. `StreamProcessor` (`stream/processor.ts`) is the PURE one the author
writes — a contract plus `reduce` (pure switch), `processEvent` (effect switch), `projectLiveState`;
no constructor arguments, so `new PresenceProcessor().reduce(...)` is a unit test. Its host is a
`StreamProcessorDurableObject` (`sdk/stream-processor-durable-object.ts`, bundled into
`processor.js`) with one field, `processor = new PresenceProcessor()`; the host builds a `ProcessorEngine`
(serial chain, checkpoint, gap repair from the scanned-range proof, at-head pass, version re-reduce,
live-state publishing) over its facet kv and `env.ITX`. A processor class ends in `Processor`, a Durable Object
class in `DurableObject`. The host is hosted like ANY class:
`itx.load(src).getDurableObjectClass('PresenceDurableObject').get('presence')`, identity in
`ctx.props`. `enableProcessor(name, { source, className, consumes? })` appends the
`subscription-configured` event whose target is that chain + `.processEventBatch`;
`disableProcessor(name)` appends `subscription-configured { name, target: null }` and then
`itx.facets.delete(name)`. Processors are DURABLE configuration (no handle: `enableProcessor`
returns `{ name }`) — `disableProcessor` is the explicit inverse. No built-in processor runs as a facet — `tally` is a
fixture, and the one built-in `StreamProcessor` is the core reduce, hosted inline (layer 1). Policy
that need not gate an append synchronously is a userspace facet processor speaking core's control
events: `BreakerProcessor` (`e2e/support/sources.ts`) reduces durable events into a token bucket and,
on exhaustion, appends `stream/paused { reason }`; an operator appends `stream/resumed`.

## Layer 5 — the edge (sessions and the pager relay)

`session.ts` + `iterate-context.ts`: capnweb terminates in `worker.ts`'s `/api`, never in a DO
(`session.ts`: `UnauthenticatedSession → authenticate() → Session → projects.get(id)`;
`iterate-context.ts`: `IterateContext`, `cd(path)` for the rest). The edge is A PROXY IN FRONT OF
THE DO: every DO built-in root (`itx.append`, `itx.read`, `itx.waitForEvent`, `itx.kv.get`,
`itx.rpcStubs.list`, `itx.expressionRewriteRules.list`, …) rides the prototype hop into ONE
`invoke(expression)` with zero edge code (a terminal `.fetch(request)` rides the fetch channel
with the expression in `x-itx-expression`). The class declares only what must be edge code: `cd`
(pure addressing, an EDGE context), `invoke` (the hop's landing door), `provide` (THE ONE PHYSICAL
ACT — the client's capnweb stub must live here, never in the DO, so the lend happens here, through
the DON'T-PIN pager relay `context/rpc-stub-relay.ts`'s `lendRpcStubOverPager`), and `rewrite` /
`subscribe` / `enableProcessor` / `disableProcessor` — each visibly "build the event, append it";
the DO has `append` and no configuration verbs. Every lend is undone at session end by the
session's `SessionTeardown` (`session.ts`), keyed `"<iterateContextName> <rpcStubKey>"`. Everything a
client ever does — Slack-bridge RpcTargets included — is these layers composed.
