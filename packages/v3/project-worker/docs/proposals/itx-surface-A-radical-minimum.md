# itx surface A — the radical minimum

> **A method exists only for what cannot be an appended event or a capability call.** Six survive:
> `append` · `read` · `waitForEvent` (the stream), `invoke` (calling), `provide` (the one physical
> act), `cd` (navigation). Mounting, unmounting, subscribing, unsubscribing, enabling and disabling
> a processor become **event families the client appends itself** — no `route`, no `revoke`, no
> `subscribe`, no `enableProcessor`, anywhere. And the two things the code conflates today are
> pulled apart and named apart: **rpc stubs under an opaque key** and **itx expression routing** (§4).

## 1. The surface

```ts
// src/iterate-context.ts — ONE spelling. The DO implements it natively; the edge satisfies it with
// three declared methods plus the prototype hop (§3).
export interface IterateContext {
  /** Another context of THIS project; relative resolves. Pure addressing, no DO reached. */
  cd(contextPath: string): IterateContext;
  /** THE dispatch door — built-ins and every rewrite. `itx.a.b(x)` reduces onto it. */
  invoke(call: ItxExpression): Promise<unknown>;
  /** THE ONE PHYSICAL ACT: lend a LIVE capnweb value into `itx.rpcStubs` under an OPAQUE
   *  `rpcStubKey` (§4.1). Appends NOTHING — routing a call to it is a `rewrite-updated` event the
   *  caller appends (§2b). Disposing the handle recalls the lend; so does the session ending. */
  provide(rpcStubKey: string, rpcStub: unknown): Promise<ProvidedRpcStub>;
  /** The stream — built-in roots through the same door, declared because they are the contract:
   *  `itx.append(e)` IS `invoke(["itx",["append",e]])`. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(afterOffset?: number, limit?: number): Promise<StreamPage>;
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;
  /** Every other built-in root and every rewrite: itx.kv.get(k), itx.facets.get('core').snapshot(),
   *  itx.rpcStubs.list(), itx.subscriptions.list(), itx.load(src)…, itx.myCap.hello(). */
  [dotted: string]: unknown;
}
/** The client's handle on ONE lend. Disposing closes the pager and the DO drops the stub; rewrites
 *  naming its key stay, answering CONNECTION_OFFLINE. */
export class ProvidedRpcStub extends RpcTarget {
  [Symbol.dispose](): void;
}
```

**The edge (`iterate-context.ts`, stateless `/api`) writes exactly three.** `provide` — the reason
the edge exists: the client's capnweb stub must live in this isolate, never in the DO (DON'T-PIN),
so `#lendRpcStubOverPager` runs here. `cd` — pure addressing, and it must hand back an _edge_
context or a later `provide` on it would have no session to lend in. `invoke` — the landing door of
`installPrototypeInvokeCapabilityFallback`, carrying the one routing rule that already exists: a
terminal `fetch(request)` with a live `Request` rides `DO.fetch` under `x-itx-cap`, because only the
fetch channel returns a 101. `append`/`read`/`waitForEvent` are **not written at the edge at all**
(§3). **The DO** implements everything but `provide` (a DO holding a client stub never hibernates);
its four config verbs are deleted, their bodies becoming the append door's normalizer (§5.3).
Transport verbs stay off the interface: `attachRpcStubPager`, `lendRpcStub`, `rpcStubTransportState`.

## 2. Usage

