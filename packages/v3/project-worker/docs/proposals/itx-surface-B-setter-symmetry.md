# Design B — setter symmetry: every configurable thing is a keyed setter, `null` removes

> **One rule.** `collection.set(key, value)` sets; `collection.set(key, null)` removes. Six verbs (`provide`/`revoke`/`subscribe`/`unsubscribe`/`enableProcessor`/`disableProcessor`) collapse into three collections, and **each event has the same shape as its setter** — one event with a nullable target, no provided/revoked pair. Fetch stays parked.

## 0. The two things, named apart

Today one word — _capability_ — covers two mechanisms that share nothing but a spelling. Design B splits them and never lets them borrow each other's vocabulary again:

- **(a) RPC STUBS — axiomatic, physical, hibernatable.** A live capnweb value lent by a session, held by the edge, borrowed by the DO over a pager socket, addressed by an opaque **key**. The key is whatever the lender picks — _not_ a path (today `rpcStubAttach` asserts it is a canonical capability path; that assertion goes). Room is left for a stub to later carry metadata from its `authenticate()` call; nothing here designs it.
- **(b) ITX-EXPRESSION REWRITING — pure data, event-sourced.** A table keyed by an expression **prefix**: _a call that starts with `prefix` runs as the same call with `prefix` replaced by `target`._ It matches and rewrites **itx expressions**; it knows nothing about sockets.

They meet in one place only: a rewrite whose target is `itx.rpcStubs.get('<key>')`. "Capability" survives as informal English for "a thing you can call" — it names **no type, event, method or error code** after this proposal.

## 1. The surface

The DO owns every contract; the whole writable surface is built-ins (`src/context/built-ins.ts`), reached through one dispatch door — identical from a capnweb client, from `env.ITX`, and from an expression inside another context.

```ts
// src/context/built-ins.ts — THE ITX SURFACE
interface BuiltInScope {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;   // the log
  read(afterOffset?: number, limit?: number): Promise<StreamPage>;
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>; // NEW as a root (§5.1)
  whoami(); kv; cd(path); fetch(request); load(source);            // the physical roots, unchanged
  /** (a) PHYSICAL, never event-sourced — and the one collection with no `set` HERE: a live stub cannot
   *  cross this hop as data without pinning the DO. Its setter is the edge's (below). */
  rpcStubs: { get(key: RpcStubKey): RpcStubHandle; list(): RpcStubKey[] };
  // (b) + the layers above it — ONE shape: get · list · set(key, value | null)
  expressions: {
    get(prefix: ExpressionPrefix): ExpressionRewrite | null;   // what does `itx.db` mean right now?
    list(): ExpressionRewrite[];
    /** `prefix ⇒ target`, or `null` to un-set it. THE only writer of the table. */
    set(prefix: ExpressionPrefix, target: ItxExpression | null): Promise<{ setAtOffset: number } | null>;
  };
  subscriptions: {
    get(name: string): SubscriptionListEntry | null; list(): SubscriptionListEntry[];
    set(name: string, delivery: SubscriptionValue | null): Promise<{ setAtOffset: number } | null>;
  };
  processors: {
    get(name: string): SubscriptionListEntry | null; list(): SubscriptionListEntry[];
    set(name: string, host: { source: WorkerSource; className: string; consumes?: string[] } | null): Promise<…>;
  };
  /** The facet startup memo, made explicit: today `load(src).getDurableObjectClass(C).get(n)` writes it
   *  as a side effect of a `get`, and `facets.delete(n)` is the same act spelled differently. */
  facets: { get(name): FacetHandle; list(): string[]; set(name, host: { source; className } | null): void };
}
```

