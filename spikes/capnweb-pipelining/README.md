# Spike — capnweb pipelining through a capability host (2026-08-03)

**Side-quest from** `apps/os/docs/simplification/wayfinder/jam-capability-provision.md` (§6 / bookmark).

## The question

The jam claimed a "physics ceiling": that a JS `Proxy` can't be promise-pipelined
(workerd's `serializeJsValueWithPipeline` brand check, `cloudflare/workerd#6873`), so hot
built-ins must stay real getters and "everything is a capability" can't be literal. **Jonas
doubted it** — he recalled proxies pipelining fine when `RpcTarget` is on the prototype chain.

So: build the minimal thing and measure. Can a capability host with **one `invokeCapability`
fallback** let a consumer pipeline `itx.streams.get("/x").helloWorld()` in **one** round trip
consumer→hub **and** one hub→provider — and does a **Proxy** resolver break that?

## Setup

Three parties in ONE Node process, wired by an instrumented in-memory capnweb transport
(`inproc.mjs`) that counts every frame and adds per-hop latency:

```
client B ──wireB── hub (CapabilityHost) ──wireA── client A (StreamsCollection)
consumer            provideCapability + invokeCapability          provider
```

A "round trip" = a side **blocking for a reply** = a `pull` frame it emits.

```bash
node spike.mjs            # self-verifying, exits non-zero on failure
LOG=1 HOP=25 node spike.mjs   # print every frame; 25ms/hop latency
```

## Results (all ✅)

| scenario                                                                | B→hub RTT | hub→A RTT | notes                                                             |
| ----------------------------------------------------------------------- | --------- | --------- | ----------------------------------------------------------------- |
| **1** — `hub.streams` real getter → provider stub                       | **1**     | **1**     | native pipelining through a returned stub                         |
| **2** — `hub.invokeCapability("streams").get(x).helloWorld()`           | **1**     | **1**     | single fallback returns the root stub; capnweb pipelines the rest |
| **3** — **Proxy** hub, unknown `.streams` → single fallback (ergonomic) | **1**     | **1**     | **the doubted case — works**                                      |
| **4** — provider `get()` returns a **Proxy**-wrapped `RpcTarget`        | **1**     | **1**     | proxy passed by reference (RpcTarget on prototype chain)          |
| contrast — NAIVE `await` at every step                                  | 3         | 2         | what NOT to do; ~10 hops wall vs ~4                               |

Wall time for the pipelined cases ≈ **4 one-way hops** (B→hub→A→hub→B) — the optimal 3-party
relay. The naive version is ~10 hops.

## Verdict

1. **A single `invokeCapability` fallback pipelines 1+1.** The fallback returns the provider
   _root_ stub; capnweb's promise pipelining chains `.get(x).helloWorld()` onto it in one hop
   (Tests 2, 3). You do **not** need to flatten the whole path into one call to get one round trip.
2. **A `Proxy` dynamic resolver pipelines fine over capnweb** (Test 3). capnweb's own stubs _are_
   `Proxy`s; evaluating an incoming pipelined expression against a `Proxy` localMain just works.
3. **Returning a `Proxy` with `RpcTarget` on its prototype chain is passed by reference and
   pipelines** (Test 4). Jonas was right; the blanket "a Proxy can never be pipelined" was wrong
   for the capnweb path.

**So the §6 "physics ceiling" does NOT apply to the capnweb-over-WebSocket path** — which is the
client-facing path (`client B → /api`). "Everything is a capability, resolved through one
fallback" is viable there with full pipelining.

## The one real caveat (untested here)

The `workerd#6873` brand check is a **native Workers-RPC** concern — it governs values crossing a
**DO stub / service binding / `ctx.exports` loopback**, not capnweb-over-WebSocket. This spike is
pure Node capnweb; it does **not** exercise a native boundary.

The safe rule that satisfies _both_ transports (and is what `apps/os`'s
`installPrototypeInvokeCapabilityFallback` already does in production): **across a native boundary,
return a real `RpcTarget` instance and put the dynamic-resolution `Proxy` on its _prototype_.**
Then unknown-property resolution happens _in-isolate during expression evaluation_ (server side),
and no bare `Proxy` value ever crosses the native wire — so the brand check is never triggered.
A follow-up spike under `workerd`/miniflare with a real DO would confirm the native leg.

## Gotchas found (real, worth remembering)

- **`.dup()` provided stubs.** Stubs passed as call params are disposed when the call returns
  (capnweb README §Automatic disposal). `provideCapability` must `this.#caps.set(name, stub.dup())`
  or the provider handle dies immediately; likewise return `.dup()` from `invokeCapability`.
- **Bind real methods to the real target in the Proxy hop.** A `Proxy` is not the instance, so
  `this.#privateField` throws inside a method invoked with `this = proxy`. In the `get` trap,
  `Reflect.get(target, prop, target)` + `.bind(target)` for functions keeps private fields working.
- **`has() => true`** on the Proxy makes any capability name appear present (prototype-like, not an
  own property), which is what capnweb's property-access check wants.

## Files

- `spike.mjs` — the 5 scenarios + pass/fail assertions.
- `inproc.mjs` — the instrumented in-memory transport (frame counting + latency).
- `node_modules/capnweb` — symlink to the repo's `@iterate-com/capnweb@0.10.0`.
