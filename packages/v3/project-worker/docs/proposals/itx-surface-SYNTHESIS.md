# itx surface — synthesis of the four proposals (A radical minimum · B setter symmetry · C onion rings · D transparent proxy)

> 2026-09-02. Four sub-agents designed the surface under four incompatible constraints, each answering
> Jonas's seven annotations. This is where they agree (adopt), where they split (four decisions), and
> the surface that falls out. The four docs sit beside this one. Fetch stays parked.

## 1. Where all four converged — adopt without further debate

|     | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | who         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | **The edge does NOT hand-mirror the API.** The prototype-hop fallback (`dotted-path-proxy.ts`) already forwards any dotted access as ONE `invoke(expression)`; a generic forward costs **zero** extra round trips (D measured it against the wire-frame pins: a dotted call and a declared method both cost `push 1 · pull 1 · resolve 1 · release 1`). The edge declares only what must be edge code.                                                                           | A B C D     |
| 2   | **`invoke`, not `invokeCapability`.** Everywhere: edge, DO, `InvokeHandle`, the hop's landing door.                                                                                                                                                                                                                                                                                                                                                                              | A B C D     |
| 3   | **Two vocabularies, "capability" gone as a noun.** (a) **rpc stubs**: physical, hibernatable, addressed by an **opaque key** — the `rpcStubAttach` canonical-path assertion is deleted (all four, independently). (b) **itx-expression rewriting**: a rule matches a CALL and rewrites it.                                                                                                                                                                                       | A B C D     |
| 4   | **The noun for a rule is **rewrite rule\*\* — `{ match, target }`; the verb is `rewrite`. "route" rejected four times (fetch wants it; a rewrite is not a destination), "alias" (a synonym; ours consume pinned args), "mount" (a place). It is the word `routing.ts`'s own header already uses.                                                                                                                                                                                 | A B C D     |
| 5   | **ONE event with a nullable target** replaces the provided/revoked pair; the same for subscriptions. Set and unset are one fact.                                                                                                                                                                                                                                                                                                                                                 | A B C D     |
| 6   | **The DO's four config verbs die** (`provideCapability`, `revokeCapability`, `configureSubscription`, `removeSubscription`); the DO's Workers-RPC surface is `invoke` + transport plumbing.                                                                                                                                                                                                                                                                                      | A B C D     |
| 7   | **`path: string[]` → `itxExpressionSteps: ItxExpression`** in `RpcStubDirectory.invoke` and `InvokeHandle` — deletes two `(path, args)` ↔ expression conversions (A and B found the same double conversion) and makes `itx.cam.zoom(2).snap()` spellable on a live stub.                                                                                                                                                                                                         | A B C D     |
| 8   | **The stub key stays opaque, the sugar derives it** from the canonical match string so a reconnect appends zero events. D's alternative (a DO-side rename of the stub) is the one place D leaks a layer downward; D itself flags it.                                                                                                                                                                                                                                             | B C (D: no) |
| 9   | **Layer order**: stream → expressions/dispatch → rewrites → rpc stubs → subscriptions → processors; processors add no event and no door of their own.                                                                                                                                                                                                                                                                                                                            | A B C D     |
| 10  | **Fully qualified stub names**, the same list in all four: `#borrowedRpcStubs`, `#pendingRpcStubPagerAttachments`, `#rpcStubPagesInFlight`, `BorrowedRpcStub` (DO) / `LentRpcStub` (edge) / `ClientRpcStub`, `attachRpcStubPager`, `lendRpcStub`, `invokeRpcStub`, `returnBorrowedRpcStubs`, `lendRpcStubOverPager`, `#lendRpcStub`, `#recallRpcStub`, `#sessionTeardownKey`, `rpcStubTransportState`, `RPC_STUB_OFFLINE` (was `CONNECTION_OFFLINE`), `NO_ITX_EXPRESSION_MATCH`. | A B C D     |

## 2. Where they split — four decisions

