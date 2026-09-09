# Workerd-idioms review — `packages/v3/project-worker`, 2026-09-02

> Read as a workerd maintainer would: is this how the platform wants to be used? Every claim below
> is anchored to a Cloudflare doc page or to workerd behaviour the package itself already cites.
> Scope: `src/` (not tests), `wrangler.jsonc`, `wrangler.test.jsonc`, `e2e/support/solo-config.ts`.
> Nothing was edited; this file is the only write.

---

## Summary (5 lines)

1. **The RPC hygiene is unusually good and mostly already earned**: `.apply` on stubs is gone everywhere (only `Reflect.apply`), `dup()` is correct at the one place a param stub is retained, prototype-only members are respected, pipelining is threaded unawaited on purpose, and the facet door copies-and-disposes its results.
2. **The one real class of defect is disposal asymmetry**: the facet door is meticulous, the _dynamic-worker_ door (`workers.get` / `runScript` / `loadConfinedWorker`) and the SDK's `env.ITX.get()` are not — every call there mints stubs and result objects that are never disposed, which is precisely what extends a callee's execution context and keeps loaded isolates resident.
3. **The facet door reimplements a memo the platform already owns**: `ctx.facets.get(name, startup)` invokes its callback _only_ when the facet is cold, but `#invokeFacet` runs `LOADER.get` + `getDurableObjectClass` on **every** call before ever reaching it.
4. **The DO constructor is heavier than a hibernating DO's constructor should be**: it does a durable SQL write and kicks off an un-gated delivery fan-out on _every_ wake, against documented guidance to minimize constructor work under hibernation — and it grows the log by one durable `stream/woken` row per incarnation, forever, duplicating a counter already in `ctx.storage.kv`.
5. **Everything else is small**: one alarm-arming call that should consult `getAlarm()`, one WebSocket close-echo that the platform now does natively at this compat date, one un-reaped socket class, and a handful of nits. The big architectural divergences (one door per host kind, the cacheKey-gated producer, the `x-itx-expression` fetch lane, the prototype hop, capnweb-never-in-the-DO) are **justified and should not be re-litigated** — the list is at the end.

---

## Ranked findings

### F1 — HIGH · The facet door bypasses `ctx.facets`'s own startup memo and loads on every call

**Where:** `src/iterate-context-durable-object.ts:400-536`, specifically `:449-483`.

**What it does.** Every `itx.facets.get(name).m()` — including every subscription push into a processor, which is the hottest path in the package — runs, in order: read the kv memo (`:430`), `await loadConfinedWorker(...)` → `env.LOADER.get(id, getCode)` (`:449`), re-check the memo for a racing delete (`:462`), `worker.getDurableObjectClass(className, { props })` (`:467`), compare/write the version marker (`:471-482`), and only then `this.ctx.facets.get(name, () => ({ class: klass }))` (`:483`). The startup callback is a closure over a class that has _already_ been minted.

**The idiomatic shape.** The Dynamic Workers docs are explicit that the callback is the memo: _"If the facet has not started yet, or has hibernated, the runtime calls `getStartupOptions` to determine what code to load. **Otherwise, the existing facet is reused and the callback is not invoked.**"_ and _"`callback` can optionally be `async`"_ (Durable Object Facets, `developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/`). Kenton's own facets post does exactly this: keep the code id in `ctx.storage.kv`, load _inside_ the callback.

```ts
// sourceVersion is computable WITHOUT loading: the caller's cacheKey, or the modules' content hash.
const sourceVersion = memo.cacheKey ?? contentHashOf(memo.source);
const previousSourceVersion = this.ctx.storage.kv.get(`facet:${name}:version`) as
  | string
  | undefined;
if (previousSourceVersion !== undefined && previousSourceVersion !== sourceVersion)
  try {
    this.ctx.facets.abort(name, "source changed");
  } catch {
    /* not running */
  }
if (previousSourceVersion !== sourceVersion)
  this.ctx.storage.kv.put(`facet:${name}:version`, sourceVersion);

// THE LOAD, now only on a cold or hibernated facet — the platform's memo, not ours.
const facet = this.ctx.facets.get(name, async () => {
  const { worker } = await loadConfinedWorker({
    env: this.env,
    host: this.#itxHost,
    kind: "facet",
    owner: facetLoaderOwner(this.#name.name, memo.className),
    source: memo.source,
    cacheKey: memo.cacheKey,
    invoke: (c) => this.invoke(c),
    where: `facet "${name}"`,
  });
  return {
    class: worker.getDurableObjectClass(memo.className, {
      props: { iterateContextName: this.#name.name, name },
    }),
  };
});
this.#liveFacetNames.add(name);
```

