# Build the Iterate Context, one capability at a time

Grow the platform from nothing but capnweb into the full streaming, hibernatable
Iterate Context. Each chapter ends with something you can call, and each exists
because the last one left something on the table. Every snippet is real code —
and the whole client dependency is one npm package, `@iterate-com/capnweb`
(imported as `capnweb`). There is no client SDK: a client is just a capnweb peer.

There are exactly **three primitives** — the **context** (capabilities, called
in both directions), **fetch** (in both directions), and the **stream** — and
then everything else is composition on top. You'll meet them twice: **Part 0
builds the whole platform, brick by brick, in one small `worker.ts` (~200 lines of code)** — v0
of every concept in about 30 minutes, each brick's flaw forcing the next. Then
Chapters 1–3 rebuild each primitive properly, against the real thing.

---

## Part 0 — the whole platform in ~200 lines

One file, grown eight times. Set up once — a fresh directory with
`npm i capnweb@npm:@iterate-com/capnweb wrangler` and this `wrangler.jsonc`
(the bindings activate as the bricks land):

```jsonc
{
  "name": "part0",
  "main": "worker.ts",
  "compatibility_date": "2026-07-01",
  "worker_loaders": [{ "binding": "LOADER" }],
  "durable_objects": {
    "bindings": [{ "name": "CONTEXT", "class_name": "IterateContextDurableObject" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["IterateContextDurableObject"] }],
  "vars": { "OPENAI_API_KEY": "sk-test-12345" },
}
```

`npx wrangler types` once (it generates `worker-configuration.d.ts` — the Env
AND `ctx.exports` typings, straight from the config; no `@cloudflare/workers-types`
package, no casts), then `wrangler dev`, and go.

### Brick 1 — capnweb, and immediately what makes it different

Plain method calls you expect. What you don't expect: whole `Request`/`Response`
objects riding the wire as values, and the client handing the **server** a
function to call back.

```ts
// worker.ts
import { newWorkersRpcResponse, RpcTarget, type RpcStub } from "capnweb";

export class IterateContext extends RpcTarget {
  whoami() {
    return { hello: "world" };
  }

  // A real Request arrives, a real Response returns — both serialize over the wire.
  fetch(request: Request): Response {
    return new Response(`hello ${new URL(request.url).pathname}`);
  }

  // The client passes a FUNCTION; the server calls it back later. capnweb disposes
  // parameter stubs when the call returns — dup() keeps our own reference alive.
  callMeLater(ms: number, callback: RpcStub<(note: string) => unknown>) {
    const kept = callback.dup();
    setTimeout(async () => {
      await kept("the server, calling you back");
      kept[Symbol.dispose]();
    }, ms);
    return "scheduled";
  }
}

export default {
  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api") return newWorkersRpcResponse(request, new IterateContext());
    return new Response("not found", { status: 404 });
  },
};
```

```ts
// runs: any Node script (bare node)
import { newWebSocketRpcSession } from "capnweb";

const itx = newWebSocketRpcSession<IterateContext>("ws://localhost:8787/api");

await itx.whoami(); // { hello: "world" }
const res = await itx.fetch(new Request("https://x/ping")); // a real Response
await res.text(); // "hello /ping"

const { promise: calledBack, resolve } = Promise.withResolvers<string>();
console.log(await itx.callMeLater(1500, resolve)); // "scheduled" — immediately
console.log(await calledBack); // "the server, calling you back"
itx[Symbol.dispose](); // hang up — the open socket is what keeps node alive
```

That callback is the whole platform in embryo: **a capability flowed from the
client to the server, and the server called it.** And the snippet's last three
lines are the two lifetime rules, measured rather than assumed:

- Server-side, the `dup()`: capnweb disposes parameter stubs when the call
  returns, so keeping one past the return means duplicating it — you'll meet
  the same rule again two bricks from now.
- Client-side, the `await`-then-hang-up: the `await` is there because disposing
  tears the whole session down immediately — skip it and the pending callback
  dies in flight, nothing ever arrives (proven). The explicit
  `itx[Symbol.dispose]()` is there because _nothing else ever closes the
  socket_ — not even the server releasing every stub it holds — and the open
  WebSocket is exactly what keeps a Node process alive; without the hang-up the
  script sits forever.

(Why not `using itx = ...`? It's the right idea — and on today's bare Node 24
it's a measured trap: V8's native explicit-resource-management _silently skips_
the session's disposal in `await`-bearing scopes, so the script hangs anyway;
the same file under a transpiler disposes fine. Until that bug dies, the
tutorial spells the hang-up explicitly.)

### Brick 2 — provide, and the dispatch walker

If the server can hold a client's function, clients can _publish_ them — under
names:

```ts
const capabilities = new Map<string, unknown>();

// inside IterateContext:
  provide(path: string, target: RpcStub<object>) {
    capabilities.set(path, target.dup()); // same rule as callMeLater: keep our own
  }

  // The dispatch walker: longest provided prefix, then walk the remaining dotted
  // segments, then apply the args.
  invokeCapability(path: string, args: unknown[] = []) {
    const segments = path.split(".");
    for (let i = segments.length; i > 0; i--) {
      let target = capabilities.get(segments.slice(0, i).join("."));
      if (target === undefined) continue;
      let parent: unknown;
      for (const segment of segments.slice(i))
        [parent, target] = [target, (target as Record<string, unknown>)[segment]];
      return Reflect.apply(target as (...a: unknown[]) => unknown, parent, args);
    }
    throw new Error(`nothing provided at ${path}`);
  }
```