**D1 — Shadow stack or map? → MAP (Jonas, round 2: "I don't like this stack stuff — way easier to just
delete the rule from a map, easier to reason about").** `state.itxExpressionRewriteRules` is
`Record<canonicalMatch, ItxExpressionRewriteRule>`: a non-null target REPLACES the entry at `match`, `null`
DELETES it. No shadow stack, no restore-what-was-beneath, no removal by identity, no offset on a row —
"newest wins" is trivially true because there is one entry per match, and the ranking is longest match
then most pinned args, nothing else. Override-then-restore is "set it back yourself". The two e2e files
that prove the stack (`capability-table-shadow-stack-and-mount-chains`, the by-offset half of the
wire-frames pin) are deleted, not rewritten.

**D2 — Is there a verb, or only `append`?** A: no verb; the client appends
`rewrite-rule-updated` itself and a "normalizer" at the append door canonicalizes/validates/echoes. B C D: a
thin verb as a **built-in root**, because it does three things `append` cannot: canonicalize both
halves (one spelling, so the table key and the stub key never drift), fail LOUD in the parser's own
words, and append NOTHING when the table already says so (an identical set, or a null on nothing) —
the reconnect-is-zero-events property. **Recommendation: the verb, ~6 lines, on the DO as a root**
(B/C/D). A's version moves event knowledge into `Stream.append`, the hottest path, and drops
discoverability to three names.

**D3 — Where does a live value enter?** A: a separate physical `provide(rpcStubKey, stub)` that appends
nothing, then a second call for the rewrite (loses lend-first/rewrite-second, opens a
`RPC_STUB_OFFLINE` window, a refused rewrite leaves a dangling stub). C: `provide(path, { stub })` =
lend + rewrite, two doors writing one table. D: intercept ANY live value in ANY `invoke` — D's own
trade-off #1 shows this breaks call-scoped callbacks (`load-mid-chain-pipelining.e2e`: `callLater(200,
cb)` must reach loaded code as a callable) and turns one-shot callbacks into session-lived pager
sockets; D's retreat is "declared slots", i.e. B. B: the SAME write door accepts a live value in the
value position; the edge lends at exactly those doors. **Recommendation: B's shape with flat verbs:**
`itx.rewrite("itx.runOnMyComputer", async fn)` — the edge sees a live target, lends it under the
canonical match string, forwards `itx.rpcStubs.get('<key>')`. That is today's `provide` sniff
(`assertLiveValue`), no new magic, no `{ stub }` ceremony on the headline line. `provide` disappears:
it was only "rewrite + lend". The raw physical door exists beside it for (a) on its own:
`itx.rpcStubs.lend(key, { stub, … })` / `itx.rpcStubs.recall(key)` — the object form is where an idle
policy or timeout goes later; the sugar has no options.

**D4 — Flat verbs or uniform `collection.set`?** B makes every layer `get · list · set(key, value|null)`
(`itx.expressions.set`, `itx.subscriptions.set`, `itx.processors.set`); B's own first trade-off is
that the sentence rule loses. C/D keep flat verbs and use nouns for READS. **Recommendation: flat
verbs for writes, nouns for reads** — `itx.rewrite(match, target|null)`, `itx.subscribe({ name,
target|null })`, `itx.enableProcessor` / `disableProcessor`; `itx.expressionRewriteRules.list()/get(match)`,
`itx.subscriptions.list()/get(name)`, `itx.rpcStubs.list()/get(key)`. Set-and-unset is still one door
per layer (Jonas's "one thing"); only the spelling differs from B.

## 3. The surface that falls out

Base types first (context/expression.ts), fully qualified: today's `Expression` (the parsed array) is
`ItxExpression`; today's `ItxExpression` (string | array — what a door accepts) is `ItxExpressionInput`,
the `StreamEventInput`/`StreamEvent` pairing; a `Step` is an `ItxExpressionStep`; `CapabilityPath` is
`ItxExpressionPrefix`. Every "steps" is `itxExpressionSteps`. "Rewrite" alone
is the act; the stored row is a **rewrite rule** (`ItxExpressionRewriteRule`, event `rewrite-rule-configured`), the
term-rewriting word routing.ts's header already uses; `rewrite` stays the verb (`itx.rewrite(match, target | null)`,
null = stop rewriting `match`). The read collection on itx is
`itx.expressionRewriteRules` — "itx" is the receiver, so the one redundant word is dropped, nothing else.

```ts
// THE ITX SURFACE — written ONCE as the DO's built-in roots (context/built-ins.ts). A capnweb client,
// loaded code (env.ITX) and an expression inside another context all reach the same thing.