Types (`src/context/expression.ts` — today's `CapabilityPath`, renamed; behaviour unchanged):

```ts
/** THE KEY of the expression table: an itx expression PREFIX — the leading steps a call must start with.
 *  Dotted names, any of which may be a CALL STEP pinning literal args (`itx.ai.run('gpt-5')`). Either
 *  codec half. No anonymous call step, no zero-arg call step; `parseExpressionPrefix` is the one
 *  constructor, `canonicalExpressionPrefix` the one spelling. */
export type ExpressionPrefix = string | Expression;
export type ExpressionRewrite = { prefix: Expression; target: Expression; setAtOffset: number };
/** An rpc stub's identity: an OPAQUE string the LENDER picks. The edge's sugar happens to pick the
 *  canonical prefix so the log reads well; the registry does not care and does not check. */
export type RpcStubKey = string;
export type SubscriptionValue = ItxExpression | ClientRpcStub | { target: …; consumes?: string[] };
```

**One event per setter, the same shape as the setter** (`stream/core-processor.ts`):

```ts
"events.iterate.com/expressions/expression-set": { prefix: string; target: string | null }
"events.iterate.com/stream/subscription-set":    { name: string; target: string | null; consumes?: string[] }
// DELETED: capability-provided · capability-revoked · subscription-configured · subscription-removed
// KEPT (facts, not setters): created · woken · paused · resumed · delivery-halted · delivery-resumed
```

**The edge** exists for ONE reason: a client's capnweb stub must live in the stateless `/api` worker, never in the DO (DON'T-PIN). It declares only the doors a live stub can reach.

```ts
// src/iterate-context.ts — the EDGE
export class IterateContext extends RpcTarget {
  cd(path: string): IterateContext; // pure addressing; an EDGE context, so a `set` on it lends HERE
  invoke(call: ItxExpression): Promise<unknown>; // THE forward — plus the one fetch-lane `if`
  get rpcStubs(): EdgeRpcStubCollection; // (a) set(key, stub|null) — the raw lend / recall
  get expressions(): EdgeExpressionCollection; // (b) set() may meet a live value → lend, then rewrite
  get subscriptions(): EdgeSubscriptionCollection; // same
  [dotted: string]: unknown; // append · read · waitForEvent · kv · processors · facets · every rewrite
  #lendRpcStub(key, stub);
  #recallRpcStub(key);
  #sessionTeardownKey(key); // unchanged machinery
}
/** The edge half of ONE collection: declares `set` — the only member a live value can reach — and inherits
 *  everything else through the prototype hop rooted at this collection. The rule all three share is one
 *  sentence: a LIVE value is lent into `itx.rpcStubs` under the key this setter names it by, and what
 *  reaches the DO is the pure-data expression `itx.rpcStubs.get('<key>')`. */
class EdgeExpressionCollection extends RpcTarget {
  async set(prefix: ExpressionPrefix, target: ItxExpression | ClientRpcStub | null) {
    const key = canonicalExpressionPrefix(prefix); // ONE canonicalizer: table key and stub key can't drift
    if (target === null) {
      this.#itx.recallRpcStub(key);
      return this.invoke(["itx", "expressions", ["set", key, null]]);
    }
    if (!isLiveRpcValue(target)) return this.invoke(["itx", "expressions", ["set", key, target]]);
    await this.#itx.lendRpcStub(key, target); // lend FIRST: the event records something that can serve
    return this.invoke(["itx", "expressions", ["set", key, ["itx", "rpcStubs", ["get", key]]]]);
  }
  invoke(call: ItxExpression) {
    return this.#itx.invoke(call);
  } // the hop's door
}
installPrototypeInvokeCapabilityFallback(EdgeExpressionCollection, ["itx", "expressions"]);
```

The DO's Workers-RPC surface shrinks to one door plus the stream and the platform — `invoke`, `append`, `read`, `waitForEvent`, `fetch`, `attachRpcStubPager`, `lendRpcStub`, `rpcStubTransportState`, `alarm`, `webSocket*`. **Deleted:** `provideCapability`, `revokeCapability`, `configureSubscription`, `removeSubscription`. The built-in `set` refuses a non-expression, non-null value **loudly** — that fence is the two-worlds rule: a live value is the edge's business, data is the DO's.

## 2. Usage

