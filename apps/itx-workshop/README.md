# itx-workshop-repro

A small, runnable reproduction that **empirically tests the claims in the itx
workshop** (`itx-explainer.md`) against real Cloudflare workerd + real Cap'n Web
clients. Every step from the workshop is exercised by a Node client over a real
WebSocket to a `wrangler dev` Worker + Durable Object.

## Run it

```bash
pnpm install
npm run dev          # terminal 1: wrangler dev (real workerd) on :8787
npm test             # terminal 2: the Node client harness, prints PASS/FAIL per step
```

`npm test` **requires a real Swift toolchain** — Steps 1 and 4 run Swift-only
code the JS fallback cannot fake (see below). On macOS, `swift --version` should
work.

```bash
npm run proof:swift  # proves Swift actually RUNS (not just type-checks):
                     #   1. swiftc -typecheck dialog.swift            -> typecheck OK
                     #   2. echo 'print((2...7).reduce(1,*))' | swift - -> 5040
                     #   3. ITX_DIALOG_AUTODISMISS=Aurora swift dialog.swift
                     #      -> Aurora  (the REAL AppKit NSAlert modal loop runs
                     #         headless: presets the field, runs runModal(),
                     #         auto-dismisses, prints the value)
```

Model-level checks (pure Node, no workerd):

```bash
npm run validate:streamprocessor  # Steps 8 & 11: Itx extends the REAL
                                  # @iterate-com/streams StreamProcessor, folding a
                                  # durable event log (provide→fold→invoke, revoke,
                                  # replay-rebuilds-the-table, root caps just provided)
node validate-steps.mjs           # Steps 7–10: live/sturdy, dial, chain
```

## What it proves (7/7 PASS, all against real workerd)

| Step     | Claim                                                                                                                                   | Result                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0        | Worker serves an `RpcTarget`; client `newWebSocketRpcSession` + `using` disposal                                                        | **PASS**                                   |
| 1        | The **server calls the client**: client passes `{ runSwift }`, server calls it back; the laptop runs **real Swift**                     | **PASS** (`(1...10).reduce(0,+)` → `55\n`) |
| 2/3/4    | `provideCapability`/`invoke` registry in a Durable Object; **client B invokes a method living on client A** — and A runs **real Swift** | **PASS** (`B → A.runSwift → "5040\n"`)     |
| 3        | unknown capability rejects                                                                                                              | **PASS**                                   |
| 5        | **naked-stub method call**: `itx.runSwift(code)` on the bare session stub routes (via the server-side dynamic proxy) to `invoke`        | **PASS**                                   |
| 6        | **deep path into the real `@slack/web-api` SDK** from a **naked stub**: `itx.slack.chat.postMessage(msg)` → one pipelined message       | **PASS** (real SDK hits the mock endpoint) |
| 6 shadow | **longest-prefix deep shadow**: override `slack.chat.postMessage`; `slack.users.list` still resolves to the real mounted client         | **PASS**                                   |

## There is no client-side path proxy — and there shouldn't be

This is the load-bearing correction over the first draft. A **naked Cap'n Web
stub already turns `stub.a.b.c(args)` into ONE pipelined message** — `core.ts`'s
`RpcStub` proxy accumulates the property path locally (`get` →
`RpcPromise(hook, [...path, prop])`, zero round trips) and `apply` sends
`["push",["pipeline", id, ["a","b","c"], [args]]]`. The client IS the proxy. So
`client-lib.ts` is one function — `connect()`, a socket opener — and nothing
else. Production matches this: the browser, Node `withItx`, the REPL, and loaded
isolates all hold a _remote_ `newWebSocketRpcSession<ItxHandle>` stub and
pipeline natively. There is no consumer-side path proxy anywhere.

The harness proves this directly: every Step-2-onward call is made on a bare
`connect<any>(...)` stub — including `itx.slack.chat.postMessage(...)` — over
real workerd, with no client library in between.

### The genuinely hard part is the SERVER-side dynamic proxy

Capabilities are registered at **runtime** (`provideCapability`) and change over
the life of a context — so the server target cannot be a class with fixed
getters/methods. It must be a dynamic proxy that answers names it has never heard
of and collapses the accumulated path into one `invoke(path, args)` against the
live registry. `server.ts`'s `dynamicHandle` is exactly this; `min-dynamic-target.mjs`
is the same thing in ~30 self-contained lines (run it). Three gotchas it encodes,
each a real debugging round:

1. **Make the target FUNCTION-typed, not a Proxy over an `RpcTarget`.** Cap'n Web
   classifies an rpc-target by prototype and rejects fabricated "instance
   properties". A function-typed target is traversed via `Object.hasOwn`, where
   fabricated own properties are allowed.