Provide `itx.double`, call it back through the walker — works. Now open a
**second** session and call it from there:

```
Error: Cannot perform I/O on behalf of a different request. I/O objects (such as
streams, request/response bodies, and others) created in the context of one
request handler cannot be accessed from a different request's handler.
```

That error is the flaw, and it's a deep one: workerd pins every session's I/O to
its own request context — a raw stub in a shared `Map` can only ever be touched
from home. Capabilities need somewhere to _live_, and the stub needs to be
**loaned**, not shared.

### Brick 3 — the Durable Object simply holds the stubs

The home is a **Durable Object** — one per context. The `Map` and the walker
move in, and the stub is _loaned_ across Workers RPC: `dup()` it, pass it as a
plain argument, and calls on the loaned stub **route back to the provider's own
session** — from any caller. Brick 2's error dissolves. No WebSockets anywhere:

```ts
type Env = { CONTEXT: DurableObjectNamespace<IterateContextDurableObject> };

// Walk remaining dotted segments on a target, then apply the args.
const applyPath = (target: unknown, tail: string[], args: unknown[]) => {
  let parent: unknown;
  for (const segment of tail) [parent, target] = [target, (target as Record<string, unknown>)[segment]];
  return Reflect.apply(target as (...a: unknown[]) => unknown, parent, args);
};

// the edge IterateContext now proxies (constructor takes env; #context() = getByName):
  // The stub is LOANED across Workers RPC into the DO. Both hops dispose params at
  // return — the edge dups before passing, the DO dups what it holds.
  async provide(path: string, target: RpcStub<object>) {
    await this.#context().provide(path, target.dup());
  }

  invokeCapability(path: string, args: unknown[] = []) { return this.#context().invoke(path, args); }
```

```ts
// The live-stub table: each provided stub, loaned across Workers RPC, held by path.
class RpcStubDirectory {
  #heldStubs = new Map<string, RpcStub<object>>();

  hold(path: string, stub: RpcStub<object>) {
    this.#heldStubs.set(path, stub.dup()); // Workers RPC disposes params at return too
  }

  has(path: string) {
    return this.#heldStubs.has(path);
  }

  invoke(path: string, segments: string[], args: unknown[]) {
    return applyPath(this.#heldStubs.get(path)!, segments, args);
  }
}

export class IterateContextDurableObject extends DurableObject<Env> {
  #rpcStubs = new RpcStubDirectory();

  provide(path: string, target: RpcStub<object>) {
    this.#rpcStubs.hold(path, target);
  }

  // The dispatch walker: longest mounted prefix, then the tail, then the args.
  invoke(path: string, args: unknown[] = []) {
    const segments = path.split(".");
    for (let i = segments.length; i > 0; i--) {
      const prefix = segments.slice(0, i).join(".");
      const tail = segments.slice(i);
      if (this.#rpcStubs.has(prefix)) return this.#rpcStubs.invoke(prefix, tail, args);
    }
    throw new Error(`nothing provided at ${path}`);
  }
}
```

Session B calling session A's `itx.double` returns `42` now — and when session A
disconnects, the loan dies with the lender: further calls reject with
`The execution context which hosts this callback is no longer running.`

The flaw here isn't correctness — it's economics, and it's the real platform's
own measured wall: **a held live stub is an active reference, and a DO holding
one can never be evicted.** A thousand idle providers pin a thousand Durable
Objects awake, billed around the clock. Hibernatable WebSockets are the one
channel that survives eviction — which is exactly the next brick.

### Brick 4 — hibernation: the pager arrives, behind the same API

Swap the transport, keep the surface. Instead of holding the stub, the DO holds
a **hibernatable WebSocket** per provided capability — a pager — and the
provider's edge session serves the calls from where the stub legally lives:

```ts
type IterateContextDurableObjectStub = DurableObjectStub<IterateContextDurableObject>;

// Park a live capnweb stub behind the DO's pager: dup it (capnweb disposes params at
// return), open the stub-pager WebSocket for its path, answer every call request.
// (v0 carries calls ON the pager; the real relay's pager only says "send me a stub".)
async function startRpcStubRelay(
  context: IterateContextDurableObjectStub, provider: RpcStub<object>, path: string) {
  const live = provider.dup();
  const upgrade = { headers: { Upgrade: "websocket" } };
  const socket = (await context.fetch(`http://do/pager?path=${path}`, upgrade)).webSocket!;
  socket.accept();
  socket.addEventListener("message", async (m) => {
    const { id, tail, args } = JSON.parse(m.data as string);
    const reply = await Promise.resolve()
      .then(async () => ({ id, result: await applyPath(live, tail, args) }))
      .catch((e) => ({ id, error: String(e?.message ?? e) }));
    socket.send(JSON.stringify(reply));
  });
}

