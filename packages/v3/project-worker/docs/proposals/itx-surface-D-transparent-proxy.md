# Proposal D — the transparent proxy: the edge has no mirror, because there is nothing to mirror

> 2026-09-02. The DO's built-in scope IS the itx surface, written once; the edge declares two things and forwards
> everything else. Fetch stays parked.

## 1. The surface

**The API is `BuiltInScope` in `src/context/built-ins.ts`** — not an interface implemented twice, the one record the
resolver dispatches against. Today's DO verbs (`provideCapability`, `revokeCapability`, `configureSubscription`,
`removeSubscription`) and today's edge-only sugar (`waitForEvent`, `enableProcessor`, `disableProcessor`) become
**roots**, assembled by four layered functions whose parameter lists ARE the onion (§6).

```ts
// src/context/built-ins.ts — the itx surface, written ONCE.
interface BuiltInScope {
  // ── layer 0 — axioms (physical or platform): today's, plus waitForEvent (was edge-only) ──
  whoami;
  kv;
  append;
  read;
  waitForEvent;
  cd;
  fetch;
  facets;
  load;
  runScript;
  /** (a) AXIOMATIC HIBERNATABLE RPC STUBS. A key is an OPAQUE string minted by whoever lends — NOT a
   *  path; later it may carry connection metadata from `authenticate()`. Nothing here knows what an
   *  expression is. */
  rpcStubs: { get(rpcStubKey: string): RpcStubHandle; list(): string[] };

  // ── layer 1 — (b) ITX-EXPRESSION REWRITES (today's "capability table") ──
  /** Set or unset ONE rewrite: a call starting with `match` runs as the same call with `match` replaced
   *  by `target` (routing.ts, unchanged); `null` unsets. Both halves are itx expressions — `match` a
   *  validated PREFIX (may pin literal args), `target` a full one. */
  rewrite(
    match: ItxExpression,
    target: ItxExpression | null,
  ): Promise<{ rewrittenAtOffset } | null>;

  // ── layer 2 — subscriptions ──
  subscribe(input: {
    name: string;
    target: ItxExpression | null;
    consumes?: string[];
  }): Promise<{ name: string }>;
  subscriptions: {
    list(): SubscriptionListEntry[];
    get(name: string): SubscriptionListEntry | null;
  };

  // ── layer 3 — processors (two lines each, over layer 2 + layer 0) ──
  enableProcessor(
    name: string,
    ref: { source: WorkerSource; className: string; consumes?: string[] },
  ): Promise<{ name: string }>;
  disableProcessor(name: string): Promise<void>;
}
```

**The DO's Workers-RPC surface** shrinks to one itx door plus transport: `invoke(call)`, `fetch`, `alarm`,
`webSocketMessage/Close/Error`, `lendRpcStub`, `rpcStubTransportState`. `rpcStubAttach` folds away (§3); the five verbs
above are **deleted** — they are roots now.

**The edge** keeps its name (`IterateContext` IS the itx you hold) and declares two things, over the fields
`#contexts`, `#iterateContextDurableObjectAddress`, `#iterateContextDurableObject`, `#sessionTeardown`, `#waitUntil`:

```ts
export class IterateContext extends RpcTarget {
  /** 1. ADDRESSING, local — a sibling EDGE context: zero DO hops, and a lend on it lands in THIS session.
   *  (The built-in `itx.cd` exists too, but returns a DO-side handle that cannot lend.) */
  cd(path: string): IterateContext;

  /** 2. THE ONE DOOR — two `if`s and a forward:
   *   • LEND: walk the expression; every live capnweb value (§3) is lent under a minted `rpcStubKey` and
   *     REPLACED by the pure data `["itx","rpcStubs",["get", rpcStubKey]]`;
   *   • FETCH LANE: a terminal `fetch(request)` carrying a live Request rides the DO's fetch channel in
   *     `x-itx-expression` — Workers RPC cannot return a socket-bearing 101.
   *  Then `durableObject.invoke(expression)`. */
  invoke(call: ItxExpression): Promise<unknown>;
}
installPrototypeItxExpressionFallback(IterateContext, ["itx"]); // unknown segment ⇒ invoke(expr)
```

