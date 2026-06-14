# itx-workshop-repro

A small, runnable reproduction that **empirically tests the claims in the itx
workshop** (`itx-explainer.md`) against real Cloudflare workerd + real Cap'n Web
clients. Every step from the workshop is exercised by a Node client over a real
WebSocket to a `wrangler dev` Worker + Durable Object.

## Run it

```bash
npm install
npm run dev          # terminal 1: wrangler dev (real workerd) on :8787
npm test             # terminal 2: the Node client harness, prints PASS/FAIL per step
```

(`runSwift` shells out to `swift -`, reading the program from stdin. If the
Swift toolchain isn't installed the harness still runs — only Step 1's output
value differs.)

## What it proves (8/8 PASS)

| Step | Claim                                                                                                                                      | Result                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 0    | Worker serves an `RpcTarget`; client `newWebSocketRpcSession` + `using` disposal                                                           | **PASS**                                   |
| 1    | The **server calls the client**: client passes `{ runSwift }`, server calls it back over the socket                                        | **PASS** (`swift -` runs, returns `2\n`)   |
| 2/4  | `provideCapability`/`invoke` registry in a Durable Object; **two clients rendezvous** — client B invokes a live function client A provided | **PASS** (`B.invoke("runSwift") → "42\n"`) |
| 3    | unknown capability rejects                                                                                                                 | **PASS**                                   |
| 5    | **server-side `Proxy` get-trap**: `itx.runSwift(code)` → `invoke`                                                                          | **PASS**                                   |
| 6a   | server-side **nested** property pipelining (`itx.slack.chat.postMessage`) — the doc claims this does NOT work over workerd                 | **PASS** (it throws — confirmed)           |
| 6b   | **consumer-side `PathProxy`** → one `invoke(path,args)`; deep typed SDK call                                                               | **PASS**                                   |
| 6c   | **longest-prefix deep shadow** — override `slack.chat.postMessage`, `slack.users.list` falls through                                       | **PASS**                                   |

## RESOLVED: there is no client-side path proxy — and there shouldn't be

The earlier Step 6a verdict ("server-side nested pipelining does NOT work →
client needs a PathProxy") was a **false negative**. Verified five ways (Node
in-process wire taps, two workerd `wrangler dev` probes, a capnweb-source read,
and a trace of the production code) plus `min-dynamic-target.mjs` here:

- **A naked capnweb stub already turns `stub.a.b.c(args)` into ONE pipelined
  message.** `core.ts`'s `RpcStub` proxy accumulates the property path locally
  (`get` → `RpcPromise(hook, [...path, prop])`, zero round trips) and `apply`
  sends `["push",["pipeline", id, ["a","b","c"], [args]]]`. The client IS the
  proxy. A hand-rolled consumer-side path proxy reimplements this for nothing.
- **Production already does the right thing.** The browser, Node `withItx`, the
  REPL, and loaded isolates all hold a _remote_ `newWebSocketRpcSession<ItxHandle>`
  stub and pipeline natively — there is **no `new PathProxy` on any consumer**.
  The `PathProxy` in `apps/os/src/itx/path-proxy.ts` runs **server-side**, inside
  `ItxHandle`, on behalf of the remote stub. ("consumer side" in its header means
  the consumer-facing half of the calling convention, not where it executes —
  that's terminology gunk worth fixing.)

### The genuinely hard part (why a server-side dynamic proxy is unavoidable)

Capabilities are registered at **runtime** (`provideCapability`) and change over
the life of a context — so the server target cannot be a class with fixed
getters/methods (that only works if you know every cap name a-priori, which you
don't). It must be a dynamic proxy that answers names it has never heard of and
collapses the accumulated path into one `invoke(path, args)` against the live
registry. `min-dynamic-target.mjs` is the minimum version (run it: it does
runtime provide, deep dotted calls, longest-prefix shadow, unknown-rejects).
Three gotchas it encodes, each a real debugging round:

1. **Make the target FUNCTION-typed, not a Proxy over an `RpcTarget`.** capnweb
   classifies an rpc-target by prototype and rejects fabricated "instance
   properties" — so a descriptor trap inventing dynamic names is refused (it even
   flagged the real `provideCapability`). A function-typed target is traversed
   via `Object.hasOwn`, where fabricated own properties are allowed.
2. **`getOwnPropertyDescriptor` is load-bearing, not just `get`.** Server-side
   capnweb does `Object.hasOwn(value, segment)` BEFORE `value[segment]`; without
   the descriptor trap every segment reads as absent and the chain dies at
   ".chat of undefined". This — the single missing trap — is the entire reason
   the original 6a "failed".
3. **Retain (`dup`) provided live stubs**, capnweb disposes argument stubs when
   the provide call returns.

### Where the server-side proxy is genuinely required vs merely sugar

- **Required:** `itx.project.*` and `itx.super.*` — those surfaces are **Workers
  RPC** stubs (a DO stub; an async-dialed parent), and Workers RPC does _not_
  pipeline through property accesses, so `replayPathCall` is what makes
  `await itx.project.processor.snapshot()` work in one expression. Also the
  security gates (blocking `itx*`/`fetch` on the project surface) live here.
- **Mostly sugar:** the `capability()` fallthrough — its pipelining duplicates
  capnweb's, and its reserved-name filter is re-enforced authoritatively in
  `replayPathCall`. It earns its keep as ergonomics + defense-in-depth, not
  correctness.

The 8/8 table below still runs green; it's kept as the empirical record, but read
"6a throws → confirmed doesn't work" as the false negative it was.

## The non-obvious bits the workshop glosses (now load-bearing here)

The cross-client live-capability rendezvous (Step 2/4) does **not** work as the
MVP step code is written. Making it real — _with the WebSocket terminated in the
stateless Worker, not the DO_ — needs three things, all in `server.ts`:

1. **The Worker serves a local capnweb handle** (`WorkerHandle`) that forwards
   the four verbs to the DO — not the raw Workers-RPC DO stub. Re-exporting a
   Workers-RPC stub over capnweb tangles the two stub-lifetime systems.
2. **`dup()` the provided stub at the Worker layer** before forwarding it to the
   DO. capnweb disposes an argument stub when the `provide` call returns; without
   `dup()` the DO's re-exported copy is dead by the time another client calls it
   (`RpcImportHook was already disposed`). This is the workshop's
   `retainLiveProvider` addendum — but the _step_ code omits it.
3. **`ctx.waitUntil` keeps the provider's Worker invocation alive** for the
   socket's lifetime. Otherwise, the moment client A's `fetch` returns, the
   Worker→DO connection carrying A's live stub is torn down and a later
   cross-client call dies with _"the execution context which hosts this callback
   is no longer running."_

And `replayPath` must call the terminal method **on its receiver**
(`receiver[last](...args)`), not detached-`.apply()` — a retained capnweb member
is a stub whose `.apply` is a path segment, not a function.

Net: the workshop's narrative is correct, and the "live caps work across clients
with the WS in the stateless Worker" design holds — but the live-stub lifetime
machinery (dup-at-the-Worker-layer + waitUntil + local handle) is real and
belongs in the doc's addendum, not hand-waved.

## Files

- `server.ts` — the Worker + `ItxDO` Durable Object + the `Itx` core, one endpoint per step.
- `client-lib.ts` — `connect()` and the consumer-side `pathProxy()`.
- `run-swift.ts` — `swift -` runner (graceful fallback if Swift absent).
- `harness.ts` — the Node client that drives every step and prints the table.