2. **`getOwnPropertyDescriptor` is load-bearing, not just `get`.** Server-side
   Cap'n Web does `Object.hasOwn(value, segment)` BEFORE `value[segment]`; without
   the descriptor trap every segment reads as absent and the chain dies at
   ".chat of undefined". This single missing trap was the entire reason an earlier
   draft mistakenly concluded server-side path pipelining "doesn't work" over
   workerd. It does — the trap just has to be there.
3. **Retain (`dup`) provided live stubs**, Cap'n Web disposes argument stubs when
   the provide call returns.

## The real Slack SDK, mounted as one capability

Step 6 mounts the official `@slack/web-api` `WebClient` as a single capability.
The WebClient lives in the Node client (the "laptop"); we point it at a local
mock Slack endpoint (`slackApiUrl`) so it returns without a live workspace, but
the call goes through the SDK's **real** request path (signing, body encoding,
HTTP) — the mock records that `chat.postMessage` was actually hit, and the
response carries real `@slack/web-api` fields (`response_metadata`). Cap'n Web
deep-copies a plain provider object and turns its function members into stubs
that call back into the laptop where the real client lives, so the SDK's real
methods execute. (Cap'n Web can't serialize a whole live `WebClient` instance by
value, so the provider exposes the methods it mounts; they ARE the SDK's real
`chat.postMessage` / `users.list`.)

## The non-obvious bits the cross-client rendezvous needs (Step 2/4)

The live cross-client rendezvous does **not** work as the MVP step code is
written. Making it real — _with the WebSocket terminated in the stateless Worker,
not the DO_ — needs three things, all in `server.ts`:

1. **The Worker serves a local Cap'n Web handle** (`WorkerHandle`, wrapped by
   `dynamicHandle`) that forwards the verbs to the DO — not the raw Workers-RPC DO
   stub. Re-exporting a Workers-RPC stub over Cap'n Web tangles the two
   stub-lifetime systems.
2. **`dup()` the provided stub at the Worker layer** before forwarding it to the
   DO. Cap'n Web disposes an argument stub when the `provide` call returns;
   without `dup()` the DO's re-exported copy is dead by the time another client
   calls it (`RpcImportHook was already disposed`).
3. **`ctx.waitUntil` keeps the provider's Worker invocation alive** for the
   socket's lifetime. Otherwise, the moment client A's `fetch` returns, the
   Worker→DO connection carrying A's live stub is torn down and a later
   cross-client call dies with _"the execution context which hosts this callback
   is no longer running."_

And `replayPath` calls the terminal method **on its receiver**
(`receiver[last](...args)`), not detached-`.apply()` — a retained Cap'n Web member
is a stub whose `.apply` is a path segment, not a function.

## Files

- `server.ts` — the Worker + `ItxDO` Durable Object + the `Itx` core + the single
  server-side `dynamicHandle` (the descriptor-trap dynamic proxy). One endpoint
  (`/itx`) per shared registry.
- `client-lib.ts` — `connect()` (a one-line socket opener) and `sleep()`. No path
  proxy; the naked stub is the client.
- `min-dynamic-target.mjs` — the server-side dynamic proxy in isolation, in-process.
- `run-swift.ts` — `swift -` runner.
- `dialog.swift` — the native-macOS-dialog program from Step 1. It **really
  runs**: `ITX_DIALOG_AUTODISMISS=Aurora swift dialog.swift` executes the actual
  AppKit `NSAlert` modal loop (presets the field, runs `runModal()`,
  auto-dismisses, prints the value); plain `swift dialog.swift` is the
  interactive human version; `swiftc -typecheck dialog.swift` type-checks it.
  See `npm run proof:swift`.
- `harness.ts` — the Node client that drives every step (naked stubs) and prints
  the table; mounts the real `@slack/web-api` client against a local mock.
- `itx-contract.ts` — the itx event log defined as a real `defineProcessorContract`
  (`@iterate-com/streams`): the `events.iterate.com/itx/*` event schemas + plain-object
  state. Step 8's "it's just a durable event log."
- `itx-processor.ts` — `Itx extends StreamProcessor<ItxContract>`, the REAL base class:
  one pure `reduce` (the fold), the verbs, the in-memory live-stub bridge. Step 11.
- `validate-streamprocessor.ts` — drives the real `Itx` processor in-process: provide →
  fold → invoke, deep shadow, revoke, and replay-rebuilds-the-table. Root caps are just
  provided (no built-in handle).
- `validate-steps.mjs` — pure-Node model checks for steps 7–10 (live/sturdy, ref
  taxonomy, dial, chain).