**Why it matters.** (a) Two RPC stubs (`WorkerStub`, `DurableObjectClass`) are minted and dropped undisposed per facet call — see F2 for what that costs. (b) `sourceVersion` only needs the _spec_, never the load, so the whole `await` is on the hot path for nothing. (c) The racing-delete check at `:461-463` exists only because the load is awaited outside the facet manager; inside the callback the manager serialises it and the check disappears. (d) It makes the code read as if it distrusts `ctx.facets`, when in fact it mirrors it faithfully everywhere else.

**Caveat to verify before doing it:** a _producer-expression_ source calls `this.invoke(...)` from inside `getCode`, which would then run inside the facet startup callback. That re-entrancy already exists today (getCode calls back into dispatch); confirm the facet manager does not serialise it into a self-deadlock. One e2e (`load-sources.e2e.test.ts` with a producer + a facet) settles it.

**Size:** ~25 lines net deletion (the load moves, `sourceVersion` stops being a return value of `loadConfinedWorker`, the racing-delete check goes).

---

### F2 — HIGH · The dynamic-worker door never disposes anything; the facet door's own lesson isn't applied there

**Where:** `src/context/built-ins.ts:209-232` (`callEntrypoint`, behind `itx.workers.get(...)` and `itx.runScript(...)`) and `src/context/worker-loader.ts:135-161`.

**What it does.**

```ts
const { worker } = await loadConfinedWorker({ ... });                 // WorkerStub — never disposed
const entrypoint = worker.getEntrypoint(spec.className, ...);         // stub        — never disposed
const fn = entrypoint[method];
return Reflect.apply(fn, entrypoint, args);                           // result      — never disposed
```

Compare `#invokeFacet` at `iterate-context-durable-object.ts:514-531`, which carefully `structuredClone`s the answer and calls `[Symbol.dispose]()` on it, with a comment recording the incident that forced it ("every `snapshot()` left such a result behind, so an aborted facet stayed referenced and this actor could not be evicted (pinned, billed) until the garbage collector happened by"). The same rule applies verbatim one file over, and is not applied.

**The docs.** Workers RPC — Lifetimes, Memory and Resource Management (`developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/`):

- _"When an RPC returns any kind of object, that object will have a disposer added by the system… The only time the value returned by an RPC does not have a disposer is when it is a primitive value."_
- _"you should almost always store the result of an RPC into a `using` declaration."_
- _"if any stubs are passed, then the execution context is implicitly extended until all such stubs are disposed (and all calls made through them have returned)."_

**The idiomatic shape.**

```ts
const callEntrypoint = async (spec, method, args) => {
  const { worker } = await loadConfinedWorker({ ... });
  using entrypoint = worker.getEntrypoint(
    spec.className, spec.props === undefined ? undefined : { props: spec.props },
  ) as Fetcher & Record<string, (...a: unknown[]) => Promise<unknown>>;
  const fn = entrypoint[method];
  if (typeof fn !== "function") throw new Error(`workers.get(spec): no method "${method}"`);
  using result = await Reflect.apply(fn, entrypoint, args);          // the disposer the docs mean
  return typeof result === "object" && result !== null ? structuredClone(result) : result;
};
```