`append`, `read`, `rewrite`, `subscribe`, `enableProcessor`, `waitForEvent`, `kv`, `facets`, `load` do not exist here, so none can drift.

## 2. Usage

```ts
// (a) a rewrite with no stub in sight: itx.db ⇒ itx.kv
await itx.rewrite("itx.db", "itx.kv");
await itx.db.put("k", "v"); // routing.ts rule 4: runs as itx.kv.put('k','v')
// (b) a laptop lends a function; ANOTHER client calls it with plain dots. The edge mints "k_7f3a", opens
//     its pager, forwards rewrite("itx.runOnMyComputer", "itx.rpcStubs.get('k_7f3a')"); the DO renames the
//     stub k_7f3a → "itx.runOnMyComputer" (§3) and stores THAT target.
await itx.rewrite("itx.runOnMyComputer", async (cmd: string) => (await exec(cmd)).stdout);
await other.runOnMyComputer("uname -a"); // one push; the DO walks it to the borrowed stub
// (c) removing both — one spelling, the same door, target null
await itx.rewrite("itx.db", null);
await itx.rewrite("itx.runOnMyComputer", null);
// (d) subscribe with a live callback — no special edge code; the walk in (2) already lent it
await itx.subscribe({ name: "wire", consumes: ["chunk"], target: (events, range) => log(events) });
await itx.subscribe({ name: "wire", target: null }); // …and the same door removes it
// (e) a processor — layer 3, two lines over layer 2
await itx.enableProcessor("tally", {
  source: "itx.kv.get('src/tally.js')",
  className: "TallyDurableObject",
});
// (f) loaded code — env.ITX.get() hands back the SAME IterateContext class
const itx = await env.ITX.get();
await itx.append({ type: "ran" });
await itx.rewrite("itx.helper", "itx.load(\"itx.kv.get('src/helper.js')\").getEntrypoint()");
```

## 3. The edge as a proxy

**Today, already.** `installPrototypeInvokeCapabilityFallback(IterateContext, ["itx"])` inserts a proxied hop between
`IterateContext.prototype` and its parent: a declared member wins; an unknown string key becomes a path proxy that
accumulates dotted access and, on `apply`, reduces it into ONE `invokeCapability([...root, ...prefix, [method,
...args]])`. It is a prototype hop and not a Proxy around the instance because workerd's pipeline classifier
brand-checks natively (workerd#6873). D changes only the ratio: 9 declared methods + a fallback becomes 2 + a fallback.

**Pipelining cost of a generic forward: zero, measured.** The pins in `e2e/session-wire-frames-one-round-trip.e2e.test.ts`
count CLIENT frames, and a dotted call and a declared method cost the same `{out:push 1, out:pull 1, in:resolve 1,
out:release 1}` — the reduce happens server-side at the edge, so `itx.slack.chat.postMessage(…)` is already ONE push
(test 4) and `authenticate().projects.get(ctx).invokeCapability(…)` already 3 pushes / one round trip (test 1). Moving
the declared methods onto that path changes no frame, and mid-chain pipelining (`load-mid-chain-pipelining.e2e.test.ts`)
is a DO-side chain of genuine `InvokeHandle` RpcTargets, untouched. The one thing a generic forward _would_ cost is
`cd`, which answers today with **zero** DO hops — which is why `cd` stays declared.

**What must stay edge code, made generic.** Only the client's capnweb stub lives here (don't-pin), so `invoke` walks the
expression once — after which `rewrite(path, fn)`, `subscribe({ target: fn })` and any future stub-storing door need no
edge code at all:

