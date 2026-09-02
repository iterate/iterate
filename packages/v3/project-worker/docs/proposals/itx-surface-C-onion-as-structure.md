# itx surface C — the onion as code structure

> 2026-09-02. Alternative to `docs/plan-itx-surface-mirror-and-route-rename.md`, against today's tree. One thesis:
> **the layers of the onion are the nouns of the API** — six rings, each written purely in terms of the rings beneath,
> in the order the tutorial builds them. Fetch stays parked.

## 1. The surface

Each ring is one `interface` that `extends` the ring beneath, so the layering is a fact `tsc` checks and
`IterateContext` is literally the outermost ring.

```ts
// src/iterate-context.ts — THE surface, spelled ONCE. The DO implements every member except `invoke` as a
// built-in root (context/built-ins.ts, already `satisfies`-checked); the edge declares four of them.

/** RING 0 · THE STREAM — the log and its one commit point (stream/stream.ts). Nothing beneath it. */
interface ItxStream {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(afterOffset?: number, limit?: number): Promise<StreamPage>;
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>; // becomes a built-in root
}
/** RING 1 · EXPRESSIONS — ONE dispatch door, and the physical scope a call resolves against
 *  (today's BuiltInScope, unchanged: whoami · kv · cd · fetch · load · runScript · facets). */
interface ItxExpressions extends ItxStream, BuiltInScope {
  /** Every dotted access reduces here: `itx.a.b(x)` ⇒ `invoke(["itx","a",["b",x]])`. */
  invoke(call: ItxExpression): Promise<unknown>;
  cd(path: string): IterateContext; // the one member whose DO twin differs (it returns an InvokeHandle)
}
/** RING 2 · THE REWRITE TABLE — pure data appended to ring 0, read by ring 1. Not "capabilities": a rule
 *  matches a CALL and rewrites it (context/routing.ts, rules 1–5). */
interface ItxRewrites extends ItxExpressions {
  /** A call starting with `match` runs as the same call with `match` replaced by `replacement`. `null`
   *  unsets the newest rule at `match`. ONE event either way; `null` back = nothing changed. */
  rewrite(
    match: ItxExpression,
    replacement: ItxExpression | null,
  ): Promise<{ setAtOffset: number } | null>;
  rewrites: {
    list(): ExpressionRewriteRow[];
    get(match: ItxExpression): ExpressionRewriteRow | null;
  };
}
/** RING 3 · RPC STUBS — the axiom (physical, hibernatable, OPAQUE keys) plus the one door composing it with ring 2. */
interface ItxRpcStubs extends ItxRewrites {
  rpcStubs: { get(key: string): RpcStubHandle; list(): string[] };
  /** Lend `stub` under a key derived from `path`, then `rewrite(path, "itx.rpcStubs.get('<key>')")`. Exact
   *  inverse: `provide(path, null)` unsets that rule AND recalls what THIS session lent. */
  provide(
    path: ItxExpression,
    live: { stub: unknown } | null,
  ): Promise<{ setAtOffset: number } | null>;
}
/** RING 4 · SUBSCRIPTIONS — rings 0+1 (+3 for a live callback). `target: null` removes the row: `rewrite`'s shape, one ring out. */
interface ItxSubscriptions extends ItxRpcStubs {
  subscribe(input: {
    name?: string;
    target: ItxExpression | { stub: unknown } | null;
    consumes?: string[];
  }): Promise<{ name: string }>;
  subscriptions: { list(): SubscriptionRow[]; get(name: string): SubscriptionRow | null };
}
/** RING 5 · PROCESSORS — `enable` IS a subscribe to a `load(...)` chain, `disable` that plus `facets.delete`.
 *  Nothing beneath this ring mentions a processor. */
interface ItxProcessors extends ItxSubscriptions {
  processors: {
    enable(
      name: string,
      ref: { source: WorkerSource; className: string; consumes?: string[] },
    ): Promise<{ name: string }>;
    disable(name: string): Promise<void>;
    list(): string[]; // rows whose name has a `facet:<name>` memo — no regex over targets
  };
}
export interface IterateContext extends ItxProcessors {}
```