// the edge provide swaps ONE body line:
  // A live stub can't be held by a hibernating DO — an active reference pins it
  // awake — so its relay parks it HERE and serves it over the pager.
  async provide(path: string, target: RpcStub<object>) {
    await startRpcStubRelay(this.#context(), target, path);
  }
```

```ts
// The live-transport table: hibernatable pager sockets by path + the call/reply
// bookkeeping over them. Everything it needs from its DO arrives through deps.
class RpcStubDirectory {
  #hibernatablePagerWebSockets = new Map<string, WebSocket>();
  #replies = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  #nextCallId = 0;
  constructor(private deps: { acceptWebSocket: (ws: WebSocket) => void }) {} // HIBERNATABLE accept

  // The pager door: answer the stub-pager WebSocket upgrade for a path, else null.
  fetch(request: Request): Response | null {
    const url = new URL(request.url);
    if (url.pathname !== "/pager") return null;
    const path = url.searchParams.get("path")!;
    const pair = new WebSocketPair();
    this.deps.acceptWebSocket(pair[0]);
    this.#hibernatablePagerWebSockets.set(path, pair[0]);
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  // Replies come back through the DO's webSocketMessage — route them by call id.
  webSocketMessage(message: string) {
    const { id, result, error } = JSON.parse(message);
    if (error !== undefined) this.#replies.get(id)?.reject(new Error(error));
    else this.#replies.get(id)?.resolve(result);
  }

  has(path: string) { return this.#hibernatablePagerWebSockets.has(path); }

  invoke(path: string, segments: string[], args: unknown[]) {
    const id = this.#nextCallId++;
    return new Promise((resolve, reject) => {
      this.#replies.set(id, { resolve, reject });
      this.#hibernatablePagerWebSockets.get(path)!.send(JSON.stringify({ id, tail: segments, args }));
    });
  }
}

// the DO:
  #rpcStubs = new RpcStubDirectory({ acceptWebSocket: (ws) => this.ctx.acceptWebSocket(ws) });

  // workerd routes these by their EXACT names: a WebSocket upgrade must arrive
  // through a DO method literally named fetch (here it accepts the hibernatable
  // pager sockets), and traffic on those sockets lands on webSocketMessage.
  fetch(request: Request) {
    return this.#rpcStubs.fetch(request) ?? new Response("not found", { status: 404 });
  }
  webSocketMessage(_ws: WebSocket, message: ArrayBuffer | string) {
    this.#rpcStubs.webSocketMessage(String(message));
  }
```

Now look at what **didn't** change: `has(path)` and
`invoke(path, segments, args)` keep their exact signatures, the DO's walker is
untouched, and the proof client for this brick is brick 3's, verbatim. The
transport swapped underneath a stable API — that IS the design lesson, and it's
why the real platform could build hibernation without rewriting dispatch. The
prefix-match stays DO-side; the tail-walk moved to the providing edge, riding
the pager frame.

### Brick 5 — run code in the context of the context

Execution is an _edge_ concern first — the RpcTarget grows a loader, and (the
apps/os pattern) its constructor takes the execution context, because that is
where the loopback bindings live:

```ts
// Env gains LOADER: WorkerLoader; the router now passes ctx through.
export class IterateContext extends RpcTarget {
  // The execution context rides along for ctx.exports — the loopback bindings
  // runScript's loader needs (apps/os holds it the same way).
  constructor(
    private env: Env,
    private ctx: ExecutionContext,
  ) {
    super();
  }

  runScript(code: string, ...args: unknown[]) {
    return applyPath(this.#load(code), ["run"], args);
  }

  // Load code into a fresh confined isolate; its env.ITX loops back into this context.
  #load(code: string) {
    return this.env.LOADER.get(code, () => ({
      compatibilityDate: "2026-07-01",
      mainModule: "script.js",
      modules: { "script.js": code },
      env: { ITX: this.ctx.exports.ItxEntrypoint({ props: {} }) },
    })).getEntrypoint();
  }
}

// What a loaded worker's env.ITX points at: get() hands back the same scope.
export class ItxEntrypoint extends WorkerEntrypoint<Env> {
  get() {
    return new IterateContext(this.env, this.ctx);
  }
}
```

(No cast on `ctx.exports` — `wrangler types` generates the whole loopback
typing, `ItxEntrypoint({ props })` included. The DO is untouched in this brick;
execution stays edge-side until mounts need it.)

The proof closes a beautiful loop — a script, running _inside_ the context,
calls back out through the walker and the pager to the same client's own
provided function (uploaded code is plain JS — no transpile):

```js
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async run(x) {
    const itx = await this.env.ITX.get();
    return await itx.invokeCapability("itx.double", [x]);
  }
}
```

`await itx.runScript(script, 21)` → `42`, having transited client → loader →
`env.ITX` → walker → pager → client.

### Brick 6 — durable mounts

A live capability is a phone line. For something that should _keep existing_,
mount the code itself — a string target is stored, and the walker loads it on
demand. The mount table lives beside the directory:

```ts
// the edge provide grows one branch (and `| string` in its signature):
    if (typeof target === "string") return this.#context().provide(path, target);

// the DO gains its second table, its own loader, and a provide:
  #mounts = new Map<string, string>(); // the durable-mount table

  provide(path: string, target: string) { this.#mounts.set(path, target); }

  // Mounts resolve where the walker runs — the same loader door, DO-side
  // (DurableObjectState carries typed ctx.exports too).
  #load(code: string) { /* identical body to the edge's */ }

// and the walker gains its durable branch, after the live check:
      const mounted = this.#mounts.get(prefix);
      if (mounted !== undefined) return applyPath(this.#load(mounted), tail, args);
```

(Live-before-durable at each prefix length means a live provide at a mounted
path wins while connected — reconnect-friendly by accident of ordering.)

The proof is the beat that teaches live-vs-durable in ten seconds: mount a
greeter as a string, provide `itx.double` live, then **kill the providing
session**. The mounted code still answers; the live capability rejects with
`Peer closed WebSocket: 3000 RPC session was shut down`. Live dies with its
provider; code doesn't.

### Brick 7 — fetch, in both directions

Outbound: brick 1's hello `fetch` gets its UPGRADE — the same method, now a real
outbound fetch _through_ the context, substituting secrets in flight so clients
compose requests to APIs whose keys they can't read:

```ts
// A secret is looked up by the NAME written in the sentinel — a dynamic read the
// static Env type can't express, so this is the file's one deliberate widening.
const secretFromEnv = (env: Env, name: string) =>
  String((env as unknown as Record<string, string>)[name]);

  // Brick 7 upgraded brick 1's hello Response into the real outbound fetch: egress
  // goes THROUGH the context, and {{secret:NAME}} becomes env.NAME in flight.
  fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    for (const [name, value] of headers)
      headers.set(name, value.replace(/\{\{secret:(\w+)\}\}/g, (_, secret) =>
        secretFromEnv(this.env, secret)));
    return fetch(new Request(request, { headers }));
  }
```

(Sync `replace` is right _here_ because the secrets are env vars; the moment the
lookup is async — a KV store — you must `await` the substitution before
fetching. Chapter 2 does.)

Inbound: one route, through the SAME walker — any fetch-shaped capability is a
web server:

```ts
// the router gains:
if (url.pathname === "/cap")
  // any fetch-shaped capability is a web server
  return new IterateContext(env).invokeCapability(`${url.searchParams.get("cap")}.fetch`, [
    request,
  ]) as Promise<Response>;
```

Now provide a fetch-shaped object from your laptop and hit it with plain
`curl` — no capnweb anywhere on the calling side — and **the cloud serves HTTP
out of your laptop**. (The pager's JSON frames learn to flatten
`Request`/`Response` for the hop — ~8 lines, text bodies only in v0; the real
WebSocket-capable tunnel is Chapter 2.)

### Brick 8 — the stream, and the refactor-reveal

The context still has no memory. The log gets its own class — **`Stream`** — and
in the toy it is deliberately _dumb_: storage in, committed events out.

```ts
// The log and its one commit point. (The real Stream takes reduceAtCommit/onCommit
// as injected hooks so the fold runs INSIDE the commit transaction — atomicity the
// toy gets for free, each sql.exec being atomic. Its deps also add `path` and
// `admit`; facets ride the DO's ctx itself — the deep chapter.)
class Stream {
  // storage is SQLite AND the alarm surface (the real Stream arms setAlarm through it)
  constructor(private storage: DurableObjectStorage) {
    this.#sql.exec("CREATE TABLE IF NOT EXISTS events (offset INTEGER PRIMARY KEY, body TEXT)");
  }
  get #sql() {
    return this.storage.sql;
  }

  append(event: StreamEventInput): StreamEvent {
    const insert = "INSERT INTO events (body) VALUES (?) RETURNING offset";
    const { offset } = this.#sql.exec<{ offset: number }>(insert, JSON.stringify(event)).one();
    return { ...event, offset };
  }

  read(afterOffset = 0): StreamEvent[] {
    return this.#sql
      .exec("SELECT offset, body FROM events WHERE offset > ?", afterOffset)
      .toArray()
      .map((row) => ({ ...JSON.parse(row.body as string), offset: row.offset as number }));
  }
}
```

The DO _composes_ commit + fold + fan-out at the call site, because — the
reveal — **every mount is an event**. Notice what is _not_ in the log: the live
stubs. A socket is a connection, not data; the directory is physical and stays
physical. The mount table, on the other hand, is nothing but a fold of the log:

```ts
export class IterateContextDurableObject extends DurableObject<Env> {
  // The toy's inline capability-table processor: #mounts is reduced state, folded
  // from the log by #fold. In the real platform this exact fold is the reduce-only
  // "capability-table" processor — its reduced state IS the routing table.
  #mounts = new Map<string, string>();

  // The physical table — untouched by brick 8. In the real platform it is a BUILT-IN,
  // `itx.rpcStubs`: get(key) reaches a parked stub, list() is who's connected right now.
  #rpcStubs = new RpcStubDirectory({ acceptWebSocket: (ws) => this.ctx.acceptWebSocket(ws) });

  #stream = new Stream(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#fold(this.#stream.read(0)); // wake: replay the log through the same fold
  }

  #fold(events: StreamEventInput[]) {
    for (const event of events)
      if (event.type === "capability-provided")
        this.#mounts.set(event.path as string, event.target as string);
  }

  #fanOut(fresh: StreamEvent[]) {
    // fire-and-forget; a subscriber heals gaps with read
    const subscriberPaths = [...this.#rpcStubs.list(), ...this.#mounts.keys()]
      .filter((path) => path.startsWith("itx.subscribers."));
    for (const path of subscriberPaths) {
      const deliver = async () => this.invoke(path, [fresh]);
      deliver().catch(() => {});
    }
  }

  append(event: StreamEventInput) {
    const committed = this.#stream.append(event);
    this.#fold([committed]);
    this.#fanOut([committed]);
    return committed;
  }

  read(afterOffset = 0) { return this.#stream.read(afterOffset); }

  // the refactor-reveal — provide IS an append:
  provide(path: string, target: string) { return this.append({ type: "capability-provided", path, target }); }
```

There is no `subscribe` method — a subscription **is**
`provide("itx.subscribers.printer", callback)`, served by `#fanOut` over the
pager you already built. And `read(0)` shows your mounts were events all along —
and that your live provides never were. The proof's last beat: **kill the
worker and restart it** — the constructor re-folds the mount table from the
persisted log, and the mounted greeter still answers; the laptop's stub is gone
with its socket, exactly as a socket should be.

Two bridges to the real thing. First, the toy's commit point is `Stream.append`
(dumb, returns the committed event) and the DO's `append` is where commit →
fold → fan-out visibly compose. The real platform inverts that composition — the
fold rides an injected hook _inside_ the commit transaction, so the routing table
is atomically exact with the batch. Same pieces, inverted wiring, one reason.
Second, the toy's walker checks two tables — the directory, then the mounts. The
real platform has one: the directory is a **built-in** named `itx.rpcStubs`, and
a live provide _also_ appends an ordinary mount whose target is the expression
`itx.rpcStubs.get('<path>')`. So the log says where every name points, live ones
included, while never claiming a socket is open. The toy's live-before-durable
check at each prefix is that mount, folded by hand.

### The map

That's every concept, in one file (~200 lines of code): and the skeleton you
built is not _like_ the architecture — it IS the architecture, in miniature,
with the production names —

```ts
function startRpcStubRelay(context, provider, path)      // brick 4: park a live stub
class IterateContext extends RpcTarget { ... }           // bricks 1,2,7: the surface
class ItxEntrypoint extends WorkerEntrypoint { ... }     // brick 5: env.ITX
class RpcStubDirectory { fetch(): Response | null ... }  // bricks 3→4: held stubs → pager sockets (the itx.rpcStubs built-in)
class Stream { append / read }                           // brick 8: the log + commit point
class IterateContextDurableObject extends DurableObject  // composes both, walks the doors
export default { fetch }                                 // bricks 1,7: /api + /cap
```

(One toy shortcut to name: this file hardcodes `getByName("demo")` — one
context, ever. The real `IterateContext` is addressed by a `{ projectId, path }`
pair baked into the DO's name; Chapter 4's naming codec owns that.)

What v0 deliberately punts (each is a deep chapter): the pager carrying calls
(the real one only pages — the stub rides Workers RPC); stateful facets; revoke
(v0 re-provide just overwrites); idempotency, chunking, pause/breaker on the
stream; real auth. Now the second pass — each primitive, done properly.

---

## Chapter 1 — the Iterate Context: capabilities, called in both directions

_Part 0's bricks 1–6, done properly — the real surface, real dispatch, real
hibernation._

### A stub is an API

Start with the smallest possible thing: a server object you can call methods on
over a WebSocket. That is what [capnweb](https://github.com/cloudflare/capnweb)
does — the server hands the client a _stub_ of an `RpcTarget`; method calls on
the stub execute on the server.

```ts
// runs: the stateless edge worker
import { newWorkersRpcResponse, RpcTarget } from "capnweb";

class MyRpcTarget extends RpcTarget {
  whoami() {
    return { hello: "world" };
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/api") return newWorkersRpcResponse(request, new MyRpcTarget());
    return new Response("not found", { status: 404 });
  },
};
```

```ts
// runs: anywhere that can open a WebSocket — Node, a browser, a coding agent
import { newWebSocketRpcSession } from "capnweb";

const api = newWebSocketRpcSession<MyRpcTarget>("wss://example.com/api");
console.log(await api.whoami()); // { hello: "world" }
```

No REST, no schema, no codegen — the stub _is_ the API.

### The other direction: the client provides capabilities

Here is the move that makes everything else possible: a connected client hands
the server a live object, and other callers — or the server itself — can call
it. Your laptop offers `.exec()` to the cloud:

```ts
// runs: your laptop (a Node capnweb client)
await itx.provide("itx.runOnMyComputer", async (cmd: string, args: string[]) => {
  const { stdout } = await execFile(cmd, args);
  return stdout;
});
```

```ts
// runs: any other client on the same context
const out = await itx.runOnMyComputer("ls", ["-la"]);
```

The string you mount it at is the string you call it by — there is no separate
stub key. Paths are absolute and rooted at `itx`, the same name whether you're
the mounter, the caller, or (later) an expression. `provide` returns
`{ providedAtOffset }` — the mount's identity, which is also how you `revoke`
it. (An offset into _what_? Chapter 3 answers that.)

Underneath, that one call is two axioms. The function itself is _physical_ — a
socket and a retained capnweb reference — so it goes into a built-in registry,
`itx.rpcStubs`, under the path. The mount is _data_: the same
`capability-provided` event any expression mount appends, with the target
`itx.rpcStubs.get('itx.runOnMyComputer')`. Read the log and that is exactly what
you'll see; spell the two steps yourself if you like —
`itx.rpcStubs.provide(fn, { key })` then `itx.provide(path, "itx.rpcStubs.get('<key>')")`.
The split buys three things you'll lean on: a reconnect re-parks the stub and
appends nothing (the door is idempotent); if your laptop vanishes the mount
stays and calls answer `CONNECTION_OFFLINE` until you `revoke` it; and "who is
connected right now" is a physical question with a physical answer —
`itx.rpcStubs.list()` — that the log never pretends to know.

The server object is no longer a little API — it holds and routes everyone's
capabilities. Call it what it is: the **IterateContext** (`itx`).

### Where do provided capabilities live? — the Durable Object

A stateless worker has no memory across requests, so the capabilities live in a
**Durable Object** — one per context, holding the capability table:

```
client ──capnweb──▶  IterateContext              // runs: stateless edge
                          │ Workers RPC
                          ▼
                 IterateContextDurableObject     // runs: the context DO
```

The edge `IterateContext` is a thin proxy: it folds `itx.a.b(x)` into one call
expression and hands it to the DO's single dispatch door, `invoke(call)`. The DO
resolves the path against its table and calls whatever is mounted there. For a
live capability, the edge keeps the client's stub in memory — _parks_ it — and
the DO reaches back for it per call.

One hard rule: **capnweb terminates only at the stateless edge; the DO speaks
plain Workers RPC and knows nothing about sessions.** This split is what makes
hibernation possible at the end of this chapter.

### Durable capabilities: mount code, not just live objects

A live capability dies with its provider's connection. For something that should
_keep existing_, mount an **expression** — a string the context evaluates
against its own capabilities on every call:

```ts
// runs: any client
await itx.load("itx.kv.get('src/tool.js')").getEntrypoint().run("hello");
```

`itx.load(source)` mirrors Cloudflare's Worker Loader: load code into a fresh
confined isolate, then pick the host — `.getEntrypoint()` for a stateless
`WorkerEntrypoint`. The source is itself an expression, here fetching the code
from the built-in `itx.kv`. (The folded-array wire shape above and this string
are the same thing: itx expressions.)

Loaded code isn't sandboxed away _from_ the context — it gets a binding to it:

```js
// runs: the loaded isolate — the code you uploaded, as plain JS (no transpile)
import { WorkerEntrypoint } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  async run(name) {
    const itx = await this.env.ITX.get(); // the same itx scope a capnweb client gets
    return itx.runOnMyComputer("say", [name]); // capabilities compose
  }
}
```

Each `getEntrypoint().run()` is a fresh isolate. For a _stateful_ mini-app — a
todo list an agent builds for itself — load a durable class instead. It becomes
a **facet** of the context's DO: its own storage, shared lifecycle.

```js
// runs: the loaded isolate (the app an agent wrote for itself) — plain JS again
import { DurableObject } from "cloudflare:workers";

export class TodoApp extends DurableObject {
  async add(text) {
    const todos = (await this.ctx.storage.get("todos")) ?? [];
    todos.push(text);
    await this.ctx.storage.put("todos", todos);
    return todos.length;
  }
  async list() {
    return (await this.ctx.storage.get("todos")) ?? [];
  }
}
```

```ts
// runs: any client — mount it, then call it by path
const app = "itx.load(\"itx.kv.get('todo.js')\").getDurableObjectClass('TodoApp').get('main')";
await itx.provide("itx.todos", app);

await itx.todos.add("write the tutorial");
await itx.todos.list();
```

That is `provide`'s other face: a live value parks a stub and mounts the
expression that names it; an expression string mounts durably. Either way the
table holds an expression, and the one mechanic underneath is the same: dispatch
splits the path at the mount point and replays the tail — `add("x")` — onto
whatever the target evaluates to, here the facet across the Workers-RPC hop.

### Make it hibernatable: the pager

There's a cost hiding in the live half. A parked stub is held in edge memory,
and the DO needs a live reference to reach it — so the DO can never hibernate
while any provider is connected. A thousand devices each providing one
capability is a thousand DOs pinned awake, billing around the clock.

The fix is a **pager**. The DO holds no stub at all. Instead, the edge opens one
_hibernatable_ WebSocket to the DO per provided capability, carrying only a
`transportId` in its durable socket attachment. The DO hibernates freely. When a
call arrives for a stub it doesn't hold, it sends the one message the pager ever
carries:

```ts
type StubPageMessage = { type: "page" }; // "I should have your stub — send it"
```

The edge answers over Workers RPC with a fresh stub; the DO uses it, keeps it
warm while traffic flows, and drops it when the object next goes idle. The
durable half is the socket attachment (it survives hibernation); the restore
hook is the page.

```ts
// runs: the context DO
export class IterateContextDurableObject extends DurableObject {
  #rpcStubs = new RpcStubDirectory({
    hooks: { acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags) },
    // (elided here: hooks also needs getWebSockets, and the directory takes one
    // more dep — the live-capability fetch server)
  });

  fetch(request: Request) {
    // one door of an ordered walk: pager upgrades are accepted here
    return this.#rpcStubs.fetch(request) ?? new Response("not found", { status: 404 });
  }
}

// invoking a paged-in stub, path tail and all:
await this.#rpcStubs.invoke(path, ["add"], ["x"]);
```

The economics: steady traffic pays exactly one page, then every call is a plain
RPC. A dropped stub costs one page on the next call. An idle context with a
thousand connected devices hibernates and costs nothing. And presence — which of
those thousand is connected _right now_ — is `itx.rpcStubs.list()`, read off the
surviving sockets; the log is never asked a question only a socket can answer.

**That's the first primitive**: a context full of capabilities — live ones
provided by connected clients, durable ones mounted as expressions — all called
by path, in both directions, hibernating when idle.

---

## Chapter 2 — fetch, in both directions

_Part 0's brick 7, done properly — real secret scoping, the real `/cap` door,
and the tunnel with WebSockets._

RPC methods are half the world. The other half speaks HTTP: APIs you call out
to, and browsers, webhooks, and agents that call _in_. Fetch is the second
primitive, and like calling, it runs in both directions.

### Fetch out: hide a secret on the way

Outbound HTTP goes _through_ the context, so it can inject a secret the client
never sees. The client writes a sentinel, not a key:

```ts
// runs: the edge worker — add to the context's surface
async fetch(request: Request): Promise<Response> {
  const withSecret = await substituteHeaderSecrets(request, (name) =>
    this.env.SECRETS_KV.get(`secret:${name}`),
  );
  return fetch(withSecret);
}
```

```ts
// runs: the client — calls OpenAI without ever holding the key
await itx.fetch(
  new Request("https://api.openai.com/v1/models", {
    headers: { Authorization: "Bearer {{secret:OPENAI_API_KEY}}" },
  }),
);
```

(`this.env` reaches an `RpcTarget` however you hand it in — constructor
injection, or the module-level `import { env } from "cloudflare:workers"`.)

If a token survives substitution, the context fails the request loudly (502) —
forwarding it would leak the secret's _name_ and send a garbage credential.
Loaded code gets the same deal for free: every `fetch()` a loaded isolate makes
is routed through this terminal.

### Fetch in: any capability can be a web server

Now the reverse. A capability whose value has a `fetch(request)` method is
_fetch-shaped_ — and the platform gives every fetch-shaped capability a real
HTTP door:

```
GET https://example.com/cap?ctx=prj_demo&cap=itx.todos.web
```

The edge resolves the expression, and the capability's `fetch` answers with a
real `Response` — status, headers, streaming body, even WebSocket upgrades.
capnweb clients reach the same thing in-session as
`itx.fetchCap(cap, request)`.

### The tunnel: fetch into a capability a _client_ provided

Put both directions together and something delightful falls out. A client can
provide a fetch-shaped capability — which means **the cloud can serve HTTP out
of your laptop**:

```ts
// runs: your laptop — `iterate tunnel bla 3000`, essentially
import { RpcTarget, upgradeWebSocketResponse } from "capnweb";

class Tunnel extends RpcTarget {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const local = new WebSocket(`ws://127.0.0.1:3000${url.pathname}`);
      await new Promise((ok, err) => {
        local.addEventListener("open", ok, { once: true });
        local.addEventListener("error", err, { once: true });
      });
      return upgradeWebSocketResponse(local); // the socket tunnels over the session
    }
    return fetch(`http://127.0.0.1:3000${url.pathname}${url.search}`, request);
  }
}