(`using` is supported by wrangler v4 and by this tsconfig's target; the package already uses `Symbol.dispose` directly elsewhere.)

**Why it matters.** These undisposed handles are exactly what keeps a dynamically-loaded isolate resident and the parent's execution context extended — the failure mode already recorded in this repo's own memory as _"worker-loader isolate accumulation OOMs local dev (~78MB/nonce-keyed isolate)"_, and the reason the package limits itself to 10 in-flight dynamic workers per DO (`developers.cloudflare.com/dynamic-workers/platform/limits/`). It is also the one place where the code contradicts a rule it wrote down for itself.

**Open question for the owner (do not guess):** does disposing the `WorkerStub` returned by `LOADER.get` evict the cached isolate? The docs say the cache is keyed by `id` and independent of stub liveness, which implies no — but they do not say it. Until that is probed, dispose only the **entrypoint stub and the result** (the two that provably pin), and leave the `WorkerStub` to GC.

**Size:** ~8 lines.

---

### F3 — HIGH · The DO constructor does durable work and starts an un-gated fan-out on every hibernation wake

**Where:** `src/iterate-context-durable-object.ts:157-176` (constructor) → `src/stream/stream.ts:127-203` (`Stream` constructor + `appendCreatedAndWokenEvents`) → `Stream.append:251` → `#onCommit` → `SubscriptionDelivery.onCommit` (`stream/subscription-delivery.ts:90`).

**What it does.** Every incarnation — and a hibernating DO with pagers has many — the constructor:

- opens two tables and writes `kv.put("incarnation", n)` (`stream.ts:135-153`);
- appends `stream/woken` as a **durable** event: one `transactionSync`, one `INSERT`, one high-water `kv.put`, one core-reduce checkpoint (`stream.ts:190-203`, `:334-373`);
- and, from inside that append, fires `SubscriptionDelivery.onCommit`, which evaluates every subscription's target — which can materialize facets, call `LOADER.get`, and dial rpc stubs — as **un-awaited, un-gated background work started in a constructor**.

**The docs.**

- Durable Objects — Use WebSockets: _"**Minimize work in the constructor when using hibernation**"_ (the constructor re-runs on every wake).
- Durable Object State: _"`blockConcurrencyWhile` is commonly used within the constructor of the Durable Object class to enforce initialization to occur before any requests are delivered."_
- Lifecycle: _"When an event arrives, the Durable Object is re-initialized and its `constructor` runs."_

**Two separable fixes, in order of value.**

**(a) Make the wake record ephemeral.** The package's own doctrine is that physical facts do not go in the log (`rpc-stub/attached` is ephemeral precisely so _"the log never claims a socket is open"_). An incarnation is the same kind of fact, and the durable counter already exists in `ctx.storage.kv` (`stream.ts:152`). Making it ephemeral removes the transaction, the row, the mark write and the checkpoint from every wake, while keeping the fan-out (ephemerals still ride `freshEvents`):

```ts
appendCreatedAndWokenEvents(): void {
  const born = this.#highestDurableOffset === 0;
  this.append(
    ...(born ? [{ type: "events.iterate.com/stream/created",
                 payload: { projectId: this.#projectId, path: this.#path } }] : []),
    // physical, like a socket: an incarnation is not log truth. The durable counter is kv.
    { type: "events.iterate.com/stream/woken", ephemeral: true,
      payload: { incarnation: this.#incarnation } },
  );
}
```

The core reduce would stop deriving `incarnation` (it reduces durables only, `stream.ts:394`); serve it from `#incarnation` in `coreReducedStateSnapshot()` instead — one line, and one duplication removed.

**Why it matters:** today a context that hibernates and wakes 10,000 times carries 10,000 permanent `stream/woken` rows that every version-bump re-reduce must re-scan, and pays a SQLite transaction per wake — on the exact path the whole pager design exists to make cheap.

**(b) Do not start the fan-out from the constructor.** Either defer it to the first door, or wrap the _synchronous_ init in `blockConcurrencyWhile`. **Important caveat:** do **not** put the fan-out inside `blockConcurrencyWhile` — a subscription target that is a facet reaches back through `env.ITX` → `ItxEntrypoint.fetch/get` → `getByName(this)` into _this same DO_, and `blockConcurrencyWhile` blocks all incoming events, so that is a self-deadlock. The safe shape is `blockConcurrencyWhile` around storage init only, with the fan-out left as today's fire-and-forget (which the platform supports: _"Durable Objects automatically remain active as long as there is ongoing work or pending I/O"_, DO State — `waitUntil`).

**Size:** (a) ~10 lines; (b) ~5 lines plus a decision.

---

### F4 — MEDIUM-HIGH · `env.ITX.get()` stubs are never disposed, on the SDK's per-append/per-read path

**Where:** `src/sdk/stream-processor-durable-object.ts:96-103` (and `:60`, `src/context/built-ins.ts:50`).

```ts
stream: {
  append: (...events) => this.env.ITX.get().append(...events),
  read: (after, limit) => this.env.ITX.get().read(after, limit),
},
```

**What it does.** Each call mints an `IterateContext` RpcTarget in the `ItxEntrypoint` worker and hands a stub back. The chain is correctly _pipelined_ (no `await` between `get()` and `.append()` — good, and deliberate). But nothing disposes the intermediate promise/stub, so per the lifecycle rule (_"if any stubs are passed… the execution context is implicitly extended until all such stubs are disposed"_) every append and every gap-repair page leaves one `ItxEntrypoint` execution context alive until GC. A processor catching up over a long log does this hundreds of times in a row.

**The idiomatic shape** — keeps the single round trip _and_ releases:

```ts
const withItx = async <T>(use: (itx: /* pipelined */ any) => Promise<T>): Promise<T> => {
  const itx = this.env.ITX.get(); // NOT awaited — the chain still pipelines
  try {
    return await use(itx);
  } finally {
    (itx as Partial<Disposable>)[Symbol.dispose]?.();
  }
};
// append: (...events) => withItx((itx) => itx.append(...events)),
// read:   (a, l)      => withItx((itx) => itx.read(a, l)),
```

(Disposing a `JsRpcPromise` is documented as equivalent to awaiting and disposing the result.)

The same applies to the `runScript` wrapper's `await this.env.ITX.get()` (`built-ins.ts:50`, inside generated userspace code) and to the doc comments that teach `const itx = await env.ITX.get()` — the taught idiom should be `using itx = await env.ITX.get()`, since that string is copied into every loaded worker anyone writes.

**Size:** ~10 lines in the SDK, plus a one-word doc change in three headers.

---

### F5 — MEDIUM · `armNoLaterThan` never consults `getAlarm()`, so a fresh incarnation can push a due alarm later

**Where:** `src/stream/stream.ts:546-562`.

```ts
armNoLaterThan(atMs: number): void {
  if (this.#alarmArmedForMs !== null && this.#alarmArmedForMs <= atMs) return;
  this.#alarmArmedForMs = atMs;
  void this.#storage.setAlarm(atMs);
}
```

`#alarmArmedForMs` is in-memory and starts `null` after every eviction. The docs are unambiguous that a `setAlarm` while one is scheduled **overwrites** it (_"If you call `setAlarm` when there is already one scheduled, it will override the existing alarm"_, Alarms). So: incarnation 1 arms a delivery retry at `now+5s` → the DO is evicted → incarnation 2's first arm is the 60 s quiet clock, memo is `null`, so it writes `setAlarm(now + 60s)` and the 5-second retry becomes a 60-second one. It self-heals (every `alarm()` pass re-derives and re-arms), but it is a silent latency inflation on exactly the retry ladder that exists to be prompt.

**Idiomatic:** the platform already exposes the reconciliation primitive, and the Alarms page even calls it out for constructor-adjacent arming (_"ensure that you are first checking whether an alarm has already been set"_):

```ts
async armNoLaterThan(atMs: number): Promise<void> {
  if (this.#alarmArmedForMs !== null && this.#alarmArmedForMs <= atMs) return;
  const scheduled = await this.#storage.getAlarm();          // null while an alarm is running
  if (scheduled !== null && scheduled <= atMs) { this.#alarmArmedForMs = scheduled; return; }
  this.#alarmArmedForMs = atMs;
  void this.#storage.setAlarm(atMs);
}
```

If keeping it synchronous matters (it is called from inside `transactionSync`-adjacent code paths), the cheaper fix is to seed `#alarmArmedForMs` once in the `Stream` constructor from `getAlarm()` — one read per incarnation instead of one per arm.

**Size:** ~6 lines.

---

### F6 — MEDIUM · Fetch-upgrade sockets are accepted unconditionally and never reaped

**Where:** `src/fetch/rpc-stub-fetch.ts:223-238`; reached from `iterate-context-durable-object.ts:573`.

```ts
acceptFetchUpgradeLeg(request: Request): Response | null {
  const upgradeId = request.headers.get(FETCH_UPGRADE_SOCKET_HEADER);
  if (upgradeId === null) return null;
  return this.#acceptUpgradeSocket("leg", upgradeId);      // no pending-id check
}
```

The DO's own comment at `:28` and `:563-565` says this door is _"gated on the pending upgradeId"_ — it is not (contrast `acceptRpcStubPagerWebSocket`, `rpc-stub-directory.ts:192-200`, which _is_ gated and 409s an unknown id). With trusted clients that is not a security hole, but it is a **resource** hole: a leg whose eyeball never materialises (a dial that threw between `host.fetch` and `serve`'s marker branch) leaves a hibernatable socket with no peer, no timeout and no reaper. Hibernatable sockets survive eviction by design and count against the documented **32,768 WebSockets per Durable Object** (DO State — `acceptWebSocket`).