**Where a verb lives, by rule:** flat on `itx` if it is the floor (`append`/`read`/`waitForEvent`/`invoke`/`cd`) or if it can carry a **live capnweb value** and so must be edge code (`provide`, `subscribe`); otherwise on its layer's noun — `itx.facets.delete(name)` is today's precedent. `rewrite` is the judgment call: it carries nothing live, but it is the context's own act, not a member's, so it stays flat beside `provide`.

**The DO** implements rings 0–5 as its built-ins record does today (`satisfies IterateContext`), plus the native `append`/`read`/`waitForEvent` the `Context` seam needs. Deleted as Workers-RPC verbs: `provideCapability`, `revokeCapability`, `configureSubscription`, `removeSubscription` — they become built-in roots reached through the ONE `invoke` door, so the DO's verb list and the itx root list are the same list.

**The edge** declares exactly four members, each for a reason only the edge can serve: `cd` (returns an edge context, so a later `provide` on it lends in _this_ session); `invoke` (the name the prototype hop dispatches onto, and owner of the terminal-`fetch(Request)` branch that must ride `DO.fetch` with `x-itx-cap`, because a socket-bearing Response cannot return through an RPC result); `provide` and `subscribe` (a live capnweb stub must never be an `invoke` argument — it would serialize into the DO and pin it). `append`, `read`, `waitForEvent`, `rewrite`, `rewrites`, `rpcStubs`, `subscriptions`, `processors`, `kv`, `facets`, `load`, `whoami`, `runScript`: **zero lines of edge code.**

## 2. Usage

```ts
using api = newWebSocketRpcSession("wss://<worker>/api");
const itx = api.authenticate().projects.get("prj_123");

// (a) itx.db ⇒ itx.kv — pure data, one event, nothing live
await itx.rewrite("itx.db", "itx.kv");
await itx.db.put("greet", "hi"); // rewritten to the kv built-in

// (b) the laptop lends a bare async function; ANOTHER client calls it with plain dots
await itx.provide("itx.runOnMyComputer", {
  stub: async (cmd, args) => (await execFile(cmd, args)).stdout,
});
await itx.runOnMyComputer("ls", ["-la"]); // ⇒ invoke(["itx",["runOnMyComputer","ls",["-la"]]]) ⇒ rule hit
//   ⇒ itx.rpcStubs.get('itx.runOnMyComputer')("ls",["-la"]) ⇒ page the edge ⇒ the laptop's function

// (c) removing (a) and (b)
await itx.rewrite("itx.db", null); // unsets the newest rule at itx.db; what it shadowed returns
await itx.provide("itx.runOnMyComputer", null); // unsets the rule AND recalls this session's stub

// (d) a live callback, pushed every commit (range = { after, through }; heal a gap with read)
const { name } = await itx.subscribe({
  name: "tab",
  target: { stub: (events, range) => render(events, range) },
  consumes: ["message.posted"],
});
await itx.subscribe({ name, target: null }); // …and off again

// (e) a processor: a facet whose processEventBatch is subscribed to every commit
await itx.processors.enable("unread-counts", {
  source: "itx.kv.get('counter.js')",
  className: "UnreadCounterDurableObject",
});
```

```js
// (f) loaded code — env.ITX.get() hands back the SAME IterateContext a capnweb client holds
export default class extends WorkerEntrypoint {
  async run(x) {
    const itx = await this.env.ITX.get();
    await itx.append({ type: "task.done", payload: { x } });
    return await itx.runOnMyComputer("echo", [String(x)]); // dots pipeline natively here too
  }
}
```

## 3. The edge as a proxy

`installPrototypeInvokeCapabilityFallback(IterateContext, ["itx"])` splices a Proxy hop **between** `IterateContext.prototype` and its parent. Declared members resolve first; a miss returns `createInvokeCapabilityPathProxy`, a function-backed Proxy accumulating segments that, on apply, calls `receiver.invokeCapability([...root, ...prefix, [method, ...args]])`. It is a prototype hop and not a Proxy _around_ the instance because workerd brand-checks a method's return for pipelining — a Proxy falls to `NonPipelinable` (cloudflare/workerd#6873) — which is also why every mid-chain handle is a real `InvokeHandle extends RpcTarget`.

