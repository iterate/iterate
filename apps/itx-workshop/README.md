# itx-workshop-repro

A small, runnable reproduction that **empirically tests the claims in the itx
workshop** (`apps/os/docs/itx-explainer.html`) against real Cloudflare
workerd + real Cap'n Web clients. Every step from the workshop is exercised by
a Node client over a real WebSocket to a `wrangler dev` Worker + Durable Object.

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

## OPEN QUESTION (under active investigation)

Step 6a's "server-side nested property pipelining does NOT work" conclusion is
**suspect**. capnweb's `rpc.ts` clearly _does_ accumulate a property path on a
stub (`RpcImportHook.collectPath` / `get(path)`) and pipeline the whole thing as
one call (`sendCall(id, ["pipeline", id, path])`). So a naked capnweb stub of a
server-side target with nested members may already support `stub.a.b.c(args)`
natively — meaning the consumer-side `PathProxy` could be **unnecessary**. The
6a failure here may just be a malformed server target (a bare `Proxy` missing
the `getOwnPropertyDescriptor`/`has` traps that production's `PathProxy` carries
for RPC traversal). This is being re-tested; treat the "PathProxy is required"
claim below as provisional until confirmed.

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
