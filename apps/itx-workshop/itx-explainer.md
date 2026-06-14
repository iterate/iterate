# itx, derived from a bare socket

A coding-workshop derivation of **itx** — Iterate's capability layer — built up from a single Cap'n Web socket, one motivated step at a time. The inner core is a few hundred lines and tells one story; everything else is an addendum of layered complexity, each entry the concrete failure it buys you out of.

> **runnable & verified** — Every step is exercised by runnable code in this folder. Steps 0–6 (the wire-level half) run against real `workerd` and real Cap'n Web clients (`server.ts` + `harness.ts`, and the self-contained `min-dynamic-target.mjs`). Steps 7–11 (the model-level half — fold, ref taxonomy, dial, chain, processor) are checked by `validate-steps.mjs`. The Step 1 dialog Swift is type-checked with `swiftc`. Where the first draft guessed wrong, the repro corrected it — most notably: **there is no client-side path proxy**, because a naked Cap'n Web stub already pipelines a whole dotted path into one call (see Step 6).

---

## Step 0 — A method call over a socket

> **the start** — itx is, at the bottom, a Cap'n Web session over a WebSocket. The client gets a typed stub; calling a method on it calls the method on the server.

Server — a Cloudflare Worker, one line to answer the socket:

```ts
import { RpcTarget, newWorkersRpcResponse } from "capnweb";

class Server extends RpcTarget {
  greet(person: string) {
    return `hello, ${person}`;
  }
}

export default {
  fetch: (request) => newWorkersRpcResponse(request, new Server()),
};
```

Client — connect, call, dispose:

```ts
using itx = newWebSocketRpcSession<Server>(socket);
await itx.greet("ada"); // → "hello, ada"
// `using` disposes the session at end of scope
```

That's the whole primitive. Everything below is making this **bidirectional, dynamic, shared, durable, and nameable**.

---

## Step 1 — The server calls the client

> **the cool thing about Cap'n Web** — stubs pass _as arguments, in either direction_. So the client can hand the server a live object and the **server** calls methods on it, back across the same socket. Our client is a Node daemon on a laptop that can run a one-off bit of Swift.

```ts
// daemon.ts — runSwift ACTUALLY runs Swift on the laptop: `swift -` reads the program from stdin.
import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";

const runSwift = (code: string) => {
  const swift = spawn("swift", ["-"]);
  swift.stdin.end(code);
  return text(swift.stdout); // Promise<string> of the output
};

using itx = newWebSocketRpcSession<Server>(socket);
await itx.register({ runSwift }); // hand the server our laptop tool
```

The server calls BACK into the laptop to ask the human a question, popping a **native macOS dialog** and reading what they type:

```ts
class Server extends RpcTarget {
  async register(laptop: { runSwift: (code: string) => Promise<string> }) {
    const answer = await laptop.runSwift(`
      import AppKit
      let a = NSAlert()
      a.messageText = "Agent needs your input"
      a.informativeText = "What should I name the project?"
      let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
      a.accessoryView = field
      a.addButton(withTitle: "OK")
      NSApp.activate(ignoringOtherApps: true)
      a.runModal()
      print(field.stringValue)        // → whatever the human typed
    `);
    return `the human chose: ${answer}`; // "the human chose: Aurora"
  }
}
```

Code in a Worker popped a native dialog on someone's laptop and read back what they typed — `laptop.runSwift(...)` executed _there_, called from _here_. A capability is just an object reference that happens to point across a socket. _(The runnable harness drives this exact path with a non-interactive program so CI doesn't block on the dialog; the dialog Swift above is type-checked separately.)_

### 🚧 Why this isn't enough yet

The laptop can only offer the _one_ object it passed into _that one call_, and only the server (its direct peer) can reach it. A real daemon offers several tools (`runSwift`, `runPython`, `screenshot`), wants to add them over time, and — soon — wants _other_ clients to use them. None of that fits "pass one object into one method."

---

## Step 2 — provide & invoke: capabilities go dynamic

> **the one new idea** — stop passing objects as call arguments. Add two verbs: `provideCapability({ name, capability })` registers a capability under a name; `invoke({ name, args })` calls it. The set of capabilities is now a dynamic registry, grown at runtime. (Every itx verb is a single **bag of props**, matching production — there are no positional signatures.)