**Idiomatic:** mirror the pager's two-phase reservation — `serve()` already mints the `upgradeId` (`:215`), so record it in a `Map` before dialling and delete it on accept; unknown → 409. And drop a peerless socket at the quiesce alarm (the DO already walks its sockets there):

```ts
// in serve(), before transport.fetch(...)
this.#pendingUpgradeIds.add(upgradeId);
// in acceptFetchUpgradeLeg
if (!this.#pendingUpgradeIds.delete(upgradeId))
  return new Response(`unknown fetch upgrade ${upgradeId}\n`, { status: 409 });
// in the DO's alarm(), beside the facet quiesce
for (const ws of this.#rpcStubFetch.peerlessUpgradeSockets()) ws.close(1000, "no peer");
```

**Size:** ~15 lines.

---

### F7 — MEDIUM-LOW · The `structuredClone` fallback returns the one result that actually pins

**Where:** `src/iterate-context-durable-object.ts:521-530`.

```ts
let copy: unknown;
try {
  copy = structuredClone(result);
} catch {
  return result;
} // ← undisposed
(result as Disposable)[Symbol.dispose]();
return copy;
```

`structuredClone` throws exactly when the result contains something non-cloneable — i.e. a **stub**, which is the only case where the disposer does real work (Kenton: _"If no actual disposal logic is needed, the disposer is an empty function"_). So the guard disposes every harmless result and skips every harmful one. The comment says such a value _"is the caller's to dispose"_, but the caller here is `walkSteps` → `invoke` → the Workers-RPC hop out; nothing on this side ever disposes it.