```ts
/** Every live capnweb value in `expression`, lent and replaced by pure data. The predicate mirrors capnweb's
 *  own `typeForRpc` (src/core.ts: `function` and `RpcTarget` are the exportable kinds) — the shape check
 *  today's `assertLiveValue` already uses. Per value: mint `rpcStubKey = k_${randomUUID().slice(0,8)}`, call
 *  `lendRpcStubOverPager(durableObject, value, rpcStubKey)` (relay unchanged), splice in the get-expression. */
function lendLiveRpcStubsInExpression(
  expression: Expression,
  lend: (v: unknown) => string,
): Expression;
```

**How the key is chosen — and the one thing the DO must do.** A **minted random id**, not a path: (a) is about stubs,
and a stub's identity must not depend on (b). But a _stored_ target naming a random key breaks the reconnect property
(`rpc-stubs-reconnect-same-path.e2e.test.ts`: a re-provide at the same path appends ZERO events), because a new session
mints a new key. The fix is DO-local and costs no hop: layer 1's `rewrite`, seeing a target shaped
`itx.rpcStubs.get(<key>)`, calls `RpcStubDirectory.renameRpcStub(fromKey, toKey)` — re-stamping the pager socket's
attachment `{ transportId, key }` — to the canonical match string, and stores `itx.rpcStubs.get('itx.runOnMyComputer')`;
a reconnect re-lends under that same name (today's "re-lending the same key REPLACES the transport") and appends
nothing. `subscribe` does the same with `itx.subscriptions.<name>`. **Naming is the log's business, so it belongs where
the log is.**

**Recall: neither side needs the pairing.** There is no recall at unset — `rewrite(match, null)` appends and stops; the
stub dies with the session (`SessionTeardown.disposeAll`, what the disposal pin already proves), and because keys are
globally unique the teardown map loses its composite `"<contextName> <capabilityPath>"` key (`#teardownKey` deleted).
`rpcStubAttach` disappears too: `lendRpcStubOverPager` opens the pager with a client-minted `transportId` in the header,
so a live rewrite costs 2 DO hops where `provide` costs 3 today.

## 4. Naming: two vocabularies, because there are two things

_"This concept is not really about capabilities, it's about itx expressions."_ Agreed — "capability" covers both halves
today, which is why the surface reads as one magic thing.

**(a) rpc stubs — physical, axiomatic, hibernatable.** Noun: _rpc stub_; identity `rpcStubKey`, an opaque minted string
(room for `authenticate()` metadata later; nothing may assume it is a path); doors `itx.rpcStubs.get/list`; machinery
`RpcStubDirectory`, `#borrowedRpcStubs`, `#rpcStubPagerFor(key)`, `BorrowedRpcStub` (DO) / `LentRpcStub` (edge),
`RPC_STUB_OFFLINE`.

**(b) itx expressions — matching calls and rewriting them.** Noun: _rewrite_ — `{ match, target }`: a call starting with
`match` runs with `match` replaced by `target`. Verb: `itx.rewrite(match, target | null)`, the ONLY verb — `provide` was
just "rewrite + lend", and once lending is generic only rewrite is left. Not "route" (fetch wants that word; a rewrite is
not a destination), not "alias" (an alias is a synonym; ours consume pinned args), not "mount" (a mount is a place).

**Is `match` an ItxExpression? Yes — a validated prefix**, and the type already exists: `CapabilityPath = Expression`
becomes `ItxExpressionPrefix = Expression`, `parseCapabilityPath` becomes `parseItxExpressionPrefix`. A prefix is the leading steps
of a call — dotted names, any of which may be a CALL STEP pinning literal args (`itx.ai.run('gpt-5')`) that the match
consumes — under two rules a full expression does not obey: no anonymous call step `("",…)`, and a call step must pin at
least one arg. The door takes `ItxExpression` (either codec half) for **both** arguments and canonicalizes, symmetric
with `target`. Same answer at the other end (annotation 6):
`RpcStubDirectory.invoke(key, path: string[], args)` becomes `invokeRpcStub(rpcStubKey, steps: Expression, args)` walked
by `walkSteps` — `string[]` cannot carry mid-path call args, so `itx.slack.channel('#x').post(y)` is unspellable through
a live stub today; `Expression` fixes it free.

## 5. Answers to the seven annotations

1. **"Why implement anything else?"** You don't. There is no `interface IterateContext` spelled twice; the fallback you
   already have IS the mirror. The edge declares `cd` (zero DO hops, and the session that lends must be this one) and
   `invoke` (the lend walk + the fetch-lane `if`); nothing else exists, so nothing else can drift. _"Do we lose
   pipelining?"_ — measured, no (§3).
2. **"Why not `invoke`?"** `itx.invoke(call)` on both sides. `invokeCapability` was `invoke` wearing the noun §4 deletes;
   `InvokeCapabilityTarget` → `InvokeTarget`; `InvokeHandle` keeps its name.
3. **"`route` is a bad name; is it just a layer on append?"** It is `rewrite` (§4), and _almost_ pure append. Three things
   stop it being a hand-written `itx.append({type:'…/rewrite-updated'})`: it canonicalizes and validates both halves so a
   bad expression fails in the parser's own words rather than being silently skipped by the reduce; it is idempotent
   against current state (an identical rewrite appends NOTHING — the reconnect property); and for a live target it
   renames the stub before the event lands. Keep it, say exactly that in the docstring, make set and unset one method.
4. **"Revoke is messy; wouldn't you set the target to null?"** Yes — `revoke` is deleted: `itx.rewrite(match, null)`.
   Revoke-by-identity goes with the shadow stack (below), and since there is no recall (§3), unset is only "set to null".
5. **"Capture the onion."** §6: four builder functions, each taking only the layers beneath as arguments, so the layering
   is enforced by parameter lists rather than by a comment.
6. **"Why is `path: string[]` not an itx expression?"** It is now `Expression` (§4) — not cosmetic: it buys mid-path call
   args on a live stub.
7. **"Why revoke AND unsubscribe?"** They were the same act on two tables; both are now "set the target to null" —
   `itx.rewrite(match, null)` and `itx.subscribe({ name, target: null })`. Two doors survive only because the tables key
   differently (an expression prefix vs a name) and subscriptions carry `consumes`; if that stops being true, merge them.

**One event, not a pair.** `capability-provided` + `capability-revoked` become
`events.iterate.com/itx-expressions/rewrite-updated { match: string, target: string | null }`; for the same reason
`subscription-configured` + `subscription-removed` become `subscription-updated { name, target, consumes? }`. **Reduce
consequence:** `state.rewrites` becomes `Record<matchString, { target, rewrittenAtOffset }>` — set on a target, `delete`
on null. Survives: newest-wins (trivially — one entry per match), longest-match-then-most-pinned-args ranking
(`pickMount`, unchanged), `rewrittenAtOffset` as ranking tiebreak and audit fact. Dies: the **shadow stack** (same-match
rewrites no longer coexist, so nothing is restored on unset) and **removal by identity** — killing
`e2e/capability-table-shadow-stack-and-mount-chains.e2e.test.ts` and the by-offset half of the provide+revoke pipelining
pin. Worth it: the map is what makes idempotence and reconnect-zero-events one-liners, and a stack nobody pops on
purpose is speculative machinery.

## 6. The onion, as a tutorial chapter list

| Layer                       | Adds                                                                                                                                            | Built purely from                                            | Files / classes                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — axioms**              | the stream (`append`/`read`/`waitForEvent`), rpc stubs (`get`/`list` + the pager), `kv`, `whoami`, `cd`, `fetch`, `facets`, `load`, `runScript` | the platform                                                 | `built-ins.ts:buildAxiomBuiltIns`, `stream/stream.ts`, `context/rpc-stub-directory.ts`, `context/rpc-stub-relay.ts`, `context/invoke-handle.ts` |
| **1 — expression rewrites** | `itx.rewrite(match, target\|null)`; one event; the reduce's `rewrites` map; `routeCall`                                                         | layer 0's `append` + the core reduce                         | `built-ins.ts:buildRewriteBuiltIns(axioms)`, `context/expression-rewrites.ts` (was `capability-table.ts`), `context/routing.ts`                 |
| **2 — subscriptions**       | `itx.subscribe`, `itx.subscriptions.list/get`, one event, ONE delivery loop                                                                     | layer 0's `append` + `invoke` (to evaluate a target)         | `built-ins.ts:buildSubscriptionBuiltIns(axioms)`, `stream/subscriptions.ts`, `stream/subscription-delivery.ts`                                  |
| **3 — processors**          | `itx.enableProcessor` / `disableProcessor`                                                                                                      | layer 2's `subscribe` + layer 0's `load` and `facets.delete` | `built-ins.ts:buildProcessorBuiltIns(axioms, subscriptions)`, `stream/processor.ts`, `sdk/stream-processor-durable-object.ts`                   |

```ts
export function buildBuiltIns(deps: BuildBuiltInsDeps): Record<string, unknown> {
  const axioms = buildAxiomBuiltIns(deps);
  const rewrites = buildRewriteBuiltIns(deps, axioms);
  const subscriptions = buildSubscriptionBuiltIns(deps, axioms);
  return {
    ...axioms,
    ...rewrites,
    ...subscriptions,
    ...buildProcessorBuiltIns(axioms, subscriptions),
  };
}
```

`disableProcessor` really is `subscribe({ name, target: null })` then `facets.delete(name)`. Delete chapter N and
chapter N−1 still runs.

## 7. Rename table (today → proposed)

| today                                                                                                 | proposed                                                                                                    | voc. | file                                         |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------- |
| `IterateContext.invokeCapability(call)`                                                               | `IterateContext.invoke(call)`                                                                               | b    | `src/iterate-context.ts`                     |
| edge `provide`/`revoke`/`subscribe`/`unsubscribe`/`enableProcessor`/`disableProcessor`/`waitForEvent` | **deleted** (built-in roots)                                                                                | b    | `src/iterate-context.ts`                     |
| DO `provideCapability` + `revokeCapability`                                                           | built-in `rewrite(match, target \| null)`                                                                   | b    | DO → `built-ins.ts`                          |
| DO `configureSubscription` + `removeSubscription`                                                     | built-in `subscribe({ name, target \| null, consumes? })`                                                   | b    | DO → `built-ins.ts`                          |
| `context/capability-table.ts` · `CapabilityResolver`                                                  | `context/expression-rewrites.ts` · `ItxExpressionRewriter`                                                  | b    | —                                            |
| `Mount { path, target, providedAtOffset }` · `state.mounts`                                           | `ExpressionRewrite { match, target, rewrittenAtOffset }` · `state.rewrites` (a map)                         | b    | `stream/core-processor.ts`                   |
| `capability-table/capability-provided` + `…/capability-revoked`                                       | `itx-expressions/rewrite-updated { match, target \| null }`                                                 | b    | event types                                  |
| `matchMount` / `pickMount` / `MountMatch` / `#newestMountAt`                                          | `matchRewrite` / `pickRewrite` / `RewriteMatch` / `#rewriteAt`                                              | b    | `context/routing.ts`, DO                     |
| `CapabilityPath` / `parseCapabilityPath` / `canonicalCapabilityPath`                                  | `ItxExpressionPrefix` / `parseItxExpressionPrefix` / `canonicalItxExpressionPrefix`                         | b    | `context/expression.ts`                      |
| `NO_CAPABILITY_MATCH`                                                                                 | `NO_EXPRESSION_MATCH`                                                                                       | b    | `lib/errors.ts`                              |
| `CAPABILITY_FETCH_HEADER` (`x-itx-cap`), `/cap?cap=`                                                  | `ITX_EXPRESSION_FETCH_HEADER` (`x-itx-expression`), `/expression?itx=`                                      | b    | `fetch/fetch-capabilities.ts`, `worker.ts`   |
| `RpcStubDirectory.invoke(key, path: string[], args)`                                                  | `invokeRpcStub(rpcStubKey, steps: Expression, args)`                                                        | a    | `context/rpc-stub-directory.ts`              |
| `#borrowed` / `#pending` / `#pagesPending` / `BorrowedStub` / `LentProviderStub`                      | `#borrowedRpcStubs` / `#pendingRpcStubPagers` / `#rpcStubPagesInFlight` / `BorrowedRpcStub` / `LentRpcStub` | a    | `rpc-stub-directory.ts`, `rpc-stub-relay.ts` |
| `lendStubOverRelay` · `rpcStubAttach` + `rpcStubLend`                                                 | `lendRpcStubOverPager` · `lendRpcStub` only (attach folded in)                                              | a    | `rpc-stub-relay.ts`, DO                      |
| `CONNECTION_OFFLINE` · `LiveCapabilityFetchServer` · "live capability"                                | `RPC_STUB_OFFLINE` · `RpcStubFetchServer` · "live rpc stub"                                                 | a    | `lib/errors.ts`, `fetch/`, docs              |

## 8. Trade-offs — what this makes worse

1. **Blind substitution breaks call-scoped callbacks. This is the big one.** Today a live value passed as an ordinary
   argument crosses edge→DO _raw_ and reaches loaded code as a callable: `load-mid-chain-pipelining.e2e.test.ts` does
   `.demo.timer.callLater(200, cb)` and worker A runs `cb.dup(); await run()`. After substitution the callee gets
   `itx.rpcStubs.get('k_…')` — an `RpcStubHandle`, an `RpcTarget`, **not callable as `cb()`** — so that test and
   `rpc-stubs-callback-fires-back.e2e.test.ts` break; and a one-shot callback becomes session-lived with its own pager
   WebSocket, so 100 calls open 100 sockets. **The minimal retreat** (recommended): substitute only the argument slots
   that _store_, declared in ONE exported constant beside the built-ins — `RPC_STUB_ARGUMENT_SLOTS = { rewrite: [1],
subscribe: ["target"] }` — two lines written once with the API, not a hand-written mirror; everything else passes raw
   as today. The pure form is worth stating because it shows where the seam really is.
2. **The shadow stack and revoke-by-identity die** (§5), and with them a real pattern: temporarily override
   `itx.ai.run`, then pop back.
3. **No recall on unset** — a stub whose only rewrite is gone stays lent and listed by `itx.rpcStubs.list()` until the
   session ends.
4. **The rename is DO-side magic.** Layer 1 re-keying a layer 0 stub is the one place the layering leaks downward; it
   buys reconnect-zero-events. Say it out loud in the code or don't do it.
5. **HTTP-batch sessions get worse before better.** No `Symbol.dispose`, cannot outlive the POST — so _any_ live value
   anywhere in a batched call now fails at the lend rather than at first use, and its pager leaks until the isolate dies
   (today only a live `provide` fails). Needs its own code, `RPC_STUB_LEND_UNAVAILABLE`, thrown at the walk.
6. **Types get weaker at the client**: with no declared methods, nothing to autocomplete unless `BuiltInScope` is
   exported as the itx type — and nothing enforces that the dotted proxy matches it.
7. **Userspace loses six names**: a rewrite at the bare root `itx` (the ancestry "default route", walkthrough §9.4) can
   no longer claim calls named `rewrite`, `subscribe`, `waitForEvent`, `enableProcessor`, … — every verb is now an
   unshadowable built-in root. And a misspelled verb (`itx.subscrbe({…})`) is `NO_EXPRESSION_MATCH` from the table, not
   a missing-method error.
8. **`x-itx-expression`, `/expression?itx=`, `RPC_STUB_OFFLINE`, `NO_EXPRESSION_MATCH` are wire contract changes** —
   clean break (prd is resettable), but the demo page, the SDK bundle and every e2e reading a code move in the same
   commit.