```ts
class Itx extends RpcTarget {
  #caps = new Map<string, unknown>();
  provideCapability({ name, capability }: { name: string; capability: unknown }) {
    this.#caps.set(name, capability);
  }
  async invoke({ name, args }: { name: string; args: unknown[] }) {
    const cap = this.#caps.get(name);
    if (!cap) throw new Error(`no capability "${name}"`);
    return await (cap as Function)(...args);
  }
}
```

```ts
// laptop registers its tool by name, then anyone with the handle invokes it:
await itx.provideCapability({ name: "runSwift", capability: runSwift });
await itx.invoke({ name: "runSwift", args: [`print(1 + 1)`] }); // → "2\n"
```

The stored `name → capability` pairing has no special label in the codebase — the act is a **provide**, the folded row is a **capability entry**, and the target half is a `CapabilityTarget` (live stub or sturdy ref). In Step 6 the addressing field generalizes from `name` to a `path`, which is what production's `invoke({ path, args })` actually takes.

### 🚧 Why this isn't enough yet

The registry lives in one server's memory, reachable only by that connection. The dashboard in another tab — a _second_ client — can't see what the laptop provided.

---

## Step 3 — A second client

> **the motivation** — the laptop provides `runSwift`; a dashboard in another browser tab wants to invoke it. Two different sockets must meet at the _same_ registry.

```ts
// client A (laptop): provides
await a.provideCapability({ name: "runSwift", capability: runSwift });

// client B (dashboard): a SEPARATE socket — wants to call what A provided
await b.invoke({ name: "runSwift", args: [`print(40 + 2)`] }); // ← needs a shared registry
```

A plain per-connection `Itx` can't do this: each socket gets its own `#caps`. We need one registry both sockets reach.

### 🚧 Why this isn't enough yet

"One shared registry, addressable by name, that outlives any single connection" is exactly a **Durable Object**. So that's where the registry has to live.

---

## Step 4 — A Durable Object to live in

> **the one new idea** — put the `Itx` registry inside a Durable Object addressed by a constant name. Its real job is to be the **bridge**: client A's _live_ stub is held in the DO so client B — on a different edge isolate, with its own socket — can invoke it. Every connection meets the same DO, so provides and invokes rendezvous.

```ts
export class ItxDO extends DurableObject {
  #itx = new Itx();
  // Itx extends RpcTarget — and on workerd capnweb's RpcTarget IS the platform
  // `cloudflare:workers` RpcTarget — so returning it across the DO→Worker RPC
  // boundary passes a STUB (RpcStub<Itx>), never a copy. Calling a method on the
  // stub round-trips back to the DO. (A method, not a property: workerd doesn't
  // pipeline through property access.)
  itx(): Itx {
    return this.#itx;
  }
}

// the stateless Worker terminates the WebSocket and forwards verbs to the DO:
const itxDurableObject = env.ITX.getByName("itx"); // the ONE shared registry
const itx = itxDurableObject.itx(); // RpcStub<Itx> — .provideCapability()/.invoke() round-trip to the DO
```

Now A's provide and B's invoke meet in the DO → B runs A's live function.

### 🌉 The DO is the bridge, the edge does the rest

This is the division of labor that makes the whole thing work, and it's worth saying plainly:

- **The edge Worker is per-connection.** It terminates one client's WebSocket, builds that client's handle/proxy, and enforces the auth it established at connect. Crucially, an edge isolate only ever sees the live stubs from _its own_ socket — client A's `runSwift` stub lives in A's edge isolate, client B's in B's.
- **The DO is the shared meeting point.** It's the _one_ place both connections reach, so it's the only place a _live_ capability from A can be handed to B. A's edge Worker passes A's live stub into the DO (kept alive there); B's edge Worker forwards B's `invoke` to the same DO, which calls A's stub. Without the DO, B's isolate has no path to A's in-memory function at all.

So you can't push everything to the edge: the **ergonomics and auth** belong at the edge (per-connection), but the **live-capability rendezvous** has to be in the DO (cross-connection). Durability of the registry is a bonus the DO also gives you — but the bridge is the point.