```ts
// (a) a pure rewrite: itx.db ⇒ itx.kv
await itx.expressions.set("itx.db", "itx.kv");
await itx.db.put("greet", "hi"); // dotted → itx.kv.put('greet','hi'), one round trip

// (b) a laptop provides a bare async function; ANOTHER client calls it dotted
await laptop.expressions.set("itx.runOnMyComputer", async (cmd, args) => execFile(cmd, args));
//   = lend into itx.rpcStubs under key 'itx.runOnMyComputer' from the LAPTOP's session, then set
//     itx.runOnMyComputer ⇒ itx.rpcStubs.get('itx.runOnMyComputer')
await otherClient.runOnMyComputer("ls", ["-la"]); // "stdout of ls -la"
await laptop.rpcStubs.set("laptop-7f3a", fn); // long hand: ONE stub…
await laptop.expressions.set("itx.shell", "itx.rpcStubs.get('laptop-7f3a')"); // …under N prefixes

// (c) removing (a) and (b)
await itx.expressions.set("itx.db", null);
await laptop.expressions.set("itx.runOnMyComputer", null); // + recalls THIS session's stub
await laptop.rpcStubs.set("laptop-7f3a", null); // the raw recall, prefixes untouched

// (d) subscribe with a live callback (removed at session end — it is a lent stub)
await itx.subscriptions.set("tab", (events, range) => render(events, range));
await itx.subscriptions.set("tab", {
  target: "itx.greet.processEventBatch",
  consumes: ["task/created"],
});
await itx.subscriptions.set("tab", null);

// (e) enable a processor — sugar: subscriptions.set + facets.set, one line each
await itx.processors.set("tally", {
  source: "itx.kv.get('src/tally.js')",
  className: "TallyDurableObject",
});
await itx.facets.get("tally").snapshot();
await itx.processors.set("tally", null); // un-subscribe + delete the facet, storage included

// (f) loaded code — the SAME class, the SAME spellings
export default class extends WorkerEntrypoint {
  async run(x) {
    const itx = await this.env.ITX.get();
    await itx.append({ type: "demo/ran", payload: { x } });
    await itx.expressions.set(
      "itx.child",
      "itx.load(\"itx.kv.get('src/child.js')\").getEntrypoint()",
    );
    return itx.db.get("greet");
  }
}
```

## 3. The edge as a proxy

