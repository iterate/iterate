# itx, derived from a bare socket

A coding-workshop derivation of **itx** — Iterate's capability layer — built up from a single Cap'n Web socket, one motivated step at a time. The inner core is a few hundred lines and tells one story; everything else is an addendum of layered complexity, each entry the concrete failure it buys you out of.

> **runnable & verified** — The _complete, runnable_ implementations live in this folder: Steps 0–6 (wire-level) run against real `workerd` + Cap'n Web clients (`server.ts` + `harness.ts`, and the self-contained `min-dynamic-target.mjs`); Steps 7–10 (model-level — ref taxonomy, dial, fold, chain, processor) are checked by `validate-steps.mjs`; the Step 1 dialog Swift is type-checked with `swiftc`. The **inline snippets below are abbreviated for reading** — they lean on a few helpers defined once and reused (`findCapabilityByPath`, `invokeCapabilityAtPath`, `retain`) and on real workerd behavior, so don't expect every fragment to run verbatim if you paste it in isolation; the files above are the source of truth. One caveat that bites: if you _simulate_ the DO with a shared in-memory object (no wrangler), the RpcStub-vs-copy distinction and `ctx.waitUntil` vanish — and with them the whole point of Step 4. One thing worth flagging up front: **there is no client-side path proxy** — a naked Cap'n Web stub already pipelines a whole dotted path into one call (see Step 6).

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
import { newWebSocketRpcSession, type RpcStub } from "capnweb";

// pass a URL; capnweb opens the socket. `using` (TS 5.2 explicit resource
// management) disposes the session — closing the socket — at end of scope.
// `newWebSocketRpcSession<Server>(…)` returns an `RpcStub<Server>`.
using itx: RpcStub<Server> = newWebSocketRpcSession<Server>("wss://your-worker.example/api");
await itx.greet("ada"); // → "hello, ada"
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

using itx: RpcStub<Server> = newWebSocketRpcSession<Server>("wss://your-worker.example/api");
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

> **the one new idea** — stop passing objects as call arguments. Add two verbs: `provide({ name, capability, instructions })` registers a capability under a name — `instructions` says what it's for; `invoke({ name, args })` calls it. The set of capabilities is now a dynamic registry, grown at runtime.

```ts
class Itx extends RpcTarget {
  // The registry: capability name → its entry. A plain object keyed by name —
  // it stays plain JSON all the way through, which is what lets it become a
  // durable, replayable fold in Step 8.
  #caps: Record<string, { capability: any; instructions?: string }> = {};
  provide({
    name,
    capability,
    instructions,
  }: {
    name: string;
    capability: any;
    instructions?: string;
  }) {
    // ⚠️ Cap'n Web disposes an argument stub when this call RETURNS — so holding a
    // bare reference is dead by the next call (you'd get "RpcImportHook was already
    // disposed"). Retain it with `.dup()`. (A nested SDK object needs a recursive
    // dup — see `retain` in Step 6.)
    this.#caps[name] = { capability: capability.dup?.() ?? capability, instructions };
  }
  async invoke({ name, args }: { name: string; args: unknown[] }) {
    const entry = this.#caps[name];
    if (!entry) throw new Error(`no capability "${name}"`);
    return await entry.capability(...args);
  }
}
```

```ts
// laptop registers its tool by name, then anyone with the handle calls it:
await itx.provide({
  name: "runSwift",
  capability: runSwift,
  instructions: "run a Swift program, return its stdout",
});
await itx.invoke({ name: "runSwift", args: [`print(1 + 1)`] }); // → "2\n"
```

A `provide` can carry two pieces of metadata, **both optional**: **`instructions`** — a sentence saying what the capability is for, for an agent or a human reading the table — and **`types`**, a type surface for the cap. `instructions` is the one you'll usually set; `types` is genuinely optional and most caps omit it (it's carried for when something acts on it; nothing does yet). Whatever you pass rides the `provideCapability({ path, capability, instructions?, types? })` bag over the wire, the fold records it on the capability entry, and a context-level `describe()` reads it back — a cap **describes itself at the point it's provided**, so there's no separate per-capability describe step to maintain; `describe()` just surfaces the metadata the fold already holds (`null` for whatever you left out). (The runnable harness asserts both directions: provide `db` with `instructions` + `types` and `describe().db` returns them; provide `mailer` bare and `describe().mailer` comes back `{ instructions: null, types: null }`.)

The stored `name → capability` pairing has no special label in the codebase — the act is a **provide** and what it registers is a **capability entry**. A capability is one of just two kinds: a live **stub** or, later (Step 7), a serializable **address**. (Step 6 will generalize this addressing field from a `name` to a `path`.)

(We call the verbs `provide` / `invoke` here while deriving them; the runnable toy spells them `provideCapability` / `invokeCapability` / `revokeCapability` (+ `describe`) — flat verbs on the handle, kept consistent and matching production, _not_ namespaced under `itx.caps.*`. `invoke`/`invokeCapability` does double duty on purpose: it's the public verb _and_ the one calling convention every capability bottoms out in — `invoke({ path, args })`, the same operation one layer apart. We deliberately use `invoke` rather than `call`: `call` is a `Function.prototype` member (`fn.call(...)`), so a `call` verb/convention would collide with it — both as a reserved path segment and as a member name on the function-typed proxy. `invoke` isn't on any prototype, so it stays clean.)

### 🚧 Why this isn't enough yet

The registry lives in one server's memory, reachable only by that connection. The dashboard in another tab — a _second_ client — can't see what the laptop provided.

---

## Step 3 — A second client

> **the motivation** — the laptop provides `runSwift`; a dashboard in another browser tab wants to call it. Two different sockets must meet at the _same_ registry.