Making a live cross-client stub actually survive this needs three things (verified in `server.ts`): the edge Worker passes a **duped** copy of the provided stub into the DO (Cap'n Web disposes argument stubs when the `provide` call returns), and it holds the provider's invocation open with **`ctx.waitUntil`** for the socket's lifetime, so A's stub stays callable when B invokes it later.

> **side note — hibernation, deferred.** The WebSocket terminates in the stateless Worker and the DO exposes its target through an `itx()` _method_ — which also positions us for capnweb hibernation if/when Workers-RPC targets become hibernatable (Kenton Varda has signalled it's on the table).

### 🚧 Why this isn't enough yet

We went dynamic, so we lost the nice native call — it's `invoke({ name: "runSwift", args })` now, not `itx.runSwift(...)`. Let's win the ergonomics back.

---

## Step 5 — Getting the method call back — and who's really proxying

> **the one new idea** — going dynamic looked like it cost us `itx.runSwift(code)`. It didn't — because the **client is a naked Cap'n Web stub**, and Cap'n Web already turns property access plus a call into a single pipelined message. We never write a client proxy. What we write is the **server-side** target that receives the name and turns it into an `invoke`.

```ts
// client — a plain Cap'n Web stub, no wrapper. It sends ["runSwift"] + args itself:
await itx.runSwift(`print(1 + 1)`); // → one pipelined call, path ["runSwift"] → "2\n"
```

```ts
// server — the registry is DYNAMIC, so the served target can't be a fixed class.
// Wrap the core in a Proxy whose unknown names become invoke():
function handle(core) {
  return new Proxy(core, {
    get(core, key) {
      if (key in core) return Reflect.get(core, key); // provideCapability, invoke, describe…
      return (...args) => core.invoke({ name: key, args }); // unknown → invoke
    },
  });
}

// the STATELESS WORKER builds the handle and serves it to the client over Cap'n Web.
// (Matches production: the DO returns the bare Itx core stub; the handle is a
// Worker-side wrapper around it — production calls it ItxHandle.)
newWebSocketRpcSession(clientSocket, handle(itx)); // itx = the RpcStub<Itx> from Step 4
```

`itx.runSwift(code)` feels native again — and notice **where** the proxy lives: the stateless Worker at the edge, not the DO.

### 🔌 Wait — does RPC ship a Proxy across the wire?

No. **An RPC never serializes a Proxy — it passes a _stub_ (a reference).** When the Worker hands `handle(core)` to Cap'n Web, the client receives a stub, not a copy; `itx.runSwift(...)` is a message back to the Worker, where the Proxy's `get`/`apply` traps actually run. Only plain `{...}` objects are deep-copied — functions, `RpcTarget`s, and Proxies over them cross by reference (`["export", id]` on the wire). workerd had to special-case this: wrapping an `RpcTarget` in a Proxy used to throw `DataCloneError` until [workerd#3184](https://github.com/cloudflare/workerd/pull/3212) taught serialization to see the `RpcTarget` through the Proxy and pass it by stub. This works one level because Cap'n Web walks an `RpcTarget` by reading its members directly — the deep version (Step 6) trips a subtler rule.

### 🌍 Why build the proxy at the edge, not in the DO?

The DO is the one **durable, single-threaded** thing — a serialization point for the shared registry. The stateless Worker is **horizontally scalable** and is where each WebSocket actually terminates. So the per-connection work — the proxy traps, the ergonomic handle, and the connect-time **auth/access narrowing** it carries — belongs at the edge, next to the connection, where it scales out per client. The DO does only the minimal stateful job (hold the fold) and nothing per-connection. Concretely that buys you: the DO is never **pinned per-connection** (otherwise every live socket would hold a slice of the DO's memory and its single thread, throttling everyone); the handle is cheap and ephemeral, recreated per connection from the same DO; and it keeps the door open to **capnweb hibernation** (idle edge sessions can sleep without keeping the DO resident). The cost is one extra hop (edge → DO) per real registry op — cheap, and pipelined into a single round trip.

### 🚧 Why this isn't enough yet

The capability is a whole _SDK_ and you want `itx.slack.chat.postMessage({ channel, text })` — a deep path, ideally typed against the official Slack package. Cap'n Web pipelines the whole path from the client just fine; the breakage is on the **server**, where traversing past the first segment needs more than a `get` trap.

---

## Step 6 — Deep paths & the Slack SDK

> **the motivation** — mount the official `@slack/web-api` client as **one capability** and call straight into it — `itx.slack.chat.postMessage(…)` — with the SDK's own types. The client writes nothing new: Cap'n Web accumulates `["slack","chat","postMessage"]` locally (zero round trips) and sends one pipelined call. The **server** mounts the cap at a path, resolves the **longest registered prefix**, and **replays the remainder** onto the target.

```ts
// provide the real Slack SDK as ONE capability, mounted at "slack":
import { WebClient } from "@slack/web-api";
itx.provideCapability({ name: "slack", capability: new WebClient(token) });

// client — a naked stub typed as { slack: WebClient }, so the editor autocompletes the
// real Slack API. Cap'n Web sends ["slack","chat","postMessage"] + [msg] in ONE message:
await itx.slack.chat.postMessage({ channel: "C123", text: "hi" });

// server — resolve the LONGEST registered prefix, replay the rest onto the target.
// invoke's addressing field is now a `path` (this is production's invoke({ path, args })):
invoke({ path, args }) {
  const { entry, remainder } = resolveLongestPrefix(this.#caps, path); // "slack" wins
  return replayPath(entry, remainder, args); // webClient.chat.postMessage(msg)
}
```

itx doesn't know a thing about Slack; it routes a path. And there is **no client-side path proxy** — Cap'n Web's stub already is one. (Production matches this exactly: the browser, Node, and the REPL all hold a plain `newWebSocketRpcSession<ItxHandle>` stub; the path proxy in `path-proxy.ts` runs _server-side_, inside the handle.)

### ⚠️ The gotcha that cost a day

The dynamic **server** target has to answer for names it has never seen. Three non-obvious rules make that work (all verified in `min-dynamic-target.mjs`):

1. **`getOwnPropertyDescriptor` is load-bearing, not just `get`.** Server-side Cap'n Web does `Object.hasOwn(value, segment)` _before_ reading each segment; without a descriptor trap every segment reads as absent and the chain dies at "`.chat` of undefined" — which is exactly why our first draft wrongly concluded deep server-side dispatch "doesn't work."
2. **The target must be function-typed** — a Proxy over a plain function, not over an `RpcTarget`. Cap'n Web classifies an rpc-target by its prototype and rejects fabricated "instance properties" (it even flags the real verbs).
3. **Retain (`dup`) provided live stubs** — Cap'n Web disposes argument stubs when the `provide` call returns.

### 🎁 What falls out for free

Because the _longest_ registered prefix wins, you can **shadow a single method deep inside another capability**. Provide at `["slack","chat","postMessage"]` and that one call resolves to your override; `slack.users.list` and everything else still resolves to the original `slack` client.

```ts
// wrap just chat.postMessage with rate-limiting; leave the rest of Slack intact.
itx.provideCapability({
  path: ["slack", "chat", "postMessage"],
  capability: rateLimited(slack.chat.postMessage),
});
await itx.slack.chat.postMessage(msg); // → your wrapper (longest prefix)
await itx.slack.users.list(); // → the original WebClient (prefix "slack")
```

### 🚧 Why this isn't enough yet

The DO is evicted (we kept deferring it). And we still haven't said what a capability _is_ — the laptop's `runSwift` is a live function in a process that may have closed its lid; the Slack client is a live object too. Some capabilities can't survive an eviction. We have to name the kinds.

---

## Step 7 — Live vs sturdy: what a capability _is_

> **the one new idea** — a capability is a name → a target that is EITHER **live** (a stub/function held in memory, dies with its connection) OR a **sturdy ref** (`{ type: "rpc", worker: {...} }`) — plain, serializable data describing how to _re-make_ the target on demand. `CapabilityKind = "live" | "rpc"`.

The motivation for sturdy: "it's defined in this project worker." Encode that as data:

```ts
const slackRef = {
  type: "rpc",
  worker: { type: "source", source: { repo, commit, path: "caps/slack.ts" } },
};
itx.provideCapability({ name: "slack", capability: slackRef }); // survives eviction — it's just data
```

A purely structural discriminator decides dispatch:

```ts
const isCapabilityAddress = (t) => !!t && typeof t === "object" && t.type === "rpc";

async function dispatch(target, args) {
  return isCapabilityAddress(target)
    ? await dial(target)(...args) // sturdy → dial the ref, then call
    : await target(...args); // live → call in place
}
```

### 🚧 Why this isn't enough yet

If the registry is just a `Map` in memory, it dies with the DO anyway — even the sturdy refs. We need the registry itself to be durable.

---

## Step 8 — Durability: the table is the fold of the context's stream

> **the one new idea** — don't store the registry; store the **events** and fold them. `reduceItxEvent(state, event)` is the single source of truth; the registry is `events.reduce(reduceItxEvent, empty)`. Provide/revoke append events; the table is derived. Replaying the stream reproduces the registry exactly — no hidden state.

```ts
function reduceItxEvent(state, event) {
  const next = new Map(state);
  switch (event.type) {
    case "capability-provided":
      next.set(event.name, { kind: event.kind, value: event.value });
      break;
    case "capability-revoked":
      next.delete(event.name);
      break;
  }
  return next;
}
```

Last-write-wins, revoke removes, and replay is deterministic — the table is never the source of truth, the stream is.

### 🚧 Why this isn't enough yet

A sturdy ref is just data. Something has to turn `{ type:"rpc", worker:{ type:"source", … } }` back into a callable. That's `dial`.

---

## Step 9 — dial: restoring a ref by running the project worker

> **the one new idea** — `dial(ref)` is an injected effect that turns a sturdy ref into a `PathCallable`. For a `source` worker it **builds the project worker from the repo and runs it as a dynamic worker** (the Worker Loader), caching the isolate by content — same content, same isolate.

```ts
function dial(ref) {
  if (ref.type !== "rpc") throw new Error("not dialable");
  switch (ref.worker.type) {
    case "source":
      return (code) => loadIsolate(ref.worker.source).run(code); // Worker Loader (cached by content)
    // also: "binding" (env binding like AI), "loopback" (first-party entrypoint), "durable-object"
  }
}
```

Dialing the same ref twice reuses the cached isolate (no rebuild); different content builds a new one. The core only knows "ref → `PathCallable` via the injected `dial`."

### 🚧 Why this isn't enough yet

A context wants the platform's defaults (`fetch`, `ai`, `secrets`) and a parent's capabilities without re-providing them all. We need contexts to inherit.

---

## Step 10 — extend & super: the context chain

> **the one new idea** — a context can `extend` a parent. On a capability **miss**, dispatch climbs to `super` (the parent context). A child **shadow** wins over the parent — the deep-shadowing trick from Step 6, now up the chain.

```ts
function invoke(name) {
  if (this.#caps.has(name)) return this.#caps.get(name); // self wins (shadow)
  if (this.super) return this.super.invoke(name); // miss → climb to parent
  throw new Error(`no capability "${name}"`);
}
```

A child provides `slack`; the parent provides `fetch` and `ai`. The child sees all three; if the child also provides `fetch`, its version shadows the parent's. The chain bottoms out at a code-rooted, read-only platform context whose defaults are loopback refs — so they update the instant you deploy.

### 🎯 Nothing breaks — this is the punchline

Everything we've built (provide/revoke as events, a folded table, read-your-writes, a stream that replays) is exactly a **stream processor**.

---

## Step 11 — Itx _is_ a StreamProcessor

> **the punchline** — `Itx extends StreamProcessor`. `provideCapability` == append an event; `getState()` == the fold; so the materialized registry equals `reduceItxEvent` over the appended stream, and you read your own writes. A context **is** its stream coordinate `<namespace>:/<path>` — which is also the host DO's name and its dial address.

```ts
class Itx extends StreamProcessor {
  constructor() {
    super(reduceItxEvent);
  }
  provideCapability({ name, capability }) {
    this.append({ type: "capability-provided", name, capability }); // append, don't store
  }
  invoke({ path, args }) {
    const cap = this.getState().get(path[0]); // the fold of everything appended
    return cap(...args);
  }
}
```

The whole thing is one idea seen from a few angles: a name → a live-or-ref target, a table that is the fold of the context's stream living in one Durable Object, a server-side proxy that makes calling it feel native, paths that mount whole SDKs and shadow deep, borrow-or-dial, and a climb to the parent on a miss.

---

## Recap — what the small core actually is

The test for "core vs addendum": **does removing it change what `reduce` computes, or what a live-vs-ref target means?** If no, it's an addendum item.

| Piece                                            | name                                                            | ~lines |
| ------------------------------------------------ | --------------------------------------------------------------- | ------ |
| The fold (single source of truth)                | `reduceItxEvent`                                                | ~60    |
| live-vs-ref discriminator                        | `isCapabilityAddress`                                           | ~25    |
| The one write path                               | `provideCapability` / `revoke`                                  | ~80    |
| Borrow-or-dial + the dial type                   | `#borrow`                                                       | ~30    |
| Dispatch + chain delegation                      | `invoke`                                                        | ~40    |
| Server-side path proxy + longest-prefix + replay | `PathProxy` / `resolveLongestProvidedPrefix` / `replayPathCall` | ~50    |
| Chain-merged, shadow-aware view                  | `describe` / `extend` / `super`                                 | ~45    |
| Write/consume seam (read-your-writes)            | `#append` / `#catchUp` / `#materialize`                         | ~50    |

---

## Addendum — everything we layered on, and why

All real, all in the actual files; none of it changes the inner model. Each entry is the concrete failure it buys you out of.

- **Two RPC systems — Cap'n Web pipelines paths, Workers RPC doesn't.** Cap'n Web pipelines a whole dotted path from a naked stub into one call (so `itx.slack.chat.postMessage(…)` needs no client proxy; the server-side dynamic proxy only has to answer `Object.hasOwn` per segment via its `getOwnPropertyDescriptor` trap). Workers RPC (the DO stub, the dialed parent) does _not_ pipeline through property accesses — which is why the DO exposes its core via an `itx()` method and why `itx.project.processor.snapshot()` is made to work by `replayPathCall` awaiting each segment server-side.

- **The server-side proxy's sharp edges** — `then` reads as `undefined` (so a path node is never mistaken for a thenable), and protocol-level segments (`__proto__`, `apply`, `call`, `dup`, Cap'n Web stub controls) are refused on intermediate nodes — the same reserved set guards both the proxy and `replayPathCall`.

- **Live-stub retention** — `dup()` provided stubs (deep-walk plain-object providers); teardown appends a `capability-disconnected` event so `describe()` shows it offline.

- **The handle is more than the proxy** — the real `ItxHandle` also carries built-ins (`projects`, `streams`, `fetch`, `extend`, `super`) that don't fall through to `invoke`, plus reserved-name gating; it's what the Worker serves (a thin wrapper dialing the DO node's `itx()`).

- **The ref taxonomy and dial's reach** — beyond `source`, a ref's `worker` can be `binding`, `loopback`, or `durable-object`; `dial` handles Worker-Loader isolate caching (by content, per origin), facets, and allowlists.

- **Dial allowlists & spoof-proofing** — reach is gated at _invoke_ time, not provide time; every dialed target gets injected props (`capabilityPath`, `context`, `projectId`) that overwrite caller-supplied ones.

- **A context _is_ its stream coordinate** — identity is the ref `<namespace>:/<path>`, also the host DO's name and dial address; no synthetic ids, no directory table.

- **Hibernation, deferred** — the session terminates in the stateless Worker; the DO exposes its target via `itx()`. Positions us to adopt capnweb hibernation later.

- **`fetch` as a shadowable capability** — egress is a default `fetch` cap; bare `fetch()` in loaded isolates and `itx.fetch()` both route through it; a live shadow on a child intercepts both; secret placeholders are substituted outside the isolate.

- **Origin threading** — `invoke` carries `origin: { ref, address }` so an inherited cap's bare `fetch()` dials back through the _originating_ context's chain.

- **Read-your-writes hardening** — `#catchUp` loops a single-flight sync until one that started at/after the current append count completes, surviving concurrent writers.

- **Script execution (codemode)** — a capability can be a whole script; `script-execution-requested`/`-completed` events run an `async (itx) => …` program in a loaded isolate.

- **Access non-escalation & the platform defaults root** — a project handle's access is exactly its own project; the chain bottoms out at a code-rooted read-only platform context.

---

_ground truth: `apps/os/src/itx/{itx,handle,path-proxy,dial,coordinates,entrypoint,contract,types,itx-durable-object,fetch}.ts` · `packages/streams/src/stream-processor.ts`. Runnable: `server.ts` + `harness.ts`, `min-dynamic-target.mjs`, `validate-steps.mjs` in this folder._