await itx.provide("itx.bla", new Tunnel());
```

Now `https://example.com/cap?ctx=prj_demo&cap=itx.bla` serves your
`localhost:3000` — WebSockets included, hot reload and all. The frames ride the
same capnweb session the provide came in on.

### Auth arrives as a side effect

The moment fetch-in exists, strangers can reach your context — so _who is
calling?_ stops being optional. The answer is a pattern, not a framework: you
can only get the real context by being handed it by a gate that checked
something.

```ts
// runs: the edge worker — this is now what /api serves
class UnauthenticatedRpcTarget extends RpcTarget {
  authenticate(credentials: { type: "shared-secret"; secret: string }) {
    if (credentials.secret !== this.env.SHARED_SECRET) throw new Error("bad credentials");
    return new IterateContext(/* ... */); // only reachable past the check
  }
}
```

```ts
// runs: the client
const api = newWebSocketRpcSession("wss://example.com/api");
const itx = api.authenticate({ type: "shared-secret", secret: SECRET });
await itx.whoami();
```

(`authenticate` returns the RPC stub directly — and note there's no `await` on
it: you can call methods on the unresolved stub, so authenticate-and-first-call
ride one round trip. That pipelining is capnweb, free of charge.)

**That's the second primitive**: fetch through the context in both directions —
out with secrets injected, in to anything fetch-shaped, even when the thing
serving is a laptop behind NAT.