```ts
const url = "wss://your-worker.example/api";

// client A (laptop): its own socket → its own Itx; provides runSwift
using a: RpcStub<Itx> = newWebSocketRpcSession<Itx>(url);
await a.provide({ name: "runSwift", capability: runSwift });

// client B (dashboard): a SEPARATE socket → a SEPARATE Itx; wants what A provided
using b: RpcStub<Itx> = newWebSocketRpcSession<Itx>(url);
await b.invoke({ name: "runSwift", args: [`print(40 + 2)`] });
// ❌ Error: no capability "runSwift" — B's socket got its own empty Itx; A's #caps is on A's socket
```

A plain per-connection `Itx` can't do this: each socket gets its own `#caps`. We need one registry both sockets reach.

### 🚧 Why this isn't enough yet

"One shared registry, addressable by name, that outlives any single connection" is exactly a **Durable Object**. So that's where the registry has to live.

---

## Step 4 — A Durable Object to live in

> **the one new idea** — put the `Itx` registry inside a Durable Object addressed by a constant name. Its real job is to be the **bridge**: client A's _live_ stub is held in the DO so client B — on a different edge isolate, with its own socket — can call it. Every connection meets the same DO, so provides and invokes rendezvous.

```ts
export class ItxDO extends DurableObject {
  #itx = new Itx();
  // Itx extends RpcTarget — and on workerd capnweb's RpcTarget IS the platform
  // `cloudflare:workers` RpcTarget — so returning it across the DO→Worker RPC
  // boundary passes a STUB (RpcStub<Itx>), never a copy. Calling a method on the
  // stub round-trips back to the DO.
  //
  // Why a method and not a public field `itx = new Itx()`? Workers RPC can't
  // read instance properties over the wire, nor pipeline through them — a public
  // `itx` field would be unreachable as `itxDurableObject.itx`. It must be a
  // method call.
  itx(): Itx {
    return this.#itx;
  }
}

// the stateless Worker terminates the WebSocket and forwards verbs to the DO:
const itxDurableObject = env.ITX.getByName("itx"); // the ONE shared registry
const itx = itxDurableObject.itx(); // RpcStub<Itx> — .provide()/.invoke() round-trip to the DO
```

Now A's provide and B's invoke meet in the DO → B runs A's live function.

This is the real shape, minimally: the workshop's `server.ts` has exactly one `ItxDO` that holds the `Itx` and exposes it via an `itx()` **method** (never a field — workerd can't pipeline through properties). What's still missing here is what the `Itx` is constructed _with_: Step 10 fills that in — the constructor takes its **durable event log** (a real the platform `Stream` DO) and a checkpoint — and the same `ItxDO` is what every step from here on runs against. (Production's `apps/os/src/itx/itx-durable-object.ts` is this plus the chain/dial of Step 11.)

That constant name (`"itx"`) is really the context's **address**. In production it's a **project id + a path** — `<projectId>/<path>` (e.g. `prj_abc/agents/foo`) — that doubles as the DO's name _and_ the dial address. `prj_abc/` is the project itx; `prj_abc/agents/foo` is an agent itx under it (Step 11). For now, one constant name = one shared context.

### 🌉 The DO is the bridge, the edge does the rest

This is the division of labor that makes the whole thing work, and it's worth saying plainly:

- **The edge Worker is per-connection.** It terminates one client's WebSocket, builds that client's handle/proxy, and enforces the auth it established at connect. Crucially, an edge isolate only ever sees the live stubs from _its own_ socket — client A's `runSwift` stub lives in A's edge isolate, client B's in B's.
- **The DO is the shared meeting point.** It's the _one_ place both connections reach, so it's the only place a _live_ capability from A can be handed to B. A's edge Worker passes A's live stub into the DO (kept alive there); B's edge Worker forwards B's `invoke` to the same DO, which calls A's stub. Without the DO, B's isolate has no path to A's in-memory function at all.

So you can't push everything to the edge: the **ergonomics and auth** belong at the edge (per-connection), but the **live-capability rendezvous** has to be in the DO (cross-connection). Durability of the registry is a bonus the DO also gives you — but the bridge is the point.