**A generic forward costs nothing in round trips.** The client sends ONE capnweb expression; capnweb's server-side path traversal walks the segments **in the edge isolate**, hits the hop, and reduces the whole access into ONE `invoke(expr)` over Workers RPC. A declared edge method costs the same one-plus-one (`session-wire-frames-one-round-trip.e2e.test.ts` pins the client half today), and mid-chain handles behave identically either way — `itx.facets.get('x').method()` is one expression; awaiting mid-chain costs a second hop in both designs. What it _does_ cost: no compile-time member check and no `in` (a typo'd root is a `NO_EXPRESSION_MATCH` at the table, not a missing-method error — the "KNOWN QUIRKS" comment already says so), and the `RESERVED` names (`then`, `dup`, `map`, `catch`, `onRpcBroken`, `toJSON`, `asymmetricMatch`, …) can never be roots reached by dots.

**What must stay edge code:** the lend dance (`lendStubOverRelay` → `rpcStubAttach` → the pager WebSocket → a fresh `BorrowedStub` per page) with its `SessionTeardown` bookkeeping — hence `provide` and `subscribe` — plus `cd` and `invoke`. Four members; nothing else.

## 4. Naming — two vocabularies, because there are two things

Jonas: _"this concept is not really about capabilities, it's about ITX expressions."_ That splits today's vocabulary in two. **Capability** survives only as a property of a stub (what its holder may do) — never as the name of a table, a row, an error or a door.