---

## Chapter 3 — streams and stream processors

_Part 0's brick 8, done properly — idempotency, offsets as proofs, processors
as real facets._

The context is now a live switchboard with an HTTP door, but it has no memory of
what happened and no way to react to change. The third primitive is a log.

```ts
// runs: any client (or loaded code via env.ITX)
await itx.append({ type: "message.posted", payload: { text: "hi" } });

const { events, scannedThroughOffset } = await itx.read(0);

await itx.subscribe({
  name: "printer",
  target: (events, range) => events.forEach((e) => console.log(e.type)),
});
```

- **`append`** — the commit point: idempotency keys honored, offsets from one
  monotonic sequence (this is the sequence `providedAtOffset` indexes — every
  mount is itself an event on this log), ephemeral events allowed.
- **`read`** — a page of history plus how far the scan reached, so a client can
  chain pages without gaps.
- **`subscribe`** — sugar for `provide("itx.subscribers.<name>", callback)`. A
  subscription _is_ a provided capability: the commit path fire-and-forgets each
  batch to it over Chapter 1's pager. No acks, no server cursor — the client
  owns its offset and heals any gap with `read`.

The commit machinery is one dependency-injected class, no framework:

```ts
// runs: the context DO
new Stream({
  storage, // the DO's SQLite + alarms
  path, // the context's own address, stamped on every event
  admit, // the gate that can refuse an append (pause / breaker)
  reduceAtCommit, // hooks that run inside the commit transaction
  onCommit, // the post-commit fan-out: facets + subscribers
});
```