Making a live cross-client stub actually survive this needs three things (verified in `server.ts`): the edge Worker passes a **duped** copy of the provided stub into the DO (Cap'n Web disposes argument stubs when the `provide` call returns), and it holds the provider's invocation open with **`ctx.waitUntil`** for the socket's lifetime, so A's stub stays callable when B calls it later.

> **side note — hibernation, deferred.** The WebSocket terminates in the stateless Worker and the DO exposes the `Itx` through an `itx()` _method_ — which also positions us for capnweb hibernation if/when Workers-RPC targets become hibernatable (Kenton Varda has signalled it's on the table).

### 🚧 Why this isn't enough yet

We went dynamic, so we lost the nice native call — it's `invoke({ name: "runSwift", args })` now, not `itx.runSwift(...)`. Let's win the ergonomics back.

---

## Step 5 — Getting the method call back — and who's really proxying

> **the one new idea** — going dynamic looked like it cost us `itx.runSwift(code)`. It didn't — because the **client is a naked Cap'n Web stub**, and Cap'n Web already turns property access plus a call into a single pipelined message. We never write a client proxy. What we write is the **server-side** proxy that receives the name and turns it into an `invoke`.

```ts
// client — a plain Cap'n Web stub, no wrapper. It sends ["runSwift"] + args itself:
await itx.runSwift(`print(1 + 1)`); // → one pipelined call, path ["runSwift"] → "2\n"
```

```ts
// server — the registry is DYNAMIC, so what we serve can't be a fixed class.
// Wrap the core in a Proxy whose unknown names become an invoke():
function invokeFallthrough(core) {
  return new Proxy(core, {
    get(core, key) {
      if (key in core) {
        const v = Reflect.get(core, key); // provide, invoke, describe…
        return typeof v === "function" ? v.bind(core) : v; // BIND: else `this` is the Proxy and
      } //                                                    core's #private fields throw
      return (...args) => core.invoke({ name: key, args }); // unknown name → invoke
    },
  });
}

// the STATELESS WORKER wraps the core and serves it to the client over Cap'n Web.
// (Matches production: the DO returns the bare Itx core stub; this wrapper is the
// Worker-side handle around it — production calls it ItxHandle.)
newWebSocketRpcSession(clientSocket, invokeFallthrough(itx)); // itx = the RpcStub<Itx> from Step 4
```

`itx.runSwift(code)` feels native again — and notice **where** the proxy lives: the stateless Worker at the edge, not the DO.

### 🔌 Wait — does RPC ship a Proxy across the wire?

No. **An RPC never serializes a Proxy — it passes a _stub_ (a reference).** When the Worker hands `invokeFallthrough(core)` to Cap'n Web, the client receives a stub, not a copy; `itx.runSwift(...)` is a message back to the Worker, where the Proxy's `get`/`apply` traps actually run. Only plain `{...}` objects are deep-copied — functions, `RpcTarget`s, and Proxies over them cross by reference (`["export", id]` on the wire). workerd had to special-case this: wrapping an `RpcTarget` in a Proxy used to throw `DataCloneError` until [workerd#3184](https://github.com/cloudflare/workerd/pull/3212) taught serialization to see the `RpcTarget` through the Proxy and pass it by stub. This works one level because Cap'n Web walks an `RpcTarget` by reading its members directly — the deep version (Step 6) trips a subtler rule.

### 🌍 Why build the proxy at the edge, not in the DO?

The DO is the one **durable, single-threaded** thing — a serialization point for the shared registry. The stateless Worker is **horizontally scalable** and is where each WebSocket actually terminates. So the per-connection work — the proxy traps, the ergonomic handle, and the connect-time **auth/access narrowing** it carries — belongs at the edge, next to the connection, where it scales out per client. The DO does only the minimal shared job — hold the registry, including the in-memory live stubs that connected clients provided — and nothing per-connection. Concretely that buys you: the DO is never **pinned per-connection** (otherwise every live socket would hold a slice of the DO's memory and its single thread, throttling everyone); the handle is cheap and ephemeral, recreated per connection from the same DO; and it keeps the door open to **capnweb hibernation** (idle edge sessions can sleep without keeping the DO resident). The cost is one extra hop (edge → DO) per real registry op — cheap, and pipelined into a single round trip.

### 🚧 Why this isn't enough yet

The capability is a whole _SDK_ and you want `itx.slack.chat.postMessage({ channel, text })` — a deep path, ideally typed against the official Slack package. Cap'n Web pipelines the whole path from the client just fine; the breakage is on the **server**, where traversing past the first segment needs more than a `get` trap.

---

## Step 6 — Deep paths & the Slack SDK

> **the motivation** — mount the official `@slack/web-api` client as **one capability** and call straight into it — `itx.slack.chat.postMessage(…)` — with the SDK's own types. The client writes nothing new: Cap'n Web accumulates `["slack","chat","postMessage"]` locally (zero round trips) and sends one pipelined call. The **server** mounts the cap at a path, finds the capability whose name is the **longest registered prefix**, and **invokes the rest of the path** on it.

```ts
// provide the real Slack SDK as ONE capability, mounted at "slack":
import { WebClient } from "@slack/web-api";
itx.provide({ name: "slack", capability: new WebClient(token) });

// client — a naked stub typed as { slack: WebClient }, so the editor autocompletes the
// real Slack API. Cap'n Web sends ["slack","chat","postMessage"] + [msg] in ONE message:
await itx.slack.chat.postMessage({ channel: "C123", text: "hi" });

// server — two small helpers, defined once here and reused by every later step:
function findCapabilityByPath({ caps, path }) {
  // the LONGEST registered prefix wins — "slack" matches slack.chat.postMessage,
  // and a deeper "slack.chat.postMessage" entry beats "slack" — what enables deep shadowing.
  for (let i = path.length; i >= 1; i--) {
    const name = path.slice(0, i).join(".");
    if (caps[name]) return { name, capability: caps[name], rest: path.slice(i) };
  }
  return null;
}
function invokeCapabilityAtPath({ capability, path, args }) {
  // a live capability is a STUB — walk the rest of the path on it, then call the leaf:
  let stub = capability;
  for (const seg of path.slice(0, -1)) stub = stub[seg];
  return path.length ? stub[path.at(-1)](...args) : capability(...args);
}

// the verb's addressing field is now a `path`.
invoke({ path, args }) {
  const hit = findCapabilityByPath({ caps: this.#caps, path });
  if (!hit) throw new Error(`no capability "${path.join(".")}"`);
  return invokeCapabilityAtPath({ capability: hit.capability, path: hit.rest, args }); // → postMessage(msg)
}
```

itx doesn't know a thing about Slack; it routes a path. And there is **no client-side path proxy** — Cap'n Web's stub already is one. (Production matches this exactly: the browser, Node, and the REPL all hold a plain `newWebSocketRpcSession<ItxHandle>` stub; the path proxy in `path-proxy.ts` runs _server-side_, inside the handle.)

And since a capability is addressed by a **path**, the _name_ side of `provide` is a path too — `provide({ name: "slack", … })` is just the one-segment case. You might as well mount it deeper; namespacing comes for almost free:

```ts
// mount the same client at itx.integrations.slack — same longest-prefix dispatch:
itx.provide({ path: ["integrations", "slack"], capability: new WebClient(token) });
await itx.integrations.slack.chat.postMessage({ channel: "C123", text: "hi" });
```

### ⚠️ The server-side dynamic proxy

`findCapabilityByPath`/`invokeCapabilityAtPath` are the easy part. The hard part is the **server-side proxy** that turns an _arbitrary_ incoming dotted path into that `invoke` — it has to answer for names it has never seen. Here it is (this is the whole thing, runnable verbatim in `min-dynamic-target.mjs`):

```ts
const RESERVED = new Set([
  "then",
  "__proto__",
  "constructor",
  "prototype",
  "apply",
  "call",
  "bind",
  "dup",
]);

// The dynamic target. FUNCTION-typed (a Proxy over `function(){}`), so Cap'n Web
// traverses it via Object.hasOwn and ALLOWS fabricated own properties — it rejects
// those on a Proxy over an RpcTarget (it classifies rpc-targets by prototype). Root
// verb names resolve to the verb; any other name extends the accumulating path; the
// terminal call funnels into invoke({ path, args }).
function dynamicTarget({ rpcTarget, path = [] }) {
  const verbAt = (key) => path.length === 0 && key in rpcTarget; // provide / invoke / list
  const valueFor = (key) =>
    verbAt(key)
      ? rpcTarget[key].bind(rpcTarget)
      : dynamicTarget({ rpcTarget, path: [...path, key] });
  return new Proxy(function () {}, {
    get(t, key) {
      if (typeof key === "symbol") return Reflect.get(t, key);
      if (key === "then" || RESERVED.has(key)) return undefined; // never a thenable; never a control word
      return valueFor(key);
    },
    // LOAD-BEARING: server-side Cap'n Web does Object.hasOwn(value, segment) BEFORE
    // reading value[segment]. Without this trap every segment reads as absent and the
    // chain dies at ".chat of undefined" — even the base verbs read as "not a function".
    getOwnPropertyDescriptor(t, key) {
      if (typeof key === "symbol" || RESERVED.has(key))
        return Reflect.getOwnPropertyDescriptor(t, key);
      return { configurable: true, enumerable: true, writable: false, value: valueFor(key) };
    },
    has(t, key) {
      return typeof key === "symbol" ? key in t : !RESERVED.has(key);
    },
    apply(_t, _s, args) {
      return rpcTarget.invoke({ path, args }); // the accumulated dotted path, in one call
    },
  });
}
```

Two more rules it relies on. **Retain (`dup`) provided live stubs — recursively**, because Cap'n Web disposes argument stubs when `provide` returns; a nested SDK object is copied by value but its function members arrive as stubs that get disposed, so `retain` dups every function it finds:

```ts
const retain = (t) =>
  t?.dup
    ? t.dup()
    : t && typeof t === "object"
      ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k, retain(v)]))
      : t;
```

And `call`/`apply`/`bind` stay reserved as path segments because they're `Function.prototype` members — exactly why the verb is named `invoke`, not `call`. One reserved-name set guards both the proxy and the server-side replay.

(In the runnable code this `retain` is in `server.ts`, applied at the Worker edge; the Durable Object applies it again as `retainLiveProvider` in `itx-processor.ts` — each RPC hop must keep its own copy.)

### 🎁 What falls out for free

Because the _longest_ registered prefix wins, you can **shadow a single method deep inside another capability**. Provide at `["slack","chat","postMessage"]` and that one call resolves to your override; `slack.users.list` and everything else still resolves to the original `slack` client.

```ts
// wrap just chat.postMessage with rate-limiting; leave the rest of Slack intact.
itx.provide({
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

> **the one new idea** — a capability comes in just two kinds: a live **stub** (an object/function held in memory — dies with its connection) or an **address** (`{ type: "rpc", worker, props }`) — plain, serializable data describing how to _re-make_ it on demand. `CapabilityKind = "live" | "rpc"`.

The motivating case: a **reusable first-party worker that turns an OpenAPI spec into a callable API**, specialized per-API by its props. It dispatches each call by `operationId` to the matching HTTP request:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

export class OpenApiClient extends WorkerEntrypoint<Env, { specUrl: string; baseUrl?: string }> {
  // the kernel dispatches every capability as invoke({ path, args }):
  async invoke({ path: [operationId], args: [input = {}] }) {
    const spec = await fetch(this.ctx.props.specUrl).then((r) => r.json());
    const base = this.ctx.props.baseUrl ?? spec.servers?.[0]?.url;
    for (const [route, methods] of Object.entries(spec.paths))
      for (const [method, op] of Object.entries(methods))
        if (op.operationId === operationId) {
          const url = route.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(input[k]));
          return fetch(new URL(url.replace(/^\//, ""), base), {
            method: method.toUpperCase(),
            ...(method === "get"
              ? {}
              : { headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
          }).then((r) => r.json());
        }
    throw new Error(`No operation "${operationId}" in spec`);
  }
}
```

Now "the Petstore API" is a **sturdy capability** — no live connection, just a ref naming that worker plus the props that specialize it. It's a **loopback** ref: a first-party entrypoint the platform already exposes, named rather than loaded from anywhere:

```ts
itx.provide({
  name: "petstore",
  capability: {
    type: "rpc",
    worker: { type: "loopback" }, // a first-party entrypoint the host exposes
    entrypoint: "OpenApiClient",
    props: { specUrl: "https://petstore3.swagger.io/api/v3/openapi.json" },
  },
  instructions: "the Petstore API",
}); // survives eviction — it's just data; dial re-makes it on demand
await itx.petstore.findPetsByStatus({ status: "available" }); // → invoke({ path: ["findPetsByStatus"], args })
```

This is modeled on what iterate ships — `apps/os/src/itx/capabilities/openapi-client.ts`, a loopback cap (the real one also fetches the spec through project egress and derives a typed surface). A loopback is one ref kind; the other big one is a **`source`** worker — code built and run at runtime (a _dynamic worker_, via the Worker Loader). That's what `dial` does, just below, and what the runnable `steps/09-dial` actually exercises.

A purely structural discriminator tells the two kinds apart — and `invokeCapabilityAtPath` from Step 6 just grows an **address** branch, so `invoke` itself is unchanged:

```ts
const isCapabilityAddress = (capability) =>
  !!capability && typeof capability === "object" && capability.type === "rpc";

// extends Step 6: an ADDRESS is dialed to a PathCallable first; a STUB is walked in place.
function invokeCapabilityAtPath({ capability, path, args }) {
  if (isCapabilityAddress(capability)) return dial(capability).invoke({ path, args }); // address → dial
  let stub = capability; // live stub → walk the rest of the path, call the leaf
  for (const seg of path.slice(0, -1)) stub = stub[seg];
  return path.length ? stub[path.at(-1)](...args) : capability(...args);
}
```

A **`PathCallable`** is just "anything with `invoke({ path, args })`" — the one calling convention everything bottoms out in, and exactly what `dial` returns. (Production names this calling convention `call`, distinct from the `invoke` verb; we use `invoke` for both, to avoid the `Function.prototype.call` clash.)

So what is `dial`? It's an injected effect that turns a sturdy ref back into a `PathCallable`. For a `source` worker it **builds the project worker from the repo and runs it as a dynamic worker** (the Worker Loader), caching the isolate by content — same content, same isolate:

```ts
function dial(ref) {
  if (ref.type !== "rpc") throw new Error("not dialable");
  // build (or reuse, cached by content) the worker; get the named entrypoint, passing props:
  const worker = loadWorker(ref.worker); // Worker Loader: same source content → same isolate
  return worker.getEntrypoint(ref.entrypoint, { props: ref.props }); // a PathCallable
}
```

The entrypoint's `props` arrive as `this.ctx.props` (that's how `OpenApiClient` above gets its `{ specUrl }`). `loadWorker` caches the built isolate by content, so dialing two refs with the same source shares one isolate; different content builds a new one. `ref.worker.type` is `"source"` here, but also `"binding"` (an env binding like AI), `"loopback"` (a first-party entrypoint), or `"durable-object"` — the core only knows "ref → `PathCallable` via the injected `dial`." (The runnable `steps/09-dial` exercises this over the real Worker Loader.)

### 🚧 Why this isn't enough yet

If the registry is just a `Map` in memory, it dies with the DO anyway — even the sturdy refs. We need the registry itself to be durable.

---

## Step 8 — A context is just a durable event log

> **the one new idea** — stop thinking of the registry as a thing you mutate. It's a **durable event log** you _fold_. You don't keep a mutable table at all; you write the event **schemas** and a **reducer**, and the table is `events.reduce(reduce, initial)`. Provide/revoke append events; the table is derived; replaying the log reproduces it exactly — no hidden durable state.

Because it's an event log, the honest thing to write down is the **schema of the events** — and that reads cleanly. This is the real contract from the runnable [`itx-contract.ts`](./itx-contract.ts), defined with the platform's own `defineProcessorContract` (the workshop _depends_ on the platform streams engine (now in apps/os/src/domains/streams), it doesn't reimplement it):

```ts
export const ItxContract = defineProcessorContract({
  slug: "itx",
  // State is a PLAIN OBJECT — the processor checkpoints and validates it against
  // this schema. (A Map can't be the reduced state.) The table is derived, never
  // the source.
  stateSchema: z.object({
    capabilities: z.record(z.string(), CapabilityRecord).default({}),
    context: ContextRecord.nullable().default(null), // name + parent (the chain link)
  }),
  events: {
    "events.iterate.com/itx/capability-provided": {
      payloadSchema: z.looseObject({
        path: z.array(z.string()),
        kind: z.enum(["live", "rpc"]),
        address: CapabilityAddress.nullable().optional(), // sturdy caps only
      }),
    },
    "events.iterate.com/itx/capability-revoked": { payloadSchema: z.looseObject({ path: z.array(z.string()) }) },
    "events.iterate.com/itx/context-created": { payloadSchema: /* name + parent */ },
  },
});
```

The fold is then just a `switch` returning the next **plain object**:

```ts
reduce({ event, state }) {
  switch (event.type) {
    case "…/capability-provided": {
      const name = event.payload.path.join(".");
      return { ...state, capabilities: { ...state.capabilities, [name]: row(event.payload) } };
    }
    case "…/capability-revoked": {
      const { [event.payload.path.join(".")]: _gone, ...rest } = state.capabilities;
      return { ...state, capabilities: rest };
    }
    default: return state; // an event we don't consume leaves state untouched
  }
}
```

Last-write-wins, revoke removes, replay is deterministic — the table is never the source of truth, the log is. Note what the fold does _not_ hold: a `live` cap's event records `kind: "live"` with `address: null` — you can't serialize a socket, so the actual stub lives in an in-memory bridge map keyed by name (Step 4). That's precisely why a live cap dies on eviction and a sturdy ref (which folds to a serializable `address`) survives.

So the Step-4 "bridge" and this "fold" are two views of one picture: the **log** is the source of truth for everything _durable_ (which names exist, each one's kind, and sturdy `address`es), while the **bridge map** holds the _ephemeral_ live stubs beside it. "No hidden state" means nothing durable hides outside the fold; the live stubs are deliberately non-durable, which is the whole live-vs-sturdy distinction. (Proven over real workerd in the harness's Step 8/10: `rebuildFromLog` replays the durable log into a brand-new processor and rebuilds the identical table.)

### 🚧 Why this isn't enough yet

A context wants the platform's defaults (`fetch`, `ai`, `secrets`) — and to build on the capabilities of a context it sits under, without re-providing them all. We need contexts to **inherit** from a base context (Step 9 calls that base the **parent**).

---

## Step 9 — the context chain: a parent for resolution

> **the one new idea** — a context is born with a **parent**. On a capability **miss**, resolution falls through to the parent (recursively). A child **shadow** wins over the parent — child capabilities shadow parent ones the same way a deeper path shadowed a shallower one in Step 6, now up the chain. (No OOP "extend"/"super" — just a parent the constructor is handed.)

```ts
invoke({ path, args }) {
  const hit = findCapabilityByPath({ caps: this.#caps, path });
  if (hit) return invokeCapabilityAtPath({ capability: hit.capability, path: hit.rest, args }); // self wins
  if (this.parent) return this.parent.invoke({ path, args }); // miss → resolve against the parent
  throw new Error(`no capability "${path.join(".")}"`);
}
```

A child provides `slack`; the parent provides `fetch` and `ai`. The child sees all three; if the child also provides `fetch`, its version shadows the parent's. The chain bottoms out at a code-rooted, read-only platform context whose defaults are loopback refs — so they update the instant you deploy. That root is **Step 12**.

### 🎯 Nothing breaks — this is the punchline

Everything we've built (provide/revoke as events, a folded table, read-your-writes, a stream that replays) is exactly a **stream processor**.

---

## Step 10 — Itx _is_ a StreamProcessor (for real)

> **the punchline** — Step 8's "fold a durable event log" already _is_ a `StreamProcessor`. So `Itx extends StreamProcessor<ItxContract>` — the **real** base class from the platform streams engine (now in apps/os/src/domains/streams). We override one pure method, `reduce` (the fold), and add the verbs. The stream's subscription (Step 7's wiring) delivers appended events into `ingest`, which folds them and advances the checkpoint; `state` is the fold; replay rebuilds it. Read-your-writes is then just: append, wait for the stream to deliver it back, read.

This is the real class, from the runnable [`itx-processor.ts`](./itx-processor.ts) — it extends the actual `StreamProcessor` base class, not a stand-in:

```ts
import { StreamProcessor } from "@iterate-com/os/src/domains/streams/engine/stream-processor.ts";

export class Itx extends StreamProcessor<typeof ItxContract> {
  readonly contract = ItxContract;
  #liveCapabilities = new Map(); // the Step-4 bridge: name → live stub (in-memory, NOT durable)

  // the fold (Step 8) — one pure projection of an event into the next state:
  reduce({ event, state }) {
    /* the switch from Step 8 */
  }

  // provide = append an event (the live stub also lands in the bridge). There is
  // NO second write path: the event flows out to the stream, and the stream's
  // subscription delivers it back into the fold. We just wait for that delivery so
  // the write is readable — read-your-writes, with the stream as the only source.
  async provideCapability({ path, capability, instructions }) {
    const kind = isCapabilityAddress(capability) ? "rpc" : "live";
    if (kind === "live") this.#liveCapabilities.set(path.join("."), capability);
    const committed = await this.ctx.stream.append({
      event: {
        type: "…/capability-provided",
        payload: { path, kind, address: kind === "rpc" ? capability : null, instructions },
      },
    });
    await this.awaitDelivered(committed.offset); // the subscription folds it in
  }

  async invoke({ path, args }) {
    const hit = resolveLongestPrefix(this.state.capabilities, path); // resolve over the fold
    if (!hit) throw new Error(`no capability "${path.join(".")}"`);
    const target =
      hit.record.kind === "live"
        ? this.#liveCapabilities.get(hit.name)
        : this.dial(hit.record.address);
    return replayPath(target, hit.rest, args);
  }
}
```

### Built-in capabilities are injected at construction, not appended

`fetch`/`streams`/`ai` are not special-cased in a handle — but they're also _not_ provided as events on every context's stream. Appending a `capability-provided` for each one would mean rewriting thousands of streams (one per project) every time we change what the built-ins are. Instead the `Itx` StreamProcessor takes its **built-in capabilities as a constructor argument** — an **array of capability descriptors in the exact same `{ path, capability, instructions? }` shape as a `provideCapability` call** (a built-in is just a capability pre-provided in code instead of via an event). The host wires them in when it builds the context, `invoke` falls back to them on a miss (after the fold, before the parent), and they appear in `describe` so they're self-describing.

```ts
// the host builds a context with its built-in capabilities wired in — no events appended.
// They come from the DOMAIN object the context is scoped to: a project context's from
// the `Project` DO (its `fetch`/egress), an agent context's from the `Agent` DO (its own
// `whoami`). The host picks by coordinate (Step 9 — both are real DOs in the toy):
new Itx({
  ...deps,
  builtinCapabilities: isAgent
    ? Agent.builtinCapabilities(env.AGENT.getByName(agentCoordinate)) // e.g. whoami
    : Project.builtinCapabilities(env.PROJECT.getByName(projectId)), // e.g. fetch (egress)
});
// invoke resolution order: own fold (provides) → built-in capabilities → parent (Step 10).
// So an agent sees its OWN whoami AND the project's fetch — inherited by climbing the chain.
```

Changing a built-in is then a **code change** — re-injected on the next boot — not a stream rewrite. The cost is honest: a built-in isn't in the durable fold, and if you've already told an agent what capabilities it has, changing them still means updating what you told it; but you never rewrite the logs. (Step 11's chain — project → agent — decides which context gets which built-ins; a child inherits the parent's by climbing on a miss.)

### Where it actually runs

This actually runs. The workshop's `server.ts` has **one** `ItxDO` — a Durable Object that hosts this exact `Itx` processor and backs it with the real `Stream` Durable Object from the platform streams engine (now in apps/os/src/domains/streams) as its durable event log (the DO is named by its context coordinate; the log is a stream at that coordinate). Every step from 2 on — provide/invoke, the live cross-client rendezvous, the deep Slack path, and Step 8/10's provide → fold → invoke → revoke → `rebuildFromLog` (replay the durable log into a fresh processor → identical table) — is driven over real workerd by `harness.ts`. Production is the same shape with more around it: `apps/os/src/itx/itx-durable-object.ts` is the host, `apps/os/src/domains/streams/engine/workers/durable-objects/stream.ts` is the log, plus the chain/dial/coordinates of Step 11.

The whole thing is one idea seen from a few angles: a name → a stub or an address, a table that is the fold of the context's durable event log, a server-side proxy that makes calling it feel native, paths that mount whole SDKs and shadow deep, borrow-or-dial, and a climb to the parent on a miss.

---

## Step 11 — the platform layers (built incrementally in `steps/`)

> The steps above derive the _core_. The platform layers that make it a real, multi-tenant system are built as **runnable step folders** ([`steps/README.md`](./steps/README.md)), each with an intent test green over real workerd. (The `steps/NN` names below are the runnable build's **own** sequence — they don't line up one-to-one with these prose step numbers; see the crosswalk in `steps/README.md`.)

- [x] **A context is a project id + a path.** That's the whole identity — `<projectId>/<path>` names the context, the host DO, and the dial address. `prj:<id>` is the **project itx**; `prj:<id>/agents/<name>` is an **agent itx** under it; nest freely. No separate "session" or "namespace" — those are just paths.
- [x] **Auth & access** ([`steps/08-auth`](./steps/08-auth)) — a bearer token names a principal → the projects it may access → an itx scoped to one project; others refused at the door.
- [x] **dial / code-loading** ([`steps/09-dial`](./steps/09-dial)) — a sturdy ref is restored by **building + running its worker** via the Worker Loader (`env.LOADER`), `props` → `this.ctx.props`.
- [x] **Project & Agent DOs + built-ins** ([`steps/10-project-fetch`](./steps/10-project-fetch)) — a **`Project extends DurableObject`** owns egress, provided to a project context as the `fetch` root; an **`Agent extends DurableObject`** under it owns its identity, provided to an agent context as `whoami`. The toy ships both so the project↔agent picture is concrete and runnable.
- [x] **The context chain** ([`steps/11-chain`](./steps/11-chain)) — a context records its **parent as data** (`{ ref, address }`) in the birth certificate; on a miss the core **dials that address with the same `dial` as a capability** and climbs (an agent's parent is its project — a DO-backed `{ type: "context" }`; a project's parent is the global root — a code `{ type: "code" }`). A child shadow wins (late binding). A parent is just an itx provided at the fallback slot: the only thing that sets it apart from a capability is the call — the whole path is re-dispatched into the parent's `invoke` (recurse), not replayed onto a leaf. (Production splits the dialer in two — gated for provider-supplied capability addresses, ungated for trusted context refs; the toy is unauthed, so one dial. Auth comes later.)
- [x] **Codemode** ([`steps/12-codemode`](./steps/12-codemode)) — `script-execution-requested`/`-completed`; run an `async (itx) => …` program in a loaded isolate with the context's itx in scope.
- [x] **Root capabilities are injected at construction** — passed to the `Itx` constructor (e.g. `itx.fetch`), not special-cased in a handle and not appended as events; `invoke` falls back to them, own provides shadow them, and they're surfaced in `describe`.
- [x] **The platform capability root above the project** ([`steps/13-platform-root`](./steps/13-platform-root)) — every project context's parent is a code-rooted, read-only root; see Step 12.

---

## Step 12 — the platform capability root: the top of the chain

> **the last layer** — the chain (Step 9) bottoms out somewhere. That somewhere is a **stateless, read-only context** that is every project context's parent. It is the one context that is **not** a Durable Object and **not** a StreamProcessor.

There is no stream to fold and nothing to persist, so the root is just
**constructed in code**, per connection, and answers the **same itx protocol**
(`invoke` / `describe`) as any context. Two properties make it _the root_:

- **Read-only.** `provideCapability` / `revokeCapability` throw. You cannot
  append to a context that has no log — so "you cannot provide into the root" is
  _structural_, not a guard someone remembers to write.
- **Top of the chain.** It has no parent, so `super` throws; and you cannot
  branch a child off the root, so `extend` throws.

Its capabilities are fixed, project-agnostic **catalog** caps, wired in as code —
here a single `projects` (a `{ list, get }`): `list()` the projects you can
reach, `get(id)` to narrow into one. A sibling (`users`, `orgs`, …) is just
another entry — which is the whole reason the catalog rides the **capability
protocol** rather than being bespoke handle code.

```ts
// the root is a plain object — no DO, no stream, no fold. A project records it as
// its parent in the birth certificate (a `{ type: "code" }` address); on a miss
// the project's core dials that address and climbs here (Step 9/11), so the
// catalog is reachable from inside any project. The dialer constructs it inline —
// being stateless is exactly what lets you build it anywhere (which is why it
// needs no DO).
class GlobalContext {
  #capabilities = {
    projects: {
      list: () => this.#reachableProjectIds(), // scoped to the principal's access
      get: (id) => ({ id, ref: `prj:${id}` }), // narrows to a project context
    },
  };
  // same dispatch as the StreamProcessor: longest registered prefix wins, then
  // replay the rest of the path onto the cap. The root has no parent — the chain
  // bottoms out here, so a miss is a hard error rather than another climb.
  async invoke({ path, args }) {
    const hit = resolveLongestPrefix(this.#capabilities, path);
    if (hit) return replayPath(hit.record, hit.rest, args);
    throw new Error(`no capability "${path.join(".")}" (the root is the top of the chain)`);
  }
  // structurally read-only, and structurally the top:
  async provideCapability() {
    throw new Error("the root is stateless and read-only");
  }
  async super() {
    throw new Error("the root is the top of the chain — no super");
  }
  async extend() {
    throw new Error("you cannot extend the root");
  }
}
```

This runs: [`steps/13-platform-root`](./steps/13-platform-root) opens the root
(scoped to a principal's access), proves `projects.list/get` resolve, proves
`provideCapability` / `super` / `extend` all throw, and proves a **project
context climbs to it on a miss** — the chain bottoms out at the global root.

Production serves this from a **named worker entrypoint** dialed as a loopback
(alongside the per-project _defaults_ context that supplies `fetch`/`ai`/`streams`
— those are project-scoped, so they live one rung _below_ the global root, not on
it); `projects.get` narrows to a live project itx **handle**, and `list` is
access-scoped at the connect door. The toy keeps the shape — a code-rooted,
read-only context at the top of the chain whose catalog is capabilities — and
drops the rest.

---

## Step 13 — client libraries 🚧 TODO (skeleton)

> the ergonomics each runtime gets on top of the naked stub.

- [x] **Runtime-specific `withItx` disposable** — built: [`client.ts`](./client.ts) exports `withItx({ baseUrl, context })`, the Node entry point that opens the session and returns the bare, Disposable stub (`using itx = withItx(...)` closes the socket at scope end). The harness drives every itx step through it. It mirrors production's `apps/os/src/itx/client.ts` minus auth (Step 11). _(Browser variant still TODO — same `/itx` endpoint.)_
- [ ] **React libraries** — hooks/components for consuming itx from React (e.g. a `useItx`-style surface), matching `apps/os/src/itx/use-itx.ts`. _(TODO.)_

---

## Recap — what the small core actually is

The test for "core vs addendum": **does removing it change what `reduce` computes, or what a live stub vs an address means?** If no, it's an addendum item.

The **name** column is the real identifier in `apps/os/src/itx/*` — a few are the production spelling of concepts we built above under plainer names: `#borrow` is the live-vs-address dispatch inside our `invokeCapabilityAtPath`; `PathProxy` is the server-side dynamic proxy from Step 6; `resolveLongestProvidedPrefix` is our `findCapabilityByPath`. (We use `invoke` for both the verb and the `invoke({ path, args })` convention; production keeps them distinct — `invoke` the verb, `call` the convention — but we avoid `call` to dodge the `Function.prototype.call` clash.)

| Piece                                            | name                                                            | ~lines |
| ------------------------------------------------ | --------------------------------------------------------------- | ------ |
| The fold (single source of truth)                | `reduceItxEvent`                                                | ~60    |
| live-vs-ref discriminator                        | `isCapabilityAddress`                                           | ~25    |
| The one write path                               | `provide` / `revoke`                                            | ~80    |
| Borrow-or-dial + the dial type                   | `#borrow`                                                       | ~30    |
| Dispatch + chain delegation                      | `invoke`                                                        | ~40    |
| Server-side path proxy + longest-prefix + replay | `PathProxy` / `resolveLongestProvidedPrefix` / `replayPathCall` | ~50    |
| Chain-merged, shadow-aware view                  | `describe` / `extend` / `super`                                 | ~45    |
| Write/consume seam (read-your-writes)            | `#append` / `#catchUp` / `#materialize`                         | ~50    |

---

## Addendum — everything we layered on, and why

All real, all in the actual files; none of it changes the inner model. Each entry is the concrete failure it buys you out of. (Two of these — **origin threading** and **dial's injected props** — are quietly load-bearing for Steps 9 and 10 as written; they live here only to keep those steps uncluttered.)

- **Two RPC systems — Cap'n Web pipelines paths, Workers RPC doesn't.** Cap'n Web pipelines a whole dotted path from a naked stub into one call (so `itx.slack.chat.postMessage(…)` needs no client proxy; the server-side dynamic proxy only has to answer `Object.hasOwn` per segment via its `getOwnPropertyDescriptor` trap). Workers RPC (the DO stub, the dialed parent) does _not_ pipeline through property accesses — which is why the DO exposes its core via an `itx()` method and why `itx.project.processor.snapshot()` is made to work by `replayPathCall` awaiting each segment server-side.

- **The server-side proxy's sharp edges** — `then` reads as `undefined` (so a path node is never mistaken for a thenable), and protocol-level segments (`__proto__`, `apply`, `call`, `dup`, Cap'n Web stub controls) are refused on intermediate nodes — the same reserved set guards both the proxy and `replayPathCall`.

- **Live-stub retention** — `dup()` provided stubs (deep-walk plain-object providers). A live provider going away isn't a special event: the durable row still shows in `describe()` (`kind: "live"`), and `invoke` just fails because the in-memory bridge has no stub — you `revokeCapability` to remove the row. (Production records a `capability-disconnected` event; the toy doesn't bother.)

- **The handle is more than the proxy** — today's `ItxHandle` also carries built-ins (`projects`, `streams`, `fetch`, `extend`, `super`) that don't fall through to `invoke`, plus reserved-name gating; it's what the Worker serves (a thin wrapper dialing the DO node's `itx()`). 🔄 **we want to change this** — those shouldn't be privileged names baked into a handle; they're **built-in capabilities** handed to the `Itx` constructor by whoever builds the context (Step 10), resolved as an `invoke` fallback. No special handle.

- **The ref taxonomy and dial's reach** — beyond `source`, a ref's `worker` can be `binding`, `loopback`, or `durable-object`; `dial` handles Worker-Loader isolate caching (by content, per origin), facets, and allowlists.

- **Dial allowlists & spoof-proofing** — reach is gated at _invoke_ time, not provide time; every dialed capability gets injected props (`capabilityPath`, `context`, `projectId`) that overwrite caller-supplied ones.

- **A context _is_ its stream coordinate** — identity is a **project id + a path** (`<projectId>/<path>`), also the host DO's name and dial address; no synthetic ids, no directory table.

- **Hibernation, deferred** — the session terminates in the stateless Worker; the DO exposes the `Itx` via `itx()`. Positions us to adopt capnweb hibernation later.

- **`fetch` as a shadowable capability** — egress is a default `fetch` cap; bare `fetch()` in loaded isolates and `itx.fetch()` both route through it; a live shadow on a child intercepts both; secret placeholders are substituted outside the isolate.

- **Origin threading** — `invoke` carries `origin: { ref, address }` so an inherited cap's bare `fetch()` dials back through the _originating_ context's chain.

- **Read-your-writes hardening** — `#catchUp` loops a single-flight sync until one that started at/after the current append count completes, surviving concurrent writers.

- **Script execution (codemode)** — a capability can be a whole script; `script-execution-requested`/`-completed` events run an `async (itx) => …` program in a loaded isolate.

- **Access non-escalation & the platform defaults root** — a project handle's access is exactly its own project; the chain bottoms out at a code-rooted read-only platform context.

---

_ground truth: `apps/os/src/itx/{itx,handle,path-proxy,dial,coordinates,entrypoint,contract,types,itx-durable-object,fetch}.ts` · `apps/os/src/domains/streams/engine/stream-processor.ts`. Runnable in this folder, all over real workerd via `server.ts` + `harness.ts`: Steps 0–6 (incl. `itx.slack.chat.postMessage` on a naked stub into the real `@slack/web-api` client) and Steps 8/10 (one `ItxDO` hosting `Itx extends StreamProcessor` from `itx-contract.ts` + `itx-processor.ts`, backed by the real the platform `Stream` DO as its durable event log). Also `min-dynamic-target.mjs` (the server-side dynamic proxy, in isolation); `validate-steps.mjs` (model checks for Steps 7–10); `dialog.swift` (the Step 1 native dialog — really runs, `npm run proof:swift`)._