`installPrototypeInvokeCapabilityFallback(IterateContext, ["itx"])` (`context/dotted-path-proxy.ts`) splices one proxied hop between `IterateContext.prototype` and its parent. Declared members win; an unknown root becomes a path proxy that accumulates segments and, at `apply`, reduces the whole access into ONE expression `[...root, ...prefix, [method, ...args]]` handed to the receiver's own `invoke`. So `itx.a.b.c(x)` is _already_ one capnweb round trip and one Workers-RPC call — a generic forward costs nothing extra, because the reduce happens before any hop. What it cannot be is a `Proxy` **around** the DO stub: workerd brand-checks a method's return for promise pipelining and a JS Proxy always falls to `NonPipelinable` (cloudflare/workerd#6873) — the reason the fallback is a prototype hop and `InvokeHandle` is a real `RpcTarget`. The three edge collections reuse that same hop, so they inherit `get`/`list`/whatever the DO grows later for free.

Three things MUST stay edge code: **(1) the lend** — a capnweb stub is pinned to the `/api` request context, and a DO holding one can never hibernate (`rpc-stub-relay.ts` + the pager); **(2) `cd`** — it must hand back an EDGE context so a `set` on a sibling lends in the same session and `SessionTeardown` (keyed `"<contextName> <stubKey>"`) can recall it; **(3) the fetch-lane `if`** in `invoke` — a terminal `fetch(Request)` rides `DO.fetch` with `x-itx-cap` because Workers RPC cannot carry a socket-bearing 101 back through `invoke`.

## 4. Naming

**(b) is about expressions, so it is spelled that way.** The collection is `itx.expressions`: `get` answers "what does `itx.db` mean right now?", `set` answers "make it mean this". The row is an `ExpressionRewrite` — which coins nothing: `context/routing.ts`'s own header already says _"A mount is a REWRITE RULE"_, so this only promotes the word the code uses to describe itself. `routing.ts` → `context/expression-rewriting.ts`; `capability-table.ts` → `context/expression-table.ts`. Rejected: _alias_ (a synonym; ours consume pinned args), _route_ (fetch will want that word, and it drags a router, route params and a routing table behind it), _mount_ (implies a mount point existing independently of calls — this only ever rewrites a call).

**The key is a partial itx expression**, precisely: `ExpressionPrefix` = today's `CapabilityPath`. **(a)'s key is not a path at all** — `RpcStubKey` is an opaque string chosen by the lender; only the edge's sugar picks the canonical prefix, and only so the log reads well and a reconnect re-lends under the same key.

## 5. Answers

**5.1 Why implement anything on the edge?** Right — this removes nearly all of it: the DO's four named write verbs go, `waitForEvent` becomes a built-in root so the edge stops declaring it, and every remaining edge member exists because a live capnweb stub is involved. No pipelining is lost (§3): the dotted reduce collapses a whole access into one expression _before_ the hop, and `invoke` forwards it verbatim, so mid-chain `InvokeHandle` pipelining on the DO is untouched.

**5.2 Why not `invoke`?** Agreed: `invoke` on all four — the edge class, the three edge collections, `InvokeHandle`, the DO. It becomes the one reserved word the dotted surface adds (alongside `cd`), cheaper than two names for one act. `invokeCapability` disappears; so does `NO_CAPABILITY_MATCH` (→ `NO_EXPRESSION_MATCH`).

**5.3 `route` is a bad name; isn't it just a layer on `append`?** It is the skinniest possible layer and it earns its keep three times: it canonicalizes the prefix (one spelling, so the table key and the stub key can never drift); it round-trips the target through the codec so a bad target fails loud at the door instead of being silently skipped in the reduce; and — the thing a raw `append` cannot do — `set(prefix, null)` must **read** the table to know whether there is anything to un-set (a repeated null appends nothing). ~6 lines, living ONCE, on the DO, keyed by an itx expression, not a string.

**5.4 `revoke` is messy — wouldn't you just set the target to null? Isn't it one UPDATE?** Yes to both, and the second is the better idea: **one event**, `expressions/expression-set { prefix, target: string | null }`, identical in shape to the setter. Reduce consequence: `target != null` pushes `{ prefix, target, setAtOffset }` — the shadow stack still grows, **newest still wins**, and `set(prefix, null)` pops **exactly the newest at that prefix**, so override → un-set → restore is intact. What **goes** is removal _by identity_: an event carrying only `{prefix, target}` cannot name a row, so `revoke({ providedAtOffset })` has no spelling. That is the right trade under trusted-client doctrine (by-identity removal exists to survive concurrent same-prefix churn between parties that distrust each other), and it _deletes_ the `string | { providedAtOffset }` union you called messy rather than relocating it. Subscriptions collapse the same way: one `subscription-set { name, target | null, consumes? }`.

**5.5 Can we capture the onion layers?** §6. The setter shape is what makes the layering legible: every layer's write door is the same three characters, so the only thing distinguishing a layer is what its key and value mean and which layers beneath it the value may name.

**5.6 Why is `path: string[]` not an itx expression?** It should be, and this fixes it everywhere at once: `RpcStubDirectory.invoke(key, path, args)` → `invokeRpcStub(key, steps: Expression)`; `InvokeHandle`'s `#dispatch(path, args)` → `#dispatch(steps: Expression)`; `invokePath(target, path, args)` → `invokeSteps(target, steps)`. The `(path, args)` pair dies at every seam and `applyRoot(args)` becomes the anonymous call step the grammar already has: `[["", ...args]]`. One shape — `Expression` — from the client's dotted access to the borrowed stub. Note this is _(b)'s_ vocabulary reaching into _(a)_: the steps walked **on** a stub are expression steps; the stub's own **key** stays opaque.

**5.7 Why `revoke` AND `unsubscribe`?** We don't. They are the same operation on two collections: `expressions.set(prefix, null)` and `subscriptions.set(name, null)` — not a coincidence to explain but the defining rule. The third instance, recalling a lent stub, is `rpcStubs.set(key, null)`.

## 6. The onion

| #   | Layer                        | Adds                                                                                                                      | Files                                                                 |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 0   | **the log**                  | `append` · `read` · `waitForEvent`; one commit point, offsets, pause                                                      | `stream/stream.ts`, `events.ts`                                       |
| 1   | **the expression**           | a call is DATA: codec, step walk, pipelinable handle                                                                      | `expression.ts`, `dispatch.ts`, `invoke-handle.ts`                    |
| 2   | **the built-ins**            | what a call bottoms out at: `kv` · `whoami` · `cd` · `fetch` · `load` · `facets`                                          | `built-ins.ts`; `invoke` = root + `walkSteps`                         |
| 3   | **(b) expression rewriting** | `expressions.set(prefix, target\|null)` — data over L0, matched by L1, terminating on L2                                  | `expression-table.ts`, `expression-rewriting.ts`, `core-processor.ts` |
| 4   | **(a) rpc stubs**            | the ONE physical thing: borrowed table + pager, opaque keys; L3 names it as data. **The edge exists only for this layer** | `rpc-stub-directory.ts`, `rpc-stub-relay.ts`                          |
| 5   | **subscriptions**            | `subscriptions.set(name, target\|null)` + ONE delivery loop; targets are L3 expressions evaluated through L2              | `subscriptions.ts`, `subscription-delivery.ts`                        |
| 6   | **processors**               | `processors.set(name, host\|null)` = `subscriptions.set` + `facets.set`, one line each                                    | `sdk/`, `stream/processor.ts`                                         |

L3 never mentions a socket; L5 never mentions a facet (it asks the evaluated value's brand); L6 appends no event shape of its own.

## 7. Renames — the two vocabularies side by side

| today (one word, two things)                                             | **(b) expression rewriting**                                                                         | **(a) rpc stubs**                                                                 | file                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------- |
| `provide` / `revoke`                                                     | `expressions.set(prefix, target\|null)`                                                              | `rpcStubs.set(key, stub\|null)` (edge)                                            | edge + `built-ins.ts`                    |
| `Mount`, `state.mounts`                                                  | `ExpressionRewrite`, `state.expressions`                                                             | —                                                                                 | `core-processor.ts`                      |
| `CapabilityPath`, `canonicalCapabilityPath`                              | `ExpressionPrefix`, `canonicalExpressionPrefix`                                                      | `RpcStubKey` (opaque)                                                             | `expression.ts`                          |
| `capability-provided` + `capability-revoked`                             | ONE `expressions/expression-set { prefix, target\|null }`                                            | none (physical; presence stays ephemeral)                                         | `core-processor.ts`                      |
| `subscription-configured` + `-removed`                                   | ONE `stream/subscription-set { name, target\|null, consumes? }`                                      | —                                                                                 | `core-processor.ts`                      |
| `capability-table.ts` · `CapabilityResolver` · `capabilityProvidedEvent` | `expression-table.ts` · `ExpressionResolver` · `expressionSetEvent`                                  | —                                                                                 | `context/`                               |
| `matchMount` · `pickMount` · `MountMatch` · `routeCall`                  | `matchExpressionPrefix` · `pickExpressionRewrite` · `ExpressionMatch` · `rewriteExpressionToBuiltIn` | —                                                                                 | `routing.ts` → `expression-rewriting.ts` |
| `NO_CAPABILITY_MATCH`                                                    | `NO_EXPRESSION_MATCH`                                                                                | `CONNECTION_OFFLINE` (kept)                                                       | `lib/errors.ts`                          |
| `invokeCapability` (edge) / `invoke` (DO)                                | `invoke` on both, and on `InvokeHandle`                                                              | —                                                                                 | `iterate-context.ts`                     |
| `waitForEvent` (edge method) · `enableProcessor`/`disableProcessor`      | root `itx.waitForEvent` · `processors.set(name, host\|null)`                                         | —                                                                                 | `built-ins.ts`                           |
| `RpcStubDirectory.invoke(key, path, args)`                               | steps are an `Expression`                                                                            | `invokeRpcStub(key, steps)`                                                       | `rpc-stub-directory.ts`                  |
| `#borrowed` · `#pagesPending` · `#pending`                               | —                                                                                                    | `#borrowedRpcStubs` · `#rpcStubPagesInFlight` · `#pendingRpcStubPagerAttachments` | `rpc-stub-directory.ts`                  |
| `BorrowedStub` (DO) / `BorrowedStub` (edge) / `LentProviderStub`         | —                                                                                                    | `BorrowedRpcStub` / `LentRpcStub` / `ClientRpcStub`                               | directory / relay                        |
| `lendStubOverRelay` · `#lendStub` · `#recallStub` · `#teardownKey`       | —                                                                                                    | `openRpcStubPager` · `#lendRpcStub` · `#recallRpcStub` · `#sessionTeardownKey`    | relay + edge                             |
| `rpcStubAttach` · `rpcStubLend` · `transportState`                       | —                                                                                                    | `attachRpcStubPager` · `lendRpcStub` · `rpcStubTransportState`                    | DO                                       |
| e2e `rpcStubMountPaths`                                                  | `rpcStubExpressionPrefixes`                                                                          | —                                                                                 | `e2e/support/client.ts`                  |

## 8. Trade-offs — what gets worse

1. **The sentence rule loses.** `itx.provide(path, fn)` is better English than `itx.expressions.set(prefix, fn)`. Uniformity is bought by spending rule 1: the surface becomes nouns-with-`set`, not verbs with itx as the subject.
2. **By-identity removal is gone** (§5.4). Two clients setting the same prefix concurrently can pop each other's row with a `null`, and `revoke(theReceiptIGot)` has no spelling; the shadow-stack e2e that revokes a whole concurrent wave by offset must be rewritten to pop by prefix — a weaker claim about the stack.
3. **`set(key, null)` on a missing key is a no-op** (a setter that throws on delete is not a setter), so today's loud `revoke("itx.nope")` error goes and a typo'd removal is silent.
4. **`expressions` is more abstract than `capability`.** It is accurate — that is the point — but a newcomer reading "capability" knows what it is _for_; "expression table" tells them only the mechanism. The product word now lives only in prose.
5. **The value stops being an expression as you climb.** `processors.set` and `facets.set` take options objects; only `expressions` and `subscriptions` are honestly "key ⇒ expression". The shape rhymes; the type does not.
6. **Anonymous subscriptions die** — a keyed setter has no unnamed key, so the generated `sub-<8hex>` goes. Replacement: _any_ subscription whose value was a live stub is removed at session end (today's teardown widened from anonymous rows to all live ones), which diverges from the "the row is data, the socket was weather" doctrine for subscriptions specifically: a _named_ live subscription that used to survive its session no longer does.
7. **Three edge collection classes instead of three edge methods** — each ~8 lines plus a prototype-hop install (a module-load side effect with an idempotence guard), and `itx.expressions.invoke` becomes reserved.
8. **Chaining off a collection costs a second dispatch** (`itx.rpcStubs.get(k).hello()` reduces to ONE expression today; through a declared edge collection it is `get` then a pipelined `.hello()` — same round trip, two DO dispatches) — and the **typed seam is lost**: with the DO's named verbs deleted, edge→DO is `invoke(expression)`, so a typo `tsc` catches today becomes a runtime `NO_EXPRESSION_MATCH`.
9. **`facets.set` overlaps `load(src).getDurableObjectClass(C).get(n)`** — the most satisfying consequence of the rule and the most dangerous: two spellings for one act unless one is deleted, which this proposal does not do.
10. **A flag day for no behaviour change.** Event-type strings change and every doc, header, test name and helper saying "mount"/"capability" is touched; a fresh deployment (or an erase) is required.