```ts
// (a) route itx.db ⇒ itx.kv — pure data, so it is an append
await itx.append({
  type: "events.iterate.com/expressions/rewrite-updated",
  payload: { path: "itx.db", target: "itx.kv" },
});
await itx.db.put("greet", "hi"); // itx.db.put(…) rewrites to itx.kv.put(…)
// (b) the laptop lends a bare async function; ANOTHER client calls it with dotted syntax
const provided = await laptopItx.provide(
  "runOnMyComputer",
  async (cmd, args) => `stdout of ${cmd} ${args.join(" ")}`,
); // PHYSICAL only: an opaque key, nothing in the log yet
await laptopItx.append(
  expressionRewriteUpdatedEvent({
    path: "itx.runOnMyComputer",
    target: "itx.rpcStubs.get('runOnMyComputer')",
  }),
); // pure data
await otherItx.runOnMyComputer("ls", ["-la"]); // any other client of the same context
// (c) removing (a) and (b) — the SAME event with target: null (§4.3)
await itx.append(expressionRewriteUpdatedEvent({ path: "itx.db", target: null }));
await itx.append(expressionRewriteUpdatedEvent({ path: "itx.runOnMyComputer", target: null }));
provided[Symbol.dispose](); // the stub is physical: a separate act (or let the session end)
// (d) subscribe with a live callback = provide + append. The two layers, visible.
using tab = await itx.provide("tab-7f3a", (events, range) => render(events, range));
await itx.append(
  subscriptionUpdatedEvent({
    name: "tab",
    target: "itx.rpcStubs.get('tab-7f3a')",
    consumes: ["events.iterate.com/todo/added"],
  }),
);
await itx.append(subscriptionUpdatedEvent({ name: "tab", target: null })); // removal
// (e) enable a processor = ONE subscription onto the facet's processEventBatch
await itx.append(
  subscriptionUpdatedEvent({
    name: "tally",
    target: [
      "itx",
      ["load", "itx.kv.get('src/tally.js')"],
      ["getDurableObjectClass", "TallyDurableObject"],
      ["get", "tally"],
      "processEventBatch",
    ],
  }),
);
await itx.append(subscriptionUpdatedEvent({ name: "tally", target: null })); // disable, then
await itx.facets.delete("tally"); // the physical facet delete. Two layers again.
// (f) loaded code — env.ITX.get() hands back the SAME IterateContext, so it is the same six
export default class extends WorkerEntrypoint {
  async run() {
    const itx = await this.env.ITX.get();
    await itx.append(expressionRewriteUpdatedEvent({ path: "itx.now", target: "itx.kv" }));
    return itx.kv.get("greet");
  }
}
```

**Where the helpers live.** `expressionRewriteUpdatedEvent` and `subscriptionUpdatedEvent` are what
survives of `capability-table.ts` + `subscriptions.ts`'s four builders (DO-only today). Design A
**exports them** as pure `(input) => StreamEventInput`: a client imports them for typed payloads or
spells the JSON by hand (2a), and the DO's door calls the same two. Not a client SDK — no
connection, no state, no session — so "a client's whole dependency is the capnweb package" holds for
anyone who declines to import them. Both lose their `rows` parameter: "identical ⇒ append nothing"
moves to the door (§5.3).

## 3. The edge as a proxy

`installPrototypeInvokeCapabilityFallback(IterateContext, ["itx"])` inserts one proxied hop _between_
`IterateContext.prototype` and its parent: declared members win by ordinary lookup; any other string
key becomes a path proxy whose `apply` trap reduces the whole accumulated dotted access into ONE
`ItxExpression` — `[...root, ...prefix, [method, ...args]]` — onto the receiver's own `invoke`. A
prototype hop and not a `Proxy` around the instance because workerd's pipeline classifier
brand-checks a method's return (`NonPipelinable`; cloudflare/workerd#6873).

**A generic forward costs no round trips.** `itx.append(e)` becomes `DO.invoke(["itx",["append",e]])`
instead of `DO.append(e)`: the same single Workers-RPC hop plus one `Object.hasOwn` built-in check
and a `walkSteps` walk. Mid-chain pipelining is untouched — what the DO returns mid-chain is a
genuine `RpcTarget` (`InvokeHandle`, `FacetHandle`, `RpcStubHandle`) either way, which is what
`load-mid-chain-pipelining.e2e` pins. Two real costs: `invoke` types its return `unknown`, and a
typo lands as `NO_EXPRESSION_MATCH` rather than a missing-method error — both already true for
`itx.kv`, `itx.facets`, `itx.load`. `waitForEvent` gains a built-in root so the mirror is exact;
`ItxEntrypoint` keeps flat `append`/`read` as the processor engine's fast path.

## 4. Two things, two vocabularies — and ONE routing event

One sentence couples them today: _"the registry key IS the canonical mount path"_
(`iterate-context.ts` `#lendStub`, asserted in `rpcStubAttach`). Uncouple it.

**4.1 (a) Hibernatable rpc stubs — physical, keyed by an OPAQUE string.** `itx.rpcStubs` is an
axiom: a live capnweb value the edge session holds, reachable from a hibernated DO through a pager
socket. Its key is **any string the provider picks** — `"runOnMyComputer"`, `"tab-7f3a"`, a uuid.
Nothing parses or canonicalizes it, `rpcStubAttach`'s "key is not canonical" assertion is deleted,
and a key stops having to be spellable as a dotted path (it is a JSON5 string argument to
`itx.rpcStubs.get(...)`, so any string already works on the wire). Naming it after the expression
you intend to route to it stays a **convention**, not a rule. That is also the room the owner asked
for: `RpcStubRecord { transportId, rpcStubKey }` is where session-derived metadata (from
`authenticate()`, from the connection) later attaches — possible only while the key is opaque,
because a path is a routing fact and metadata is not.