**(a) RPC STUBS — the axiom.** Physical, hibernatable, addressed by an **opaque key**: a string and nothing more. Today `rpcStubAttach` asserts the key is a canonical capability path — that assertion is deleted. `provide` derives a key from the path it rewrites (keeping today's spelling and the one-transport-per-key reconnect property), but the registry never parses it. `RpcStubRecord` stays `{ transportId, key }`; connection metadata from `authenticate()` would later join that record — room left, not designed.

**(b) ITX-EXPRESSION REWRITING — the table.** A rule is `{ match, replacement }`: _a call starting with `match` runs as the same call with `match` replaced by `replacement`_ — already the first paragraph of `context/routing.ts`. The noun that follows is **rewrite** (term rewriting: inherited, not invented). Not "route" (fetch is promised that word, and you are unsure of it), not "alias" (an alias is a synonym; these consume pinned args), not "mount" (a filesystem metaphor naming a _thing mounted_ when what exists is a rule over calls).

**`match` is an expression, not a string:** `ExpressionPrefix = Expression`, produced by `parseExpressionPrefix` (was `parseCapabilityPath`) — an `Expression` in which no step is the anonymous call and no call step is empty, so `itx.ai.run('gpt-5')` is a legal prefix that pins args. Doors take `ItxExpression` (either codec half) and store `print(...)`; one canonicalizer, `canonicalExpressionPrefix`. The directory's `path: string[]` becomes `steps: Expression` for the same reason: `string[]` plus one `args` array can only express `a.b.c(args)`, so a lent stub can never be called `itx.cam.zoom(2).snap()` today. `MountMatch.stepsAfterMount` is already an `Expression`; passing it through unflattened deletes a conversion and buys mid-chain args on live stubs.

**ONE event, not a pair.** `capability-provided` + `capability-revoked` collapse into `events.iterate.com/expression/rewrite-configured { match, replacement: string | null }`, mirroring `subscription-configured`, which is already the set-or-replace shape. Reduce consequences: a non-null payload pushes a row and the **shadow stack survives verbatim** (same-match rows coexist; most specific, then newest wins — `pickMount`'s ranking untouched); a null payload pops the **newest** row at that match, so shadow/restore behaves exactly as the e2e tour proves. What **goes** is revoke-by-identity (`revokeCapability({ providedAtOffset })`) — popping from the middle of a stack, always at odds with calling it a stack. The row keeps an identity (`setAtOffset`, was `providedAtOffset`) because tie-breaking needs it and `rewrites.list()` shows it; `rewrite()` returns it as a receipt, not a handle. The door appends nothing when the unset finds nothing (the `subscriptionRemovedEvent` pattern), so idempotence lives at the door and the reduce stays pure. Same collapse one ring out: `subscription-configured { name, target: string | null }` retires `subscription-removed` (the delivery loop drops the cursor on a null target — one `if`).

## 5. Answers to the annotations

**1 — why implement anything else at the edge?** You are right, and the fallback already _is_ the generic forward. Design C spells the surface once and implements it once, on the DO; the edge declares four members (§1) and gets the rest free, losing nothing in pipelining (§3). The current proposal's second implementation buys compiler-checked parity between hops; design C buys a ~40-line edge class and pays with a client type no edge class implements — softened because `buildBuiltIns` already `satisfies` that same interface, so the DO is the checked implementation and the edge is its subset.

**2 — why not `invoke`?** No reason. `invoke` everywhere: edge, DO (already), `InvokeHandle`, the `Context` seam (already), and as the hop's dispatch target. `invokeCapability` only existed to dodge a collision with the DO's `invoke` while the two hops had different vocabularies.

**3 — `route` is a bad name; is it just a layer on append; why is `path` a string?** The name is `rewrite`, because the mechanism is expression rewriting and `route` is promised to fetch (§4). It _is_ the skinniest layer over `append` — canonicalize, compare with the current winner, build one event, append — and it earns a verb only for those three lines; a caller wanting no door can `itx.append({ type: "…/expression/rewrite-configured", … })` and the reduce honours it. And `match` is an `ItxExpression` parsed into an `ExpressionPrefix`, never a string.

**4 — revoke is messy; wouldn't you set the target to null?** Yes. `revoke` is deleted. Removal is `rewrite(match, null)` at ring 2 and `provide(path, null)` at ring 3 (which additionally recalls the stub this session lent — the exact inverse of the door that lent it). Nothing looks "paired" because nothing is a pair: one door per ring, one event per ring, `null` means unset.

**5 — capture that these are the most core things, the second most core, and so on.** That is the whole design: six rings, each an `interface … extends` the ring beneath, each a noun on `itx`, each implemented in two-to-four lines over the ring below, with the tutorial's chapter order as the ring order (§6). The compiler checks the claim; the deletion ladder demonstrates it.

**6 — why is `path: string[]` not an itx expression?** It should be: `invokeRpcStub(key: string, steps: Expression)`, and `InvokeHandle`'s dispatch becomes `(steps: Expression)` too. Note the asymmetry the two vocabularies force: the stub **key** stays an opaque string (ring 3 knows nothing of expressions), while everything walked **on** the stub is an `Expression` (ring 1's currency). Today's canonical-path assertion in `rpcStubAttach` is what conflated them; it goes.

**7 — why revoke AND unsubscribe?** They are the same _shape_ at two rings, so they get the same spelling and neither gets a verb: `rewrite(match, null)` and `subscribe({ name, target: null })`. They are not the same _act_ — one unsets a rewrite rule, the other stops a delivery — which is exactly why the rings, not the verbs, are what distinguish them.

## 6. The onion — rings, files, chapters

| Ring              | Adds                                                                                                        | Files / classes                                                                                                        | Tutorial                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 0 · stream        | `append` · `read` · `waitForEvent`                                                                          | `stream/stream.ts`, `stream/events.ts`                                                                                 | Brick 8 / Ch 3             |
| 1 · expressions   | `invoke` + the dotted surface + the physical scope (`kv`·`cd`·`fetch`·`load`·`facets`·`runScript`·`whoami`) | `context/expression.ts`, `dispatch.ts`, `dotted-path-proxy.ts`, `invoke-handle.ts`, `built-ins.ts`, `worker-loader.ts` | Bricks 1–2, 5 / Ch 1       |
| 2 · rewrites      | `rewrite` · `rewrites` — ONE event reduced into `state.rewrites`                                            | `context/expression-table.ts` (was capability-table.ts), `routing.ts`, core's `rewrites` slice                         | Brick 6 + brick 8's reveal |
| 3 · rpc stubs     | `rpcStubs` (axiom) + `provide` (the composition with ring 2)                                                | `context/rpc-stub-directory.ts`, `rpc-stub-relay.ts`                                                                   | Bricks 3–4 / Ch 1          |
| 4 · subscriptions | `subscribe` · `subscriptions`                                                                               | `stream/subscriptions.ts`, `subscription-delivery.ts`                                                                  | Ch 3                       |
| 5 · processors    | `processors.enable/disable/list`                                                                            | `stream/processor.ts`, `sdk/stream-processor-durable-object.ts`                                                        | Ch 3                       |

Each ring's write door is two-to-four lines over the ring beneath: `provide` = derive a key, lend, `rewrite(path, "itx.rpcStubs.get('<key>')")`; `processors.enable` = `subscribe({ name, target: ["itx",["load",src],["getDurableObjectClass",C],["get",name],"processEventBatch"], consumes })` — today's body, verbatim.

**Deleting the outermost ring leaves everything beneath compiling.** Delete 5: `processors` and `sdk/`; nothing below names a processor (users spell the subscribe by hand — that _is_ `enable`'s body). Delete 4: `subscribe`, `subscriptions`, `subscription-delivery.ts`, core's `subscriptions` slice, and `Stream`'s injected `onCommit` becomes a no-op; rings 0–3 untouched. Delete 3: the directory, the relay, the pager door in `DO.fetch`, `rpcStubAttach`/`rpcStubLend`, `returnBorrowedStubs`, `RpcStubHandle` — ring 2 still works with expression replacements (`itx.load(…)`, `itx.kv`, `itx.cd`): exactly brick 6 without bricks 3–4. Delete 2: `routing.ts` collapses to "is the root a built-in? run it : deny" — brick 2. Delete 1: a bare `Stream` on a DO — brick 8's toy.

**One honest wrinkle in the order.** The tutorial teaches stubs (bricks 3–4) _before_ the table (brick 6) because a socket is easy to see; the real dependency runs the other way — the table is what gives a lent stub its name — and the tutorial's own "three bridges" paragraph is where it flips. The rings above are the **door** order, not the file order: ring 3's _directory_ is an axiom depending on nothing, and only its _door_ (`provide`) depends on ring 2. A rewrite of Part 0 should follow the ring order and retire the bridges paragraph.

## 7. Rename table — the two vocabularies side by side

| today                                                                                     | proposed                                                                                                                   | file                                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `IterateContext.invokeCapability(call)`                                                   | `invoke(call)`                                                                                                             | iterate-context.ts                       |
| `installPrototypeInvokeCapabilityFallback` · `createInvokeCapabilityPathProxy`            | `installPrototypeInvokeFallback` · `createExpressionPathProxy`                                                             | dotted-path-proxy.ts                     |
| **(b) itx expressions**                                                                   |                                                                                                                            |                                          |
| `context/capability-table.ts` · `CapabilityResolver`                                      | `context/expression-table.ts` · `ExpressionRewriter`                                                                       | —                                        |
| `Mount { path, target, providedAtOffset }` · state `mounts`                               | `ExpressionRewrite { match, replacement, setAtOffset }` · state `rewrites`                                                 | core-processor.ts                        |
| `capability-provided` + `capability-revoked`                                              | ONE `expression/rewrite-configured { match, replacement \| null }`                                                         | core-processor.ts                        |
| `capabilityProvidedEvent` · `capabilityRevokedEvent`                                      | `expressionRewriteConfiguredEvent`                                                                                         | expression-table.ts                      |
| `CapabilityPath` · `parseCapabilityPath` · `canonicalCapabilityPath`                      | `ExpressionPrefix` · `parseExpressionPrefix` · `canonicalExpressionPrefix`                                                 | expression.ts                            |
| `matchMount` · `pickMount` · `MountMatch`                                                 | `matchExpressionPrefix` · `pickExpressionRewrite` · `ExpressionPrefixMatch` (`rewriteCall`, `routeCall` keep their names)  | routing.ts                               |
| `NO_CAPABILITY_MATCH`                                                                     | `NO_EXPRESSION_MATCH`                                                                                                      | lib/errors.ts + callers                  |
| `provide(path, expr)` · `revoke` · `provideCapability` · `revokeCapability`               | `rewrite(match, replacement \| null)` — one door, a DO built-in root                                                       | iterate-context.ts, DO                   |
| **(a) rpc stubs**                                                                         |                                                                                                                            |                                          |
| `BorrowedStub` (relay) · `BorrowedStub` (directory) · `LentProviderStub` · `ProviderStub` | `LentRpcStub` · `BorrowedRpcStub` · `ClientRpcStub` · (inlined)                                                            | rpc-stub-relay.ts, rpc-stub-directory.ts |
| `#borrowed` · `#pending` · `#pagesPending`                                                | `#borrowedRpcStubs` · `#pendingRpcStubPagerAttachments` · `#rpcStubPagesInFlight`                                          | rpc-stub-directory.ts                    |
| `attach` · `lend` · `closed` · `drop` · `invoke(key, path, args)`                         | `attachRpcStubPager` · `lendRpcStub` · `rpcStubPagerClosed` · `dropRpcStubPager` · `invokeRpcStub(key, steps: Expression)` | rpc-stub-directory.ts                    |
| `lendStubOverRelay` · `disposeStub` · `#lendStub`/`#recallStub`/`#teardownKey`            | `lendRpcStubOverPager` · `disposeRpcStub` · `#lendRpcStub`/`#recallRpcStub`/`#sessionTeardownKeyFor`                       | rpc-stub-relay.ts, iterate-context.ts    |
| `CONNECTION_OFFLINE`                                                                      | `RPC_STUB_OFFLINE`                                                                                                         | lib/errors.ts + callers                  |
| `rpcStubAttach({ key })`'s canonical-path assertion                                       | deleted — the key is opaque                                                                                                | DO                                       |
| **rings 4–5**                                                                             |                                                                                                                            |                                          |
| `configureSubscription` · `removeSubscription` · `unsubscribe`                            | `subscribe({ name, target \| null })` — one door, a DO built-in root                                                       | DO, iterate-context.ts                   |
| `subscription-configured` + `subscription-removed`                                        | ONE `subscription-configured { name, target \| null }`                                                                     | core-processor.ts                        |
| `enableProcessor` · `disableProcessor` (edge)                                             | `itx.processors.enable/disable/list` (built-in root; zero edge code)                                                       | built-ins.ts                             |
| e2e `rpcStubMountPaths` (reads `snapshot().state.mounts`) · `processorNames` (a regex)    | `itx.rewrites.list()` · `itx.processors.list()`                                                                            | e2e/support/client.ts                    |

## 8. Trade-offs — what this makes worse

- **The client's type is unenforced.** No edge class implements `IterateContext`; the fallback returns `Promise<unknown>` through a Proxy. `buildBuiltIns` `satisfies`-checks the DO so the interface is never fiction, but a client typo is a runtime `NO_EXPRESSION_MATCH`, `"x" in itx` still lies, and the two edge/DO divergences (`invoke` is not a root; `cd` returns an edge context, not an `InvokeHandle`) live in prose because no compiler catches them.
- **Prose churn is enormous.** "Capability" and "mount" are load-bearing in `ARCHITECTURE.md`, `LAYERS.md`, the walkthrough, the tutorial, `BUILD-LOG.md` and every source header. The largest single cost here, and it buys vocabulary, not behaviour.
- **`{ stub }` taxes the best line in the product.** `itx.provide("itx.runOnMyComputer", fn)` becomes `…, { stub: fn })`. It kills a `typeof` sniff and marks the ring-3 seam syntactically, but it is ceremony on the tutorial's headline and every e2e changes.
- **`rewrite(match, null)` reads worse than `revoke(path)`**, and revoke-by-identity is gone: popping a shadowed row that is not the newest now means popping the ones above it first. `subscribe({ name, target: null })` reads worse than `unsubscribe(name)`, for the same symmetry.
- **Seven new reserved roots** (`waitForEvent`, `rewrite`, `rewrites`, `provide`, `subscribe`, `processors`, and writes on `subscriptions`) join the ten today; five of ~18 roots are layer views. `itx.processors` is the first I would cut — `subscriptions.list()` plus the facet memo answers it.
- **The rings show in the API but not in the reduce.** `CoreState` holds `rewrites` and `subscriptions` in ONE contract (`core` 3.0.0), so "delete ring 4" edits a shared schema and bumps a contract version instead of deleting a file. A real dent in the deletion ladder; I am not proposing to reverse the one-core-reduce decision to fix it.
- **Two doors where there was one.** `rewrite` and `provide` both write the table. The split is the point — pure data vs. the composition with a physical stub — but a newcomer must learn it, where today's single overloaded `provide` let them not care.