**Idiomatic:** either (a) accept it explicitly and say so — a stub-bearing facet answer legitimately must outlive the call, so the pin is the price of the capability; or (b) return the value wrapped so the edge session's teardown disposes it. If (a), fix the comment to say the value is _never_ disposed on this side, so the next reader does not assume a caller exists.

**Size:** 2 lines (comment) or ~15 lines (b).

---

### F8 — LOW · The manual close-echo is likely obsolete at this compatibility date

**Where:** `src/fetch/rpc-stub-fetch.ts:265-272`.

```ts
// Also complete the handshake on the socket that closed: workerd's hibernatable API does NOT
// auto-echo a peer-initiated close, so without this the initiator … hangs until its timeout.
try {
  ws.close(clampCloseCode(code), truncateCloseReason(reason));
} catch {}
```

That was true when it was written. The `web_socket_auto_reply_to_close` behaviour is **default-on for compatibility dates ≥ 2026-04-07** (documented on DO State under `getWebSockets`: the runtime completes the close handshake, which is why sockets leave `CLOSING` promptly). This worker's compat date is `2026-09-01` (`wrangler.jsonc:14`), so the runtime already echoes. The call is harmless (wrapped in try/catch) but it is dead code with a now-false comment — the kind of thing that outlives its reason and gets copied.

**Action:** delete the echo and the comment; keep the peer close. Pin it with the existing `ws-fetch-live-101` test.
**Size:** −8 lines.

---

### F9 — LOW · Loaded isolates get a hardcoded "today" compatibility date