### Processors: react to the log, as facets

A **stream processor** reduces the log into derived state — and it's just a
facet (Chapter 1 machinery), driven a batch at a time from the stream's
`onCommit` fan-out:

```ts
await itx.enableProcessor("unread-counts", {
  source: "itx.kv.get('counter.js')",
  className: "UnreadCounter",
});
```

A processor's reduced state is queryable through its `snapshot()` — and even the
capability table itself is one of these processors: "what's mounted where" is
just its reduced state, folded from the same log that everything else rides.

**That's the third primitive**: an append-only log with one commit point,
subscribers served over the pager, and processors — facets that fold the log
into state.

---

## Chapter 4 — everything else is on top

Three primitives; the rest is composition, policy, and road ahead — the one home
for every FUTURE item:

**Shipped**

- **LiveState** — a processor's reduced state, made live: after each batch it
  appends an ephemeral `live-state/changed` delta `{key, from, to, patch}`;
  clients seed from `snapshot()`'s `{rev, state}`, chain patches by revision,
  and re-read on any mismatch — lossy, always healable. A small React hook
  (`useLiveState`) rides this on the client.
- **Projects & routing** — a project is just the prefix of every context DO name
  (`prj_demo.iterate/agents/support-bot`). Four edge routes: `/api` (capnweb),
  `/cap` (Chapter 2's fetch-in door), `/version`, `/demo`.
- **Secrets** — Chapter 2's sentinel substitution, project- and platform-scoped,
  layered through an egress fallback chain.
- **MCP for agents** — put an MCP server in front of the context: each mounted
  capability is a tool; a `tools/call` is an `itx.<path>(...)` invocation.
  Provide `itx.robot.nod` from your desk and your coding agent can make your
  robot nod. (The capability layer is shipped; the MCP shim itself lives in the
  control plane, not yet wired to serving.)

**Ahead**

- **Real auth** — `authenticate()` in the shipped tree is today a no-op
  returning `this`; the HMAC-signed session machinery exists in the control
  plane and drops into that one method without changing a single caller.
- **Trust** — the current model is _trusted clients_: intra-project
  coordination, no malicious-client defense, no signed events. Signing and
  membership stamps come with the auth wiring.
- **Git-backed config repos**, and a **device client** (the wire protocol is
  JSON over a WebSocket — an ESP32 can speak it; nobody has written the firmware
  yet).

---

## The shape of the whole thing

Contexts nest: a capability can be a facet that itself loads code and provides
capabilities — a call is a path, a path is a walk, and every hop pipelines.
Three primitives hold it all: **the context** (capabilities called in both
directions, hibernating on the pager), **fetch** (out with secrets, in to
anything fetch-shaped), and **the stream** (one commit point; processors fold it
into state). Everything a client can do is a capability; everything durable is a
reduced event.

---

### Appendix: map to the source tree

| Tutorial                                                      | Real code (`packages/v3/project-worker`)                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ch 1 edge worker + `IterateContext` + `provide`               | `src/worker.ts` (`/api`), `src/core/itx-surface.ts`                                                                                                                                                                            |
| Ch 1 the context DO                                           | `IterateContextDurableObject`, `src/stream-durable-object.ts`                                                                                                                                                                  |
| Ch 1 load / facets / tail replay                              | `src/built-ins.ts`, `facetInvoke` in the DO                                                                                                                                                                                    |
| Ch 1 pager pair (the `itx.rpcStubs` built-in's backing table) | `RpcStubDirectory` + `HibernatableRpcStubManager`, `src/rpc-stub-directory.ts`, `src/core/hibernatable-rpc-stub.ts`; the built-in itself in `src/built-ins.ts`, the edge half (`provide`/`close`) in `src/core/itx-surface.ts` |
| Ch 2 secret sentinel                                          | `{{secret:project:NAME}}` — `../shared/src/egress.ts`, the DO's `#egress` terminal                                                                                                                                             |
| Ch 2 fetch-in / tunnel                                        | `/cap` in `src/worker.ts`, `src/core/fetch-capabilities.ts`, `upgradeWebSocketResponse` in the capnweb fork                                                                                                                    |
| Ch 2 auth gate                                                | `ProjectSession.authenticate()` in `src/core/itx-surface.ts`                                                                                                                                                                   |
| Ch 3 stream + processors                                      | `Stream` in `src/core/stream.ts`, `src/core/processor.ts`                                                                                                                                                                      |
| Ch 4 LiveState / control plane                                | `src/core/live-state.ts`; `packages/v3/control-plane` (not yet wired)                                                                                                                                                          |