// layer 0 · the stream
append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
read(afterOffset?: number, limit?: number): Promise<{ events: StreamEvent[]; scannedThroughOffset: number }>;
waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;          // becomes a root (was edge-only)
// layer 1 · expressions — the physical scope a call bottoms out in, plus the one door
invoke(call: ItxExpressionInput): Promise<unknown>;                            // was invokeCapability
whoami · kv · cd · fetch · load · facets                                   // unchanged
// layer 2 · (b) itx-expression rewrite rules — pure data, ONE event
/** A call starting with `match` runs as the same call with `match` replaced by `target`; `null` deletes the
 *  rule at `match`. Both halves are itx expressions; `match` may pin literal args. Appends
 *  `itx/rewrite-rule-configured { match, target | null }` — or nothing, when the table already says so. */
rewrite(match: ItxExpressionInput, target: ItxExpressionInput | null): Promise<StreamEvent | null>; // the committed event, or null when the table already said so
expressionRewriteRules: { list(): ItxExpressionRewriteRule[]; get(match: ItxExpressionInput): ItxExpressionRewriteRule | null };
// layer 3 · (a) rpc stubs — the axiom: physical, hibernatable, OPAQUE key. Presence is list().
rpcStubs: { get(rpcStubKey: string): RpcStubHandle; list(): string[] };
// layer 4 · subscriptions — ONE event `stream/subscription-configured { name, target | null, consumes? }`
subscribe(input: { name?: string; target: ItxExpressionInput | null; consumes?: string[] }): Promise<{ name: string }>;
subscriptions: { list(): SubscriptionListEntry[]; get(name: string): SubscriptionListEntry | null };
// layer 5 · processors — two lines each over layer 4 + `load` + `facets.delete`
enableProcessor(name: string, ref: { source: WorkerSource; className: string; consumes?: string[] }): Promise<{ name: string }>;
disableProcessor(name: string): Promise<void>;
```

```ts
// THE EDGE (src/iterate-context.ts) — a proxy in front of the DO. Declares FOUR things; everything
// else is the prototype hop → invoke. Each of the four exists for a reason only the edge can serve.
class IterateContext extends RpcTarget {
  cd(path: string): IterateContext;   // zero DO hops; returns an EDGE context so a later lend lands in THIS session
  invoke(call: ItxExpressionInput);        // the hop's landing door + the terminal-fetch(Request) lane (x-itx-expression → DO.fetch)
  rewrite(match, target);             // ONE `if`: a LIVE target is lent under the canonical match string, then forwarded as itx.rpcStubs.get('<key>'); null also recalls this session's stub
  subscribe(input);                   // the same `if` for a live target (key `itx.subscriptions.<name>`); anonymous rows torn down at session end as today
  rpcStubs: { lend(key, { stub, … }); recall(key) } // (a) raw, physical; plus the inherited get/list
}
```

```ts
// USAGE
await itx.rewrite("itx.db", "itx.kv");                                   // (a) pure data
await laptop.rewrite("itx.runOnMyComputer", async (cmd, args) => …);     // (b) live: lend + rewrite, one line
await other.runOnMyComputer("ls", ["-la"]);                               //     any other client, plain dots
await itx.rewrite("itx.db", null); await laptop.rewrite("itx.runOnMyComputer", null); // (c) unset; the laptop's stub is recalled
await itx.subscribe({ name: "tab", target: (events, range) => render(events, range) }); // (d) live callback
await itx.subscribe({ name: "tab", target: null });
await itx.enableProcessor("tally", { source: "itx.kv.get('src/tally.js')", className: "TallyDurableObject" }); // (e)
const itx = await env.ITX.get(); await itx.rewrite("itx.helper", "itx.load(…).getEntrypoint()");           // (f) loaded code, same surface
```

**The DO side of (a), the two ifs** (`context/rpc-stub-directory.ts`): `#borrowedRpcStubs` keyed by
key, `lendRpcStub({ key, stub })` unconditional, `invokeRpcStub(key, itxExpressionSteps: ItxExpression)` = have we got
it? call it · else is there a pager for it? page it · else `RPC_STUB_OFFLINE`; `returnBorrowedRpcStubs`
at the idle quiesce; presence = borrowed ∪ pager-backed. Transport verbs off the surface:
`attachRpcStubPager`, `lendRpcStub`, `rpcStubTransportState`.

## 4. Renames (the two vocabularies side by side)