**Where:** `src/context/worker-loader.ts:146` — `compatibilityDate: "2026-09-01"`.

Every dynamically loaded worker in the system runs under a literal that happens to equal the day the line was written, and it is the same literal as the _platform_ worker's. Whoever bumps `wrangler.jsonc` will bump this too, silently changing runtime semantics for **every piece of userspace code already deployed**, with no way for an author to pin. It is invisible in the cacheKey as well — safe only because `CF_VERSION_METADATA.id` is in the key and changes on every deploy.

**Idiomatic:** treat the compat date as part of the source spec (`{ source, cacheKey?, className?, compatibilityDate? }`, defaulting to a named constant), and if it ever becomes per-source, fold it into the cacheKey explicitly rather than relying on the deploy id.
**Size:** ~6 lines; mostly a decision.

---

### F10 — LOW · nits worth one line each

| #   | Where                                                  | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | `src/context/rpc-stub-directory.ts:119`                | `input.stub.dup?.() ?? input.stub` — the fallback retains a **param** stub past the call, which the docs say is auto-disposed on return; every later use would throw. Real Workers-RPC stubs always have `dup`, so this only ever fires for a test double. Make it `input.stub.dup()` and let a non-stub fail loudly at the door (the edge already does exactly this at `rpc-stub-relay.ts:131`, with a comment explaining why).                                                                                                 |
| b   | `src/worker.ts:20-23`                                  | The `cloudflare:workers` cast to reach `RpcPromise`/`RpcProperty` is a genuine `workers-types` gap, and `__workers-tests__/rpc-pipelining.test.ts` already fails loudly if the exports move — good. The residual gap is that a silent loss of the brands degrades to _extra round trips_, not an error, so it is only caught when that lane runs. A 3-line boot assertion (`if (typeof NativeRpcPromise !== "function") throw …`) turns it into a deploy-time failure.                                                           |
| c   | `src/context/built-ins.ts:224-227`, `worker-loader.ts` | `getEntrypoint` / `getDurableObjectClass` accept `{ props, limits }` (`limits: { cpuMs, subRequests }`, per workerd `worker-loader.h`; undocumented on the API-reference page). `limits` is deliberately unused ("trusted clients", `worker-loader.ts:143`). Worth recording as a _known available lever_ rather than an omission: a runaway loaded facet currently burns the parent DO's budget until the 60 s watchdog at `iterate-context-durable-object.ts:502`.                                                             |
| d   | `src/iterate-context-durable-object.ts:374`, `:389`    | The 60 s quiet clock sits inside the documented eviction window (hibernatable → hibernated after **10 s**; non-hibernatable → evicted after **70–140 s**, Lifecycle). So a context that ran one facet call stays non-hibernatable for ~60 s of the ~70 s budget. That is a deliberate re-materialisation trade, but it is worth measuring against a 15–20 s clock now that the numbers are documented rather than inferred.                                                                                                      |
| e   | `src/context/worker-loader.ts:93-95`                   | The "a loaded isolate captures the minting host's `env.ITX`… can die with the host's incarnation" worry may already be solved by the platform: `ctx.exports` stubs are the **persistent** kind (that is what `allow_irrevocable_stub_storage` buys, and `load-persistent-stub.e2e` pins it), so they are restorable rather than incarnation-bound. The deploy component in the cacheKey is still required for the facet-stub-transfer reason; the `env.ITX` staleness reason may not be. One probe would let the comment shrink. |

---

## Justified divergences — do not re-litigate

Each of these looked wrong on first read and turned out to be right; the reasoning is already written down in the source.