**4.2 (b) Itx expression routing — not "capabilities".** `routing.ts` already says it: _"a mount is
a REWRITE RULE: a call that starts with `path` is the same call with `path` replaced by `target`"_.
That is a statement about **itx expressions** — it matches a call's leading steps and substitutes;
nothing in `matchMount`/`pickMount`/`rewriteCall` knows what a capability is. So the word goes
wherever it names this concept, surviving only in prose meaning "a thing you can call". One row is
an **expression rewrite**; its left side is an **expression prefix** (dotted names, any step may pin
literal args: `itx.ai.run('gpt-5')`) — exactly today's `CapabilityPath = Expression`. The payload
fields stay `path` and `target`, and keeping `path` here while (a)'s is `rpcStubKey` is what makes
the two vocabularies visibly different at every call site. `NO_CAPABILITY_MATCH` →
`NO_EXPRESSION_MATCH`; `CONNECTION_OFFLINE` stays, it belongs to (a). Not "route": it buys nothing
over the rewrite the code already performs and spends the word `fetch` will want.

**4.3 ONE event, and what the reduce loses.**

```ts
// events.iterate.com/expressions/rewrite-updated
payloadSchema: z.object({ path: z.string(), target: z.string().nullable() });
// state.expressionRewrites: Record<printedPath,
//   { path: ExpressionPrefix; target: Expression; updatedAtOffset: number }>
```

`capability-provided` + `capability-revoked` collapse into one fact — _the rewrite for this path is
now T_, or with `target: null`, _there is none_. Set and unset of one key. Honestly: **the shadow
stack goes** (`state.mounts` was an array where same-path rows coexisted, newest won, and
revoke-by-offset popped exactly one so the shadowed row came back — a map cannot say that), so
override-then-restore (`capability-table-tour.e2e` §4, `capability-table-shadow-stack-…e2e`) becomes
"re-set the old target", and the client must know what it displaced. **By-identity removal goes**
with it: `providedAtOffset` → `updatedAtOffset`, provenance only; removal is by path, which deletes
the read-then-append an offset-keyed removal would force. **`pickExpressionRewrite` loses a rule** —
specificity is longest path then most pinned args, and the offset tie-break is gone because ties are
impossible. **Last writer wins** on a contested path, which trusted intra-project coordination makes
honest. **The reduce halves**: two cases become one, a `filter` becomes a key delete. **Subscriptions
follow the same rule** — `subscription-configured` + `-removed` collapse into
`stream/subscription-updated { name, target: string | null, consumes? }`, losing nothing (that table
was already a by-name map where same-name replaces); `-delivery-halted`/`-resumed` stay separate.

## 5. The seven annotations

**1 — "if we fall through anyway, why implement anything else?"** Agreed, literally: the edge
declares `invoke`, `provide`, `cd` and nothing else. No pipelining is lost (§3). It keeps `provide`
(a client stub in the DO is a DO that never hibernates), `cd` (an edge context makes a later
`provide` lend in _this_ session) and the `fetch` branch (only `DO.fetch` carries a 101 back).

**2 — "why not `invoke`?"** Renamed on both sides, plus `InvokeCapabilityTarget.invokeCapability` →
`invoke` in `dotted-path-proxy.ts`, so the hop's landing door has one name everywhere. The cost:
`invoke` joins the reserved dotted segments, with `provide` and `cd` — three reserved words, down
from nine.

**3 — "`route` is a bad name; isn't it just a layer on `append`; why is `path` a string?"** All
three land: there is no `route` method (nor `provide(path, expression)`) — routing a call is
`itx.append({type: ".../expressions/rewrite-updated", payload: {path, target}})`, literally append,
and therefore by your rule not a function. The skinniest remaining layer sits on the **append door**:
one normalizer that canonicalizes the path, round-trips the target through the codec, and echoes the
committed event instead of appending a duplicate — that echo is the existing idempotency-hit shape,
so "a reconnect is zero events" survives with no verb. `path` is a string only at rest; the builder
and the door take an `ItxExpression` (§4.2).