| today                                                                                                                   | (b) itx-expression rewriting                                                                                                                                 | (a) rpc stubs                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provide(path, expr)` · `revoke` · `provideCapability` · `revokeCapability`                                             | `rewrite(match, target \| null)` (built-in root; edge declares it for the live `if`)                                                                         | —                                                                                                                                                   |
| `provide(path, fn)`                                                                                                     | `rewrite(match, fn)` (sugar)                                                                                                                                 | `rpcStubs.lend(key, { stub })` · `rpcStubs.recall(key)` (raw, edge)                                                                                 |
| `subscribe` / `unsubscribe` / `configureSubscription` / `removeSubscription`                                            | `subscribe({ name, target \| null, consumes? })` (root)                                                                                                      | —                                                                                                                                                   |
| `invokeCapability`                                                                                                      | `invoke`                                                                                                                                                     | —                                                                                                                                                   |
| `Mount { path, target, providedAtOffset }` · `state.mounts`                                                             | `ItxExpressionRewriteRule { match, target }` · `state.itxExpressionRewriteRules`                                                                             | —                                                                                                                                                   |
| `capability-table/capability-provided` + `-revoked`                                                                     | ONE `itx/rewrite-rule-configured { match, target \| null }`                                                                                                  | —                                                                                                                                                   |
| `stream/subscription-configured` + `-removed`                                                                           | ONE `stream/subscription-configured { name, target \| null, consumes? }` (today's name; `-removed` folds in)                                                 | —                                                                                                                                                   |
| `CapabilityPath` · `parseCapabilityPath` · `canonicalCapabilityPath`                                                    | `ItxExpressionPrefix` · `parseItxExpressionPrefix` · `canonicalItxExpressionPrefix`                                                                          | `rpcStubKey` (opaque string)                                                                                                                        |
| `context/capability-table.ts` + `context/routing.ts` · `CapabilityResolver`                                             | `context/itx-expression-rewriting.ts` (rules on top, the door + `ItxExpressionRewriter` below — ONE concept, one file, the table test stays)                 | —                                                                                                                                                   |
| `matchMount` · `pickMount` · `rewriteCall` · `routeCall` · `MountMatch`                                                 | `matchItxExpressionPrefix` · `pickItxExpressionRewriteRule` · `applyItxExpressionRewriteRule` · `rewriteItxExpressionToBuiltIn` · `ItxExpressionPrefixMatch` | —                                                                                                                                                   |
| `NO_CAPABILITY_MATCH` · `x-itx-cap` · `/cap?cap=`                                                                       | `NO_ITX_EXPRESSION_MATCH` · `x-itx-expression` · `/expression?itx=`                                                                                          | `RPC_STUB_OFFLINE` (was `CONNECTION_OFFLINE`)                                                                                                       |
| `LiveCapabilityFetchServer` · "live capability"                                                                         | —                                                                                                                                                            | `RpcStubFetchServer` · "live rpc stub"                                                                                                              |
| `RpcStubDirectory.invoke(key, path, args)` · `#borrowed` · `#pending` · `#pagesPending`                                 | —                                                                                                                                                            | `invokeRpcStub(key, itxExpressionSteps)` · `#borrowedRpcStubs` · `#pendingRpcStubPagerAttachments` · `#rpcStubPagesInFlight`                        |
| `BorrowedStub` (DO) · `BorrowedStub` (edge) · `LentProviderStub` · `ProviderStub`                                       | —                                                                                                                                                            | `BorrowedRpcStub` · `LentRpcStub` · `ClientRpcStub` · inlined                                                                                       |
| `lendStubOverRelay` · `#lendStub` · `#recallStub` · `#teardownKey` · `rpcStubAttach` · `rpcStubLend` · `transportState` | —                                                                                                                                                            | `lendRpcStubOverPager` · `#lendRpcStub` · `#recallRpcStub` · `#sessionTeardownKey` · `attachRpcStubPager` · `lendRpcStub` · `rpcStubTransportState` |
| `enableProcessor` / `disableProcessor` (edge-only) · `waitForEvent` (edge method)                                       | roots (zero edge code)                                                                                                                                       | —                                                                                                                                                   |
| e2e `rpcStubMountPaths` · `processorNames` (regex)                                                                      | `itx.expressionRewriteRules.list()` · `itx.subscriptions.list()`                                                                                             | —                                                                                                                                                   |

## 5. Commits (each green on tsc · oxlint · knip · unit+workers · e2e · tutorial-proof)

1. **(a) rpc stubs**: fully qualified names, the two-if directory keyed by key, `itxExpressionSteps: ItxExpression`,
   `RPC_STUB_OFFLINE`, the canonical-key assertion deleted, `rpcStubs.lend/recall` at the edge.