1. **One door per host kind** — `itx.workers.get({source, className?})` / `itx.facets.get(name, {source, className})` instead of Cloudflare's `load()` → `getEntrypoint()` two-step. Both still bottom out in `LOADER.get` + `getEntrypoint`/`getDurableObjectClass`; the intermediate handle had exactly one legal next step. `built-ins.ts:8-19`, `worker-loader.ts:25-31`.
2. **The cacheKey-gated producer.** A producer _expression_ source is refused without an explicit `cacheKey`, quoting Cloudflare's own contract (_"the callback could be called any number of times"_, _"if anything about the content changes, you must use a new ID"_). Hashing the expression would be the stale-code trap. `worker-loader.ts:8-17`, `:120-131`.
3. **cacheKey composition `kind:deploy:owner:sourceVersion`, with a length-prefixed owner.** Low-cardinality by rule ("THE cacheKey IS A DOLLAR AMOUNT" — the apps/os nonce incident), deploy-scoped because a facet built from a prior deployment's isolate cannot be called from the new parent, and length-prefixed because the naive `${context}:${discriminator}` aliased across a different split into a _shared_ key — a silent cross-context authority transfer. `worker-loader.ts:36-44`, `:88-99`.
4. **`env: { ITX: ctx.exports.ItxEntrypoint({ props }) }` and `globalOutbound` the same stub.** The docs permit ordinary service bindings in a loaded `env` too; restricting to `ctx.exports` is _stricter_ than required and is the right stricter — it is the only route that can carry per-sandbox `ctx.props` and the only stub kind that may be persisted. `itx-entrypoint.ts:1-10`, `worker-loader.ts:157-158`.
5. **The `x-itx-expression` fetch lane and the whole `WORKAROUND` fence.** Workers RPC cannot serialize a webSocket-bearing Response; only the fetch channel tunnels sockets, which Kenton has stated directly (workerd#2319: _"Using `fetch()` is the appropriate work-around until then"_). The fence carries a line-item DELETE-DAY checklist. `fetch/rpc-stub-fetch.ts:20-31`, `:63-93`.
6. **The prototype hop instead of a Proxy around the instance.** workerd's pipeline classifier brand-checks a call's result and a JS `Proxy` never classifies as pipelinable (workerd#6873); a real `RpcTarget` does on both hops. Note this is _specifically_ about pipelining — since workerd#3212 a Proxy whose prototype chain reaches `RpcTarget.prototype` **does** serialize fine, so the comment's scope ("classifies a call's RESULT for promise pipelining") is exactly right and should not be broadened. `dotted-path-proxy.ts:103-140`.
7. **`Reflect.apply(fn, receiver, args)`, never `stub[m].apply(...)`.** Reading `.apply` off an RPC stub's method proxy is itself a pipelined remote path; calling it passes the stub as an argument, and a Worker-Loader facet stub may never be serialized (`requireAllowsTransfer()` throws unconditionally). Verified gone everywhere in `src/` — the only `.apply(` hits are `Reflect.apply` and one client-side store method. `dispatch.ts:32-42`, `:74`, `:88`; `built-ins.ts:231`.
8. **capnweb terminates only in the stateless worker; the DO speaks pure Workers RPC.** Kenton's own recorded topology, and the reason the DO can hibernate with any number of clients attached. The lend/borrow + pager layer is the consequence, and workerd#6087's _own_ suggested workaround is a stateless proxy worker — i.e. this design. `worker.ts:54-56`, `iterate-context.ts:37-42`.
9. **Holding borrowed stubs across incoming requests in the DO.** Legal: an actor has one `IoContext` spanning its incarnation (`research/kentonv/a-runtime-isolates.md`, workerd `io-context.h`), and `dup()` is applied at the one place a param stub is retained, exactly as the docs require. The stubs are returned at the quiesce precisely because holding one keeps the DO non-hibernatable. `rpc-stub-directory.ts:116-129`, `:171-178`.
10. **`setWebSocketAutoResponse` once in the constructor, with a deliberately distinctive literal.** Documented as DO-wide (not per-socket) and documented as answering _"without waking WebSockets in hibernation and incurring billable duration charges"_ — which is the whole point. Workers' `WebSocket` API cannot send protocol-level ping frames, so an in-band keepalive is the only option and this API is its intended partner. The DO-wide collision with tunnelled eyeball traffic is inherent (there is no per-socket auto-response); the distinctive literal is the correct mitigation and `ws-fetch-live-101` pins the incident that produced it. `iterate-context-durable-object.ts:159-170`, `rpc-stub-directory.ts:40-45`.
11. **`ctx.storage.kv` alongside `ctx.storage.sql`.** `kv.get/put/delete/list` is a documented public API on SQLite-backed DOs ("Synchronous KV API", SQLite-backed Durable Object Storage) and is the right tool for the marks, memos and cursors. `stream.ts`, `subscription-delivery.ts`.
12. **Prototype getters instead of instance fields on every wire-visible class.** Matches the documented visibility rule verbatim (_"the recipient can only access methods and properties declared on the class, not properties of the instance"_). `session.ts:89-93`, `iterate-context.ts:99-101`.
13. **Declarative `exports: { IterateContextDurableObject: { type: "durable-object", storage: "sqlite" } }` with no `migrations` array**, `version_metadata`, `worker_loaders`, `observability`. This is the current-generation wrangler shape; `wrangler.test.jsonc` and `e2e/support/solo-config.ts` re-derive from it rather than forking it, which is the right way to keep one deploy truth.
14. **Threading pipelinable promises unawaited through the step walk** (`dispatch.ts:51-56`) — this is the documented mechanism (_"you can simply omit the first `await`… multiple chained calls can be completed in a single round trip"_), and awaiting mid-chain is precisely what would break it.
15. **No `alarm()` on the processor host** (`sdk/stream-processor-durable-object.ts:26`) — facets have no alarms (workerd#6810; the failure is asynchronous and poisons the actor), so the parent owns the retry ladder. Correct, and correctly commented.
16. **Error codes as own enumerable properties, never `name`/`instanceof`** (`lib/errors.ts`). Matches the documented tunnelling behaviour and Kenton's stated position that RPC should not special-case exceptions; honouring workerd's own stamped `retryable` flag (`subscription-delivery.ts:353`) instead of inventing a taxonomy is exactly right.
17. **`newWorkersRpcResponse` serving both the WS upgrade and the one-shot HTTP batch from one route** (`worker.ts:57-62`), with the honest note that a batch session cannot hold live capabilities.

---

## What I checked and found clean

- No `.apply` on any stub anywhere in `src/` (only `Reflect.apply`) — the known trap is gone.
- No `blockConcurrencyWhile` misuse (it is simply absent; see F3 for where it would help and where it would deadlock).
- `getWebSockets` results are filtered to `readyState === OPEN` before use (`rpc-stub-directory.ts:276-280`), which the docs call out as necessary since `CLOSING` sockets are still returned.
- Attachments are small and stamped in the same synchronous turn as `acceptWebSocket` (well under the documented 16,384-byte cap); tags are one per socket, ~52 characters (caps: 10 tags, 256 chars).
- `withTimeout` clears its timer on every exit (`lib/timeout.ts:19-21`) — a leaked timer would keep a DO non-hibernatable, and the comment says so.
- The close-reason truncation is by **encoded bytes**, not UTF-16 length, and close codes are clamped — both match workerd's actual enforcement (`rpc-stub-fetch.ts:113-130`).
- KV `list()` drains the cursor rather than trusting one 1000-key page (`built-ins.ts:251-264`).
- `alarm()` cannot throw (every branch catches), so it never enters the documented at-least-once retry ladder by accident.
- `ctx.waitUntil` is used only on the **stateless** side (`session.ts:59`, `itx-entrypoint.ts:32`), never in the DO — correct, since it is documented as a no-op there.

---

### Source notes

Cloudflare docs relied on: Workers RPC — _Lifetimes, Memory and Resource Management_ and _Visibility and Security Model_; Durable Objects — _State_, _Alarms_, _Use WebSockets_, _Lifecycle_, _Rules of Durable Objects_, _SQLite-backed Storage_, _Limits_; Dynamic Workers — _API reference_, _Durable Object Facets_, _Bindings_, _Limits_; Workers — _Context (ctx)_. Three things asserted above come from workerd source or this repo's own harvested primary sources rather than docs, and are marked as such: the per-actor `IoContext` rule (`research/kentonv/a-runtime-isolates.md`), `{ props, limits }` on `getEntrypoint`/`getDurableObjectClass` (`worker-loader.h`), and the Proxy-serialization change in workerd#3212. No Cloudflare doc endorses copy-before-dispose of RPC results — F2/F7 rest on the lifecycle rule plus this package's own recorded incident, not on a documented rule.