**4 — "`revoke` is super messy."** Gone twice over: `provide` no longer appends, so nothing pairs
with it; and set/unset are one event, so there is no provided/revoked pair to look paired with.
Removing a rewrite is `{ path, target: null }`; recalling a stub is `provided[Symbol.dispose]()`.
The union input that made `revoke` messy _was_ the seam between (a) and (b) — now the type system's.

**5 — "can we capture the onion layers?"** The surface now _is_ the layer boundary: the six methods
are Layers 0–4, and every act above them is an event family with no method at all. `subscribe` is
provide+append (2d), `enableProcessor` is one append (2e) — you read the composition in the snippet
instead of being told about it. §6 is the chapter list.

**6 — "why is `path: string[]` not an itx expression?"** Two different `path`s hid behind one name.
The rpc-stub **key** is not an expression and should not be one (§4.1). The call **tail** walked on
the borrowed stub is one, and becomes a relative `Expression` through `InvokeHandle` →
`RpcStubDirectory.invokeRpcStub` → `BorrowedRpcStub.invoke` — deleting two `(path, args)`↔expression
conversions (today `InvokeHandle.invokeCapability` builds an expression, splits it back into
`(path, args)`, and the directory re-splits it) and making mid-chain args expressible at last.

**7 — "why `revoke` AND `unsubscribe`?"** The same act — unset a row in a reduced table — spelled
twice because each had a hand-written verb. One verb now (`append`), one shape (`target: null`).
They stay two _event types_ because they are rows in two tables with two identities: a rewrite's is
its path, a subscription's its name. That difference is real; the duplicated verbs were not.

## 6. The onion, as tutorial chapters

| #   | Layer                      | What it adds                                                                                  | Files                                                           |
| --- | -------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 0   | expression + dispatch      | a call is data; walk it against a live object graph                                           | `context/expression.ts`, `dispatch.ts`, `invoke-handle.ts`      |
| 1   | the built-in scope         | the physical roots: `kv` `whoami` `cd` `fetch` `append` `read` `waitForEvent` `facets` `load` | `context/built-ins.ts`                                          |
| 2   | the stream                 | one commit point: offsets, idempotency, pause, `waitForEvent`, the core reduce                | `stream/stream.ts`, `core-processor.ts`                         |
| 3   | the dotted surface         | `itx.a.b(x)` ⇒ ONE `invoke(expression)`; the edge is that hop plus `cd`                       | `dotted-path-proxy.ts`, `iterate-context.ts`, `session.ts`      |
| 4   | **(a) rpc stubs**          | `provide` — the one physical act, opaque key; borrow first, the pager is the second `if`      | `rpc-stub-relay.ts`, `rpc-stub-directory.ts`                    |
| 5   | **(b) expression routing** | ONE event over 0+2; a lent stub is layer 4 named as pure data                                 | `context/expression-rewriting.ts`                               |
| 6   | subscriptions              | 3 events over layer 5 + ONE delivery loop; push if the target owns its progress               | `stream/subscriptions.ts`, `subscription-delivery.ts`           |
| 7   | processors                 | no new event, no new door: a subscription onto a facet's `processEventBatch`                  | `stream/processor.ts`, `sdk/stream-processor-durable-object.ts` |

Layers 5–7 add **zero methods** — the test this design passes. Each chapter uses only the ones
beneath it: the order the tutorial teaches, and the order the files should read in.

## 7. Rename table

Nothing in the (a) column may borrow a word from the (b) column:

| (a) hibernatable rpc stubs (physical)                                         | (b) itx expression routing (data)                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `rpcStubKey` — opaque, provider-chosen                                        | `path` — an `ExpressionPrefix` (dotted names + pinned args)                                            |
| `provide(rpcStubKey, rpcStub)` · `ProvidedRpcStub`                            | `expressionRewriteUpdatedEvent({ path, target })`                                                      |
| `itx.rpcStubs.get(key)` / `.list()` (presence)                                | `state.expressionRewrites` · `ExpressionRewrite`                                                       |
| `ClientRpcStub` → `LentRpcStub` → `BorrowedRpcStub`                           | `matchExpressionRewrite` · `pickExpressionRewrite` · `applyExpressionRewrite` · `rewriteCallToBuiltIn` |
| `attachRpcStubPager` · `lendRpcStub` · `invokeRpcStub` · `CONNECTION_OFFLINE` | `ExpressionResolver` · `NO_EXPRESSION_MATCH`                                                           |