2. **(b) expression rewriting**: the vocabulary, ONE file, ONE event over a map, `state.itxExpressionRewriteRules`,
   `NO_ITX_EXPRESSION_MATCH`, `x-itx-expression`; subscriptions' ONE event.
3. **The surface**: roots for `rewrite` · `expressionRewriteRules` · `subscribe` · `enableProcessor` · `disableProcessor` ·
   `waitForEvent`; the DO's four verbs deleted; the edge down to `cd` · `invoke` · `rewrite` · `subscribe` ·
   `rpcStubs.lend/recall`; `invoke` everywhere; every e2e re-pointed.
4. **Docs**: walkthrough, tutorial file map and Part 0 order (C's "three bridges" wrinkle), BUILD-LOG.

## 6. Costs we accept (the honest list, from all four)

- Wire and event-type changes: a flag day (prd is resettable; every e2e reading a code moves in the same commit).
- The shadow stack and removal by identity are gone; a null deletes the entry at that match. The two e2e files that prove the stack are deleted.
- The client's type is unenforced beyond the four declared edge members; a typo is `NO_ITX_EXPRESSION_MATCH`, not a missing method. (Already true for `itx.kv`, `itx.facets`, `itx.load`.)
- Six new reserved dotted roots (`rewrite`, `expressionRewriteRules`, `subscribe`, `enableProcessor`, `disableProcessor`, `waitForEvent`).
- "Capability" and "mount" prose churn across headers, docs and BUILD-LOG (history docs untouched).

## 7. Why no offset on a rewrite-rule row (Jonas: "what is an actual case where this race matters?")

Today's `providedAtOffset` does three jobs. **Identity for by-offset revoke** — gone in all four designs
(a `null` deletes the entry at the match). **The ranking tie-break** in `pickMount` — unnecessary: the table is a map with one entry per
match, and two rules with DIFFERENT matches can never tie (equal length and equal pinned-arg count means
the same prefix). **A
receipt** — `provideCapability` returns `{ providedAtOffset }` so a caller can tell "appended" from
"idempotent no-op"; returning the committed `StreamEvent` (or `null`) says the same without a bespoke field.

The race by-identity removal defended against: A sets `itx.g ⇒ X`, B sets `itx.g ⇒ Y` a moment later, A then
un-sets "its" rule and pops Y instead. Under trusted intra-project coordination there is no real instance
of it: a reconnecting provider re-sets the SAME target (appends nothing), two providers at one match is a
configuration mistake last-writer-wins makes visible, and the 16 e2e uses of `providedAtOffset` are
by-identity revokes and appended-vs-no-op assertions, not a behaviour. Speculative machinery; deleted.

`configuredAtOffset` on a SUBSCRIPTION row is different and stays: the delivery loop seeds a new
subscription's cursor from it (`subscription-delivery.ts`: `confirmedOffset: row.configuredAtOffset`) — a
subscription starts at the moment it was configured, not at offset 0. That is a behaviour, not a receipt.

## 8. Plannotator round 2 (2026-09-02) — the ten annotations, resolved

**8.1 Fully qualified names everywhere** (annotation 2). Not just the stub machinery: every field, private
method, type, event payload field and helper in both vocabularies. The ONLY bare names are the handful of
verbs a client types on `itx` (`provide`, `invoke`, `rewrite`, `subscribe`, `cd`, `append`, `read`).

**8.2 The layers, in the order the tutorial builds them** (annotation 5) — this replaces §3's surface:

```ts
// CHAPTER 1 · rpc stubs — the axiom. String keys, a stub, args. Nothing else exists yet.
provide(rpcStubKey: string, provided: { stub: unknown }): Promise<ProvidedRpcStub>;   // ProvidedRpcStub is DISPOSABLE (8.4)
invoke(rpcStubKey: string, ...args: unknown[]): Promise<unknown>;                       // borrow-or-page, then call
// CHAPTER 2 · itx expressions — a call is data. `invoke` generalizes: its argument becomes an ItxExpressionInput
//   (`invoke("itx.rpcStubs.get('k')('ls')")`), and the dotted surface reduces `itx.a.b(x)` onto it.
invoke(call: ItxExpressionInput): Promise<unknown>;
// CHAPTER 3 · rewrite rules — convenience over chapters 1–2: pure data, ONE event, the verb "just appends" (8.3)
rewrite(match: ItxExpressionInput, target: ItxExpressionInput | null): Promise<RewriteRuleHandle>; // DISPOSABLE (8.4)
// CHAPTER 3b · provide learns a rewrite: the rule is added with the stub and NULLED when the stub disappears
provide(rpcStubKey, { stub, rewrite?: ItxExpressionInput }): Promise<ProvidedRpcStub>;
// CHAPTER 4 · subscriptions · CHAPTER 5 · processors — as before; `subscribe` returns a DISPOSABLE handle too.
```

The chapter-1 `invoke(rpcStubKey, ...args)` and the chapter-2 `invoke(call)` are the SAME door at two
points in the tutorial — the signature evolves when expressions arrive (a key becomes
`itx.rpcStubs.get('<key>')`); it is not a permanent overload.

**8.3 The verb lives on the RPC target, not the DO** (annotation 4). `rewrite`, `subscribe`,
`enableProcessor`/`disableProcessor` are methods of `IterateContext` (the edge class — which is ALSO what
`env.ITX.get()` hands loaded code, so one class serves both). Each is visibly "build the event, append it":
`rewrite` = `canonicalItxExpressionPrefix(match)` → `rewriteRuleConfiguredEvent(match, target)` →
`this.invoke(["itx", ["append", event]])` → wrap the committed event in a handle. The DO has `append` (and
the reads). Reconnect-is-zero-events: the verb reads `itx.expressionRewriteRules.get(match)` first and
appends nothing when the table already says so (a read + an append on the edge; a raced duplicate is a
harmless no-op in the reduce — trusted clients). The DO's `provideCapability` / `revokeCapability` /
`configureSubscription` / `removeSubscription` are deleted; nothing replaces them on the DO.

**8.4 Every verb returns a DISPOSABLE RpcTarget** (annotations 3, 7) — the capnweb pattern: a function
returns a stub that is at least disposable, so `using` works. `using provided = await itx.provide(key, {
stub })` recalls the stub at scope end; `using rule = await itx.rewrite(match, target)` un-sets the rule;
`using sub = await itx.subscribe({…})` removes the subscription. The handle may grow methods later
(`rule.target`, `provided.rpcStubKey`). **The consequence to decide with eyes open:** capnweb calls an
exported RpcTarget's `Symbol.dispose` BOTH when the client disposes the last stub AND when the session
aborts (capnweb `src/rpc.ts` `abort()` disposes every export). So "dispose un-sets the rule" makes a rule
created through the verb **session-scoped** — like a lent stub. A rule that must outlive its session is
appended as the raw event (`itx.append(rewriteRuleConfiguredEvent(match, target))`) — the verb IS just append
plus a handle, so the two spellings differ in exactly one thing: lifetime. Recommended, and honest about
today: mounts are durable data that outlive sessions; under this design the durable spelling is the event,
the scoped spelling is the verb. (Annotation 3 dissolves with the map: disposing the handle deletes the entry at that match.)

**8.5 Examples use INLINE sources** (annotation 8). `WorkerSource` already accepts `{ type: "inline", files:
{ "tally.js": "export class TallyProcessor …" } }` (worker-loader.ts; `load-sources.e2e` proves it). Every
example and the tutorial write the processor inline; `itx.kv.get('src/tally.js')` is a storage choice, not
the shape of the API. If an inline processor cannot be written in one string, that is a defect to fix.

**8.6 No flag-day worry** (annotation 9): no backwards compatibility, no re-exports, wire and event names
change freely. §6's first cost is struck.

**8.7 Guards sweep** (annotation 10): a read-only audit of every guard in src against the trusted-client
doctrine is running → `docs/proposals/guard-audit.md` (table: guard · what it defends against · real
case? · DELETE/KEEP · lines saved · what a wrong deletion breaks).

**8.8 The one event's name — DECIDED (Jonas): `rewrite-rule-configured`.** Full type
`events.iterate.com/itx/rewrite-rule-configured { match, target | null }` — the row noun is
"rewrite rule" and the fact mirrors today's `stream/subscription-configured` exactly; the family prefix
`itx/` already carries the domain word, so it is not repeated in the fact
(`itx-rewrite-configured` was the alternative). The subscription twin keeps its name and absorbs the
removal: `stream/subscription-configured { name, target | null, consumes? }`;
`subscription-removed` is deleted. The event builders are `rewriteRuleConfiguredEvent(match, target)` and
`subscriptionConfiguredEvent(name, target, consumes)`.