| today                                                                                     | proposed                                                                                                     | file                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `invokeCapability` · `provide(path, expr \| stub)`                                        | `invoke` · `provide(rpcStubKey, rpcStub)` — live only, appends nothing                                       | `iterate-context.ts`                        |
| `revoke` · `subscribe` · `unsubscribe` · `enableProcessor` · `disableProcessor`           | **deleted** (event families)                                                                                 | `iterate-context.ts`                        |
| `provideCapability` · `revokeCapability` · `configureSubscription` · `removeSubscription` | **deleted** → `#normalizeCoreControlEvent(event, coreReducedState)` at the append door                       | the DO                                      |
| `capability-table/capability-provided` + `capability-revoked`                             | ONE `expressions/rewrite-updated { path, target \| null }`                                                   | `stream/core-processor.ts`                  |
| `stream/subscription-configured` + `subscription-removed`                                 | ONE `stream/subscription-updated { name, target \| null, consumes? }`                                        | `stream/core-processor.ts`                  |
| `context/capability-table.ts` + `context/routing.ts`                                      | `context/expression-rewriting.ts` — one concept, one file                                                    | both                                        |
| `CapabilityResolver` · `CapabilityPath` · `Mount` · `state.mounts`                        | `ExpressionResolver` · `ExpressionPrefix` · `ExpressionRewrite` · `state.expressionRewrites`                 | as above                                    |
| `InvokeHandle.#dispatch(path, args)` · `RpcStubDirectory.invoke(key, path, args)`         | `#dispatchExpression(call: Expression)` · `invokeRpcStub(rpcStubKey, call: Expression)`                      | `invoke-handle.ts`, `rpc-stub-directory.ts` |
| `#borrowed` · `#pending` · `#pagesPending` · `#sockets()`                                 | `#borrowedRpcStubs` · `#pendingRpcStubPagerAttachments` · `#rpcStubPagesInFlight` · `#rpcStubPagerSockets()` | `rpc-stub-directory.ts`                     |
| `BorrowedStub` (DO) · `BorrowedStub` (edge) · `LentProviderStub` · `ProviderStub`         | `BorrowedRpcStub` · `LentRpcStub` · `ClientRpcStub` · inlined                                                | `rpc-stub-*.ts`                             |
| `lendStubOverRelay` · `#lendStub` · `#recallStub` · `#teardownKey`                        | `openRpcStubPager` · `#lendRpcStubOverPager` · `#recallRpcStub` · `#sessionTeardownKey`                      | `rpc-stub-relay.ts`, `iterate-context.ts`   |
| `rpcStubAttach({ key })` · `transportState` · e2e `rpcStubMountPaths`                     | `attachRpcStubPager({ rpcStubKey })` · `rpcStubTransportState` · `rpcStubRewritePaths`                       | the DO, `e2e/support/client.ts`             |

## 8. Trade-offs — what gets worse

1. **The shadow stack dies** (§4.3): displace `itx.greeter` temporarily and you must remember and
   re-set what was there. Two e2e files exist only to prove the stack; they become last-writer-wins.
2. **Two calls where there was one** for a live capability (`provide` + `append`). They ride one
   capnweb batch, but the rewrite can commit a beat before the pager attaches — that window answers
   `CONNECTION_OFFLINE`, the same answer a dead provider gives. Today's ordering guarantee ("lend
   first, mount second, un-lend if the mount is refused") is **lost**: a refused rewrite leaves a
   lent stub nothing names until the session ends.
3. **The door grows what five methods shrank.** Validation, canonicalization and the echo rule move
   into `Stream.append` — the hottest path in the package, until now free of any knowledge of which
   events exist. One lookup in `CoreContract.events[event.type]` (the schemas already exist), but the
   stream now imports the core contract's _door_ rules, not just its reduce.
4. **Discoverability drops.** `itx.` used to autocomplete nine verbs; now three. Agents will
   hand-roll event JSON and get it subtly wrong more often (a non-canonical path, a target not
   rooted at `itx`) — the door's error messages become the whole teaching surface. And three verbs
   become reserved dotted segments (`invoke`, `provide`, `cd`).
5. **Opaque stub keys cost a convention.** Presence (`itx.rpcStubs.list()`) no longer lines up with
   the table by string equality; joining them means reading each rewrite's target expression, and a
   sloppy provider can lend under a key nothing routes to.
6. **Anonymous session-scoped subscriptions lose their home**, and `enableProcessor`'s "you must
   name a source" refusal disappears (a target naming a facet that was never loaded now fails at
   first delivery). Putting the former in `ProvidedRpcStub`'s disposer would make disposing a stub
   append an event — the coupling this design breaks — so drop them.
