# Build the Iterate Context, one capability at a time

Grow the platform from nothing but capnweb into the full streaming, hibernatable
Iterate Context. Each chapter ends with something you can call, and each exists
because the last one left something on the table. Every client snippet is
spelled against today's shipped surface; the server snippets are the real code,
abridged where an elision is marked, and Part 0's are a working toy of their
own. The whole client dependency is one npm package, `@iterate-com/capnweb`
(imported as `capnweb`). There is no client SDK: a client is just a capnweb peer.

There are exactly **three primitives** — the **context** (things you can call,
in both directions), **fetch** (in both directions), and the **stream** — and
then everything else is composition on top. You'll meet them twice: **Part 0
builds the whole platform, brick by brick, in one small `worker.ts` (~200 lines of code)** — v0
of every concept in about 30 minutes, each brick's flaw forcing the next. Then
Chapters 1–3 rebuild each primitive properly, against the real thing.

Two words are kept apart throughout, because the code keeps them apart. An
**rpc stub** is physical: a live value a session LENDS under an `rpcStubKey`,
which the context BORROWS and RETURNS at idle — `provide` lends under the key
that IS the canonical match, `subscribe` under `subscription:<name>`. A
**rewrite rule** is pure data, `{ match, target }`: a call starting with `match`
runs as the same call with `match` replaced by `target`.

---

## Part 0 — the whole platform in ~200 lines

> **ORDER NOTE (2026-09-03).** The order of record — the code's layer order — is:
> **(1) rpc stubs** — `provide(match, stub)` + `invoke`, the directory's two
> layers being the borrowed table first and the pager as "the second `if`";
> **(2) itx expressions** and the dotted surface (`invoke` takes an
> `ItxExpressionInput`; `itx.a.b(x)` reduces onto it); **(3) rewrite rules** —
> the SAME verb, `provide(match, target | null)`, with an itx expression as the
> target; **(4) subscriptions** — `subscribe({ name?, target, consumes? })`;
> **(5) processors** — `enableProcessor(name, { source, className, consumes? })`
> and `disableProcessor(name)`. Fetch sits outside the order. Two spellings a
> reader may remember are GONE: the edge verb `rewrite(match, target | null)` was
> deleted and absorbed into `provide`, and `provide` never had an options bag —
> it takes exactly two positional arguments, and for a live stub the key it is
> lent under IS the canonical match. Today's bricks predate that cut: brick 2
> conflates the stub KEY with the dotted name you call it by (expressions arrive
> only implicitly, as dotted strings), rewrite rules are brick 6, subscriptions
> hide inside brick 8's fan-out, and fetch sits between them as brick 7 /
> Chapter 2. Chapters 1–3 predate the `provide`-unification too — their client
> snippets have been corrected to the shipped surface; the bricks will be re-cut
> to its order.

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
    "bindings": [{ "name": "ITERATE_CONTEXT", "class_name": "IterateContextDurableObject" }],
  },
  "exports": { "IterateContextDurableObject": { "type": "durable-object", "storage": "sqlite" } },
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

That callback is the whole platform in embryo: **a live value flowed from the
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

If the server can hold a client's function, clients can _lend_ them — under
keys:

```ts
const rpcStubs = new Map<string, unknown>();

// inside IterateContext:
  provide(rpcStubKey: string, stub: RpcStub<object>) {
    rpcStubs.set(rpcStubKey, stub.dup()); // same rule as callMeLater: keep our own
  }

  // The dispatch walker: longest lent key prefix, then walk the remaining dotted
  // segments, then apply the args. (v0 conflates the stub KEY with the dotted name
  // you call it by — the real platform keeps them apart; see the ORDER NOTE.)
  invoke(call: string, args: unknown[] = []) {
    const segments = call.split(".");
    for (let i = segments.length; i > 0; i--) {
      let target = rpcStubs.get(segments.slice(0, i).join("."));
      if (target === undefined) continue;
      let parent: unknown;
      for (const segment of segments.slice(i))
        [parent, target] = [target, (target as Record<string, unknown>)[segment]];
      return Reflect.apply(target as (...a: unknown[]) => unknown, parent, args);
    }
    throw new Error(`nothing provided at ${call}`);
  }
```

Provide a doubler under the key `itx.double`, call it back through the walker —
works. Now open a **second** session and call it from there:

```
Error: Cannot perform I/O on behalf of a different request. I/O objects (such as
streams, request/response bodies, and others) created in the context of one
request handler cannot be accessed from a different request's handler.
```

That error is the flaw, and it's a deep one: workerd pins every session's I/O to
its own request context — a raw stub in a shared `Map` can only ever be touched
from home. Lent stubs need somewhere to _live_, and the stub needs to be
**loaned**, not shared.

### Brick 3 — the Durable Object simply borrows the stubs

The home is a **Durable Object** — one per context. The `Map` and the walker
move in, and the stub is _loaned_ across Workers RPC: `dup()` it, pass it as a
plain argument, and calls on the loaned stub **route back to the provider's own
session** — from any caller. Brick 2's error dissolves. No WebSockets anywhere:

```ts
type Env = { ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject> };

// Walk remaining dotted segments on a target, then apply the args.
const applyPath = (target: unknown, tail: string[], args: unknown[]) => {
  let parent: unknown;
  for (const segment of tail) [parent, target] = [target, (target as Record<string, unknown>)[segment]];
  return Reflect.apply(target as (...a: unknown[]) => unknown, parent, args);
};

// the edge IterateContext now proxies (constructor takes env; #context() = getByName):
  // The stub is LENT across Workers RPC into the DO, which BORROWS it. Both hops dispose
  // params at return — the edge dups before passing, the DO dups what it holds.
  async provide(rpcStubKey: string, stub: RpcStub<object>) {
    await this.#context().lendRpcStub({ rpcStubKey, stub: stub.dup() });
  }

  invoke(call: string, args: unknown[] = []) { return this.#context().invoke(call, args); }
```

```ts
// LAYER 1 of the directory — THE BORROWED RPC STUBS: each lent stub, loaned across
// Workers RPC, held by its opaque key.
class RpcStubDirectory {
  #borrowedRpcStubs = new Map<string, RpcStub<object>>();

  lendRpcStub(input: { rpcStubKey: string; stub: RpcStub<object> }) {
    this.#borrowedRpcStubs.set(input.rpcStubKey, input.stub.dup()); // Workers RPC disposes params at return too
  }

  has(rpcStubKey: string) {
    return this.#borrowedRpcStubs.has(rpcStubKey);
  }

  invokeRpcStub(rpcStubKey: string, segments: string[], args: unknown[]) {
    return applyPath(this.#borrowedRpcStubs.get(rpcStubKey)!, segments, args);
  }
}

export class IterateContextDurableObject extends DurableObject<Env> {
  #rpcStubs = new RpcStubDirectory();

  lendRpcStub(input: { rpcStubKey: string; stub: RpcStub<object> }) {
    this.#rpcStubs.lendRpcStub(input);
  }

  // The dispatch walker: longest lent key prefix, then the tail, then the args.
  invoke(call: string, args: unknown[] = []) {
    const segments = call.split(".");
    for (let i = segments.length; i > 0; i--) {
      const prefix = segments.slice(0, i).join(".");
      const tail = segments.slice(i);
      if (this.#rpcStubs.has(prefix)) return this.#rpcStubs.invokeRpcStub(prefix, tail, args);
    }
    throw new Error(`nothing provided at ${call}`);
  }
}
```

Session B calling session A's `itx.double` returns `42` now — and when session A
disconnects, the loan dies with the lender: further calls reject with
`The execution context which hosts this callback is no longer running.`

The flaw here isn't correctness — it's economics, and it's the real platform's
own measured wall: **a borrowed live stub is an active reference, and a DO holding
one can never be evicted.** A thousand idle providers pin a thousand Durable
Objects awake, billed around the clock. Hibernatable WebSockets are the one
channel that survives eviction — which is exactly the next brick.

### Brick 4 — hibernation: the pager arrives, behind the same API

Swap the transport, keep the surface. Instead of holding the stub, the DO holds
a **hibernatable WebSocket** per lent key — a pager — and the provider's edge
session serves the calls from where the stub legally lives:

```ts
type IterateContextDurableObjectStub = DurableObjectStub<IterateContextDurableObject>;

// Lend a live capnweb stub to the DO behind its pager: dup it (capnweb disposes params
// at return), open the pager WebSocket for its key, answer every call request.
// (v0 carries calls ON the pager; the real relay's pager only says "lend me the stub".)
async function lendRpcStubOverPager(
  context: IterateContextDurableObjectStub, clientRpcStub: RpcStub<object>, rpcStubKey: string) {
  const live = clientRpcStub.dup();
  const upgrade = { headers: { Upgrade: "websocket" } };
  const socket = (await context.fetch(`http://do/pager?rpcStubKey=${rpcStubKey}`, upgrade)).webSocket!;
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
  // awake — so its relay keeps it HERE and lends it over the pager.
  async provide(rpcStubKey: string, stub: RpcStub<object>) {
    await lendRpcStubOverPager(this.#context(), stub, rpcStubKey);
  }
```

```ts
// LAYER 2 of the directory — THE PAGERS: hibernatable pager sockets by key + the
// call/reply bookkeeping over them. Everything it needs from its DO arrives through deps.
class RpcStubDirectory {
  #rpcStubPagers = new Map<string, WebSocket>();
  #replies = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  #nextCallId = 0;
  constructor(private deps: { acceptWebSocket: (ws: WebSocket) => void }) {} // HIBERNATABLE accept

  // The pager door: answer the pager WebSocket upgrade for a key, else null.
  acceptRpcStubPagerWebSocket(request: Request): Response | null {
    const url = new URL(request.url);
    if (url.pathname !== "/pager") return null;
    const rpcStubKey = url.searchParams.get("rpcStubKey")!;
    const pair = new WebSocketPair();
    this.deps.acceptWebSocket(pair[0]);
    this.#rpcStubPagers.set(rpcStubKey, pair[0]);
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  // Replies come back through the DO's webSocketMessage — route them by call id.
  webSocketMessage(message: string) {
    const { id, result, error } = JSON.parse(message);
    if (error !== undefined) this.#replies.get(id)?.reject(new Error(error));
    else this.#replies.get(id)?.resolve(result);
  }

  has(rpcStubKey: string) { return this.#rpcStubPagers.has(rpcStubKey); }

  invokeRpcStub(rpcStubKey: string, segments: string[], args: unknown[]) {
    const id = this.#nextCallId++;
    return new Promise((resolve, reject) => {
      this.#replies.set(id, { resolve, reject });
      this.#rpcStubPagers.get(rpcStubKey)!.send(JSON.stringify({ id, tail: segments, args }));
    });
  }
}

// the DO:
  #rpcStubs = new RpcStubDirectory({ acceptWebSocket: (ws) => this.ctx.acceptWebSocket(ws) });

  // workerd routes these by their EXACT names: a WebSocket upgrade must arrive
  // through a DO method literally named fetch (here it accepts the hibernatable
  // pager sockets), and traffic on those sockets lands on webSocketMessage.
  fetch(request: Request) {
    return this.#rpcStubs.acceptRpcStubPagerWebSocket(request) ?? new Response("not found", { status: 404 });
  }
  webSocketMessage(_ws: WebSocket, message: ArrayBuffer | string) {
    this.#rpcStubs.webSocketMessage(String(message));
  }
```

Now look at what **didn't** change: `has(rpcStubKey)` and
`invokeRpcStub(rpcStubKey, segments, args)` keep their exact signatures, the DO's
walker is untouched, and the proof client for this brick is brick 3's, verbatim.
The transport swapped underneath a stable API — that IS the design lesson, and
it's why the real platform could build hibernation without rewriting dispatch.
The prefix-match stays DO-side; the tail-walk moved to the providing edge,
riding the pager frame. (The real directory keeps BOTH layers and its
`invokeRpcStub` is the two `if`s in a row: have we got it borrowed? call it ·
else is there a pager for it? page it, the edge lends a fresh stub over Workers
RPC, layer 1 takes over · else `RPC_STUB_OFFLINE`. v0's pager carries the calls
itself; the real one only ever says `{ type: "page" }`.)

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
typing, `ItxEntrypoint({ props })` included. `LOADER.get(...).getEntrypoint()` is
Cloudflare's own Worker Loader API, called raw here; the real platform wraps
exactly this door as the built-in `itx.workers.get({ source })`. The DO is
untouched in this brick; execution stays edge-side until rewrite rules need it.)

The proof closes a beautiful loop — a script, running _inside_ the context,
calls back out through the walker and the pager to the same client's own
lent function (uploaded code is plain JS — no transpile):

```js
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async run(x) {
    const itx = await this.env.ITX.get();
    return await itx.invoke("itx.double", [x]);
  }
}
```

`await itx.runScript(script, 21)` → `42`, having transited client → loader →
`env.ITX` → walker → pager → client.

### Brick 6 — rewrite rules

A lent stub is a phone line. For something that should _keep existing_, write a
**rewrite rule** — `{ match, target }`, pure data, no stub anywhere. In v0 the
target is a code string the walker loads on demand; the real platform's target
is an itx expression such as `itx.workers.get({ source })`. The rule table
lives beside the directory:

```ts
// the edge's provide grows a SECOND kind of target — one verb, one more `if`
// (the real platform's `provide(match, target)`, exactly):
  async provide(match: string, target: RpcStub<object> | string) {
    if (typeof target === "string") return this.#context().provide(match, target);
    await lendRpcStubOverPager(this.#context(), target, match);
  }

// the DO gains its second table, its own loader, and the rule door:
  #itxExpressionRewriteRules = new Map<string, string>(); // match → target

  provide(match: string, target: string) { this.#itxExpressionRewriteRules.set(match, target); }

  // Targets resolve where the walker runs — the same loader door, DO-side
  // (DurableObjectState carries typed ctx.exports too).
  #load(code: string) { /* identical body to the edge's */ }

// and the walker gains its second branch, after the borrowed-stub check:
      const target = this.#itxExpressionRewriteRules.get(prefix);
      if (target !== undefined) return applyPath(this.#load(target), tail, args);
```

(Stub-before-rule at each prefix length means a lent stub under a key that
equals a rule's match wins while connected — reconnect-friendly by accident of
ordering. The real platform has ONE table to consult, because a lent stub is
reached through a rule too, under the key that IS its match:
`itx.shell ⇒ itx.rpcStubs.get('itx.shell')`.)

The proof is the beat that teaches live-vs-durable in ten seconds: configure a
greeter as a rule, provide `itx.double` live, then **kill the providing
session**. The rule still answers; the lent stub rejects with
`Peer closed WebSocket: 3000 RPC session was shut down`. Live dies with its
provider; a rule doesn't.

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
fetching. Chapter 2 does — and its real sentinel carries a scope segment,
`{{secret:project:NAME}}`, where v0's is bare.)

Inbound: one route, through the SAME walker — anything fetch-shaped is a web
server:

```ts
// the router gains:
if (url.pathname === "/expression")
  // anything fetch-shaped is a web server: ?itx= names the expression
  return new IterateContext(env).invoke(`${url.searchParams.get("itx")}.fetch`, [
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
// The log and its one commit point. (The real Stream also OWNS the core reduce —
// `#coreReducedState`, reduced INSIDE the commit transaction, atomicity the toy gets for free,
// each sql.exec being atomic — and takes one injected hook, onCommit, the fan-out.
// Its deps add `path` and `projectId`; the pause check is one `if` in append reading
// its own core state; facets ride the DO's ctx
// itself — the deep chapter.)
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

The DO _composes_ commit + reduce + fan-out at the call site, because — the
reveal — **every rewrite rule is an event**. Notice what is _not_ in the log: the
lent stubs. A socket is a connection, not data; the directory is physical and
stays physical. The rule table, on the other hand, is nothing but a reduce of
the log. (Every real event type is namespaced — `events.iterate.com/<domain>/<name>`
— so a `readEvents(0)` filter must carry the prefix; every type below is written in
full.)

```ts
export class IterateContextDurableObject extends DurableObject<Env> {
  // The toy's inline core reduce: #itxExpressionRewriteRules is reduced state, reduced from
  // the log by #reduce. In the real platform this exact reduce is one slice of the core
  // reduce — `state.itxExpressionRewriteRules`, a MAP: a configured target replaces, null deletes.
  #itxExpressionRewriteRules = new Map<string, string>();

  // The physical table — untouched by brick 8. In the real platform it is a BUILT-IN,
  // `itx.rpcStubs`: get(rpcStubKey) reaches a lent stub, list() is who's connected right now.
  #rpcStubs = new RpcStubDirectory({ acceptWebSocket: (ws) => this.ctx.acceptWebSocket(ws) });

  #stream = new Stream(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#reduce(this.#stream.read(0)); // wake: replay the log through the same reduce
  }

  #reduce(events: StreamEventInput[]) {
    for (const event of events)
      if (event.type === "events.iterate.com/itx/rewrite-rule-configured") {
        if (event.target === null) this.#itxExpressionRewriteRules.delete(event.match as string);
        else this.#itxExpressionRewriteRules.set(event.match as string, event.target as string);
      }
  }

  #fanOut(fresh: StreamEvent[]) {
    // fire-and-forget; a subscriber heals gaps with read
    const subscriberKeys = [...this.#rpcStubs.list(), ...this.#itxExpressionRewriteRules.keys()]
      .filter((key) => key.startsWith("itx.subscribers."));
    for (const key of subscriberKeys) {
      const deliver = async () => this.invoke(key, [fresh]);
      deliver().catch(() => {});
    }
  }

  append(event: StreamEventInput) {
    const committed = this.#stream.append(event);
    this.#reduce([committed]);
    this.#fanOut([committed]);
    return committed;
  }

  read(afterOffset = 0) { return this.#stream.read(afterOffset); }

  // the refactor-reveal — configuring a rule IS an append:
  provide(match: string, target: string | null) {
    return this.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      match,
      target,
    });
  }
```

There is no `subscribe` method — a subscription **is**
`provide("itx.subscribers.printer", callback)`, served by `#fanOut`
over the pager you already built. And `readEvents(0)` shows your rewrite rules were
events all along — and that your lent stubs never were. The proof's last beat:
**kill the worker and restart it** — the constructor re-reduces the rule table
from the persisted log, and the greeter rule still answers; the laptop's stub is
gone with its socket, exactly as a socket should be.

Three bridges to the real thing. First, the toy's commit point is `Stream.append`
(dumb, returns the committed event) and the DO's `append` is where commit →
reduce → fan-out visibly compose. The real platform inverts that composition — the
reduce rides an injected hook _inside_ the commit transaction, so the rule table
is atomically exact with the batch. Same pieces, inverted wiring, one reason.
Second, the toy's walker checks two tables — the directory, then the rules. The
real platform has one: the directory is a **built-in** named `itx.rpcStubs`, and
a live `provide(match, stub)` _also_ appends an ordinary rule whose target is the
expression `itx.rpcStubs.get('<match>')`. So the log says where every name
points, live ones included, while never claiming a socket
is open. The toy's stub-before-rule check at each prefix is that rule, reduced by
hand. Third, the toy makes a subscription a name at `itx.subscribers.*`. The real
platform gives subscriptions their own event —
`events.iterate.com/stream/subscription-configured { name, target | null,
consumes? }`, reduced by the one core reduce beside the rules — because a
subscription names a _delivery_, not a callable: the target is still an
expression (a lent stub, a facet, a loaded entrypoint's `processEventBatch`), and
the context decides how to serve it by looking at what the expression evaluates
to. Same fan-out, one layer up.

### The map

That's every concept, in one file (~200 lines of code): and the skeleton you
built is not _like_ the architecture — it IS the architecture, in miniature,
under the production names where v0 has them (the two it invents for itself are
called out where they appear: the `itx.subscribers.*` subscriber keys, and the
dotted strings that stand in for itx expressions) —

```ts
function lendRpcStubOverPager(context, clientRpcStub, rpcStubKey)   // brick 4: lend a live stub
class IterateContext extends RpcTarget { ... }                      // bricks 1,2,6,7: the surface — provide · invoke · fetch
class ItxEntrypoint extends WorkerEntrypoint { ... }                // brick 5: env.ITX
class RpcStubDirectory { acceptRpcStubPagerWebSocket() ... }        // bricks 3→4: borrowed stubs → pager sockets (the itx.rpcStubs built-in)
class Stream { append / read }                                      // brick 8: the log + commit point
class IterateContextDurableObject extends DurableObject             // composes both, walks the doors
export default { fetch }                                            // bricks 1,7: /api + /expression
```

(One toy shortcut to name: this file hardcodes `getByName("demo")` — one
context, ever. The real `IterateContext` is addressed by a `{ projectId, path }`
pair baked into the DO's name; Chapter 4's naming codec owns that.)

What v0 deliberately punts (each is a deep chapter): the pager carrying calls
(the real one only pages — the stub rides Workers RPC); itx expressions as data
(v0 walks dotted strings; the real `invoke` takes an `ItxExpressionInput`, and a
match may pin literal args); stateful facets; un-setting a rule (`target: null`
— v0's re-provide just overwrites) and disposable handles; idempotency,
chunking, pause on the stream; real auth. Now the second pass — each primitive,
done properly.

---

## Chapter 1 — the Iterate Context: rpc stubs and rewrite rules, called in both directions

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

### The other direction: the client provides an rpc stub

Here is the move that makes everything else possible: a connected client hands
the server a live object, and other callers — or the server itself — can call
it. Your laptop offers `.exec()` to the cloud:

```ts
// runs: your laptop (a Node capnweb client)
using laptop = await itx.provide("itx.runOnMyComputer", async (cmd: string, args: string[]) => {
  const { stdout } = await execFile(cmd, args);
  return stdout;
});
```

```ts
// runs: any other client on the same context
const out = await itx.runOnMyComputer("ls", ["-la"]);
```

Two things happened there, and one verb made both. The function itself is
_physical_ — a socket and a capnweb reference your session holds — so it is LENT
to a built-in registry, `itx.rpcStubs`, under a key; for `provide` that key IS
the canonical match, so the function is callable as
`itx.rpcStubs.get('itx.runOnMyComputer')(cmd, args)`. (`subscribe` is the only
other verb that takes a live value, and it lends under `subscription:<name>`.)
The rule is _data_: the same
`events.iterate.com/itx/rewrite-rule-configured` event any rule appends, with
`match: "itx.runOnMyComputer"` and
`target: "itx.rpcStubs.get('itx.runOnMyComputer')"`. Read the log and that is
exactly what you'll see; the rule step is spellable on its own —
`itx.provide("itx.shell", "itx.rpcStubs.get('itx.runOnMyComputer')")` points
another name at an already-lent stub. The handle you get back is DISPOSABLE:
`using` recalls the stub at scope end, and capnweb disposes it for you when the
session ends. The split buys three things you'll lean on: a reconnect re-provides
under the same key (the pager is replaced) and sets the same rule again — the
table entry is unchanged; "who is connected right now" is a physical question
with a physical answer — `itx.rpcStubs.list()` — that the log never pretends to
know; and the rule dies with the stub — disposing the handle recalls it, and when
your laptop's LAST pager closes the context itself un-sets every rule (and
subscription) that named the stub, a reconnect replacing the pager rather than
closing it. `RPC_STUB_OFFLINE` is what a call answers when a rule names a key
nobody has lent right now. (An offset into
_what_ is that event appended? Chapter 3 answers that.)

The server object is no longer a little API — it holds and routes everyone's
stubs and rules. Call it what it is: the **IterateContext** (`itx`).

### Where do lent stubs and rules live? — the Durable Object

A stateless worker has no memory across requests, so they live in a
**Durable Object** — one per context, holding the rewrite-rule table and the
rpc-stub directory:

```
client ──capnweb──▶  IterateContext              // runs: stateless edge
                          │ Workers RPC
                          ▼
                 IterateContextDurableObject     // runs: the context DO
```

The edge `IterateContext` is a PROXY in front of the DO: it reduces `itx.a.b(x)`
into one call expression and hands it to the DO's single dispatch door,
`invoke(call)`. The DO rewrites the call through its rules until the root is a
built-in and runs it. For a lent stub, the edge keeps the client's stub in
memory — it OWNS it — and the DO reaches back for it (BORROWS it) on the first
call after each idle period.

One hard rule: **capnweb terminates only at the stateless edge; the DO speaks
plain Workers RPC and knows nothing about sessions.** This split is what makes
hibernation possible at the end of this chapter.

### Durable names: rewrite rules over code, not just live objects

A lent stub dies with its provider's connection. For something that should
_keep existing_, write a rewrite rule whose target is an **expression** — a
string (or its parsed array) the context evaluates against its own built-ins on
every call. (This section reaches past the order of record for two of those
built-ins — itx expressions, layer 2, and the loader roots `itx.workers` /
`itx.facets` — so both are unpacked right here; the ORDER NOTE has the order.)

```ts
// runs: any client
const toolSource = { "cap.js": TOOL_SRC }; // a source IS its modules; "cap.js" is the main one
await itx.workers.get({ source: toolSource }).run("hello");
```

`itx.workers.get({ source })` mirrors Cloudflare's Worker Loader: load code into
a fresh confined isolate and call any method its entrypoint exports (`run`,
`fetch`, `processEventBatch`, …). A `source` is the worker's modules, literally,
with `"cap.js"` as the main module; it may instead be an expression that PRODUCES
them (`"itx.kv.get('src/tool.js')"`), and then a `cacheKey` is required, because
the caller owns "same key ⇒ same code" — a storage choice, not a different API.
(The reduced-array wire shape `invoke` carries and this dotted call are the same
thing: itx expressions.)

Loaded code isn't sandboxed away _from_ the context — it gets a binding to it:

```js
// runs: the loaded isolate — the code you uploaded, as plain JS (no transpile)
import { WorkerEntrypoint } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  async run(name) {
    const itx = await this.env.ITX.get(); // the same itx scope a capnweb client gets
    return itx.runOnMyComputer("say", [name]); // rules compose
  }
}
```

`itx.workers.get` is the stateless host: no storage, the isolate reused warm
while the source hash (or your `cacheKey`) is unchanged. For a _stateful_
mini-app — a todo list an agent builds for itself — load a durable class through
`itx.facets.get(name, { source, className })` instead. It becomes a **facet** of
the context's DO: its own storage, shared lifecycle.

```js
// runs: the loaded isolate (the app an agent wrote for itself) — plain JS again
import { DurableObject } from "cloudflare:workers";

export class TodoAppDurableObject extends DurableObject {
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
// runs: any client — configure the rule, then call it by name
const todoSource = { "cap.js": TODO_SRC };
using todos = await itx.provide("itx.todos", [
  "itx",
  "facets",
  ["get", "todos", { source: todoSource, className: "TodoAppDurableObject" }],
]);

await itx.todos.add("write the tutorial");
await itx.todos.list();
```

That is the one mechanic underneath both faces: a rewrite rule replaces the
matched prefix with its target, and the steps after the match — `add("x")` —
ride along onto whatever the rewritten call evaluates to, here the facet across
the Workers-RPC hop. Lending a live stub is that same rule with the target
`itx.rpcStubs.get('<match>')` — one verb, two kinds of target. A rule made
through `provide` is session-scoped by its handle; the durable spelling is the
raw event — in a worker, `itx.append(rewriteRuleConfiguredEvent(match, target))`;
from a client, the same event written out as a literal.

### Make it hibernatable: the pager

There's a cost hiding in the live half. A lent stub is held in edge memory,
and the DO needs a live reference to reach it — so the DO can never hibernate
while any provider is connected. A thousand devices each providing one
stub is a thousand DOs pinned awake, billing around the clock.

The fix is a **pager**. The DO holds no stub at all while idle. Instead, the
edge opens one _hibernatable_ WebSocket to the DO per lent key, carrying
`{ transportId, rpcStubKey }` in its durable socket attachment. The DO hibernates
freely. When a call arrives for a stub it doesn't hold, it sends the one message
the pager ever carries:

```ts
type RpcStubPageMessage = { type: "page" }; // "I ought to have your rpc stub — lend it"
```

The edge answers over Workers RPC with a fresh stub (`lendRpcStub`); the DO
BORROWS it, keeps it warm while traffic flows, and RETURNS it when the object
next goes idle. The durable half is the socket attachment (it survives
hibernation); the restore hook is the page.

```ts
// runs: the context DO
export class IterateContextDurableObject extends DurableObject {
  #rpcStubs = new RpcStubDirectory({
    hooks: { acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags) },
    // (elided here: hooks also needs getWebSockets, and the directory takes two
    // more deps — onPresence, which mints the ephemeral
    // events.iterate.com/rpc-stub/attached and .../detached { rpcStubKey }
    // events, and the rpc-stub fetch server)
  });

  fetch(request: Request) {
    // one door of an ordered walk: pager upgrades are accepted here
    return (
      this.#rpcStubs.acceptRpcStubPagerWebSocket(request) ??
      new Response("not found", { status: 404 })
    );
  }
}

// invoking a borrowed stub with the steps after the key — the two `if`s:
// borrowed? call it · else a pager? page it · else RPC_STUB_OFFLINE
await this.#rpcStubs.invokeRpcStub(rpcStubKey, [["add", "x"]]);
```

The economics: steady traffic pays exactly one page, then every call is a plain
RPC. A returned stub costs one page on the next call. An idle context with a
thousand connected devices hibernates and costs nothing. And presence — which of
those thousand is connected _right now_ — is `itx.rpcStubs.list()`, read off the
surviving sockets; the log is never asked a question only a socket can answer.

**That's the first primitive**: a context full of names — live ones lent by
connected clients, durable ones configured as rewrite rules over expressions —
all called by dotted path, in both directions, hibernating when idle.

---

## Chapter 2 — fetch, in both directions

_Part 0's brick 7, done properly — real secret scoping, the real `/expression`
door, and the tunnel with WebSockets._

RPC methods are half the world. The other half speaks HTTP: APIs you call out
to, and browsers, webhooks, and agents that call _in_. Fetch is the second
primitive, and like calling, it runs in both directions.

### Fetch out: hide a secret on the way

Outbound HTTP goes _through_ the context, so it can inject a secret the client
never sees. The client writes a sentinel, not a key:

```ts
// runs: the edge worker — add to the context's surface
async fetch(request: Request): Promise<Response> {
  const withSecret = await substituteHeaderSecrets(request, "project", (name) =>
    this.env.SECRETS_KV.get(`secret:${name}`),
  );
  return fetch(withSecret);
}
```

```ts
// runs: the client — calls OpenAI without ever holding the key
await itx.fetch(
  new Request("https://api.openai.com/v1/models", {
    headers: { Authorization: "Bearer {{secret:project:OPENAI_API_KEY}}" },
  }),
);
```

(`this.env` reaches an `RpcTarget` however you hand it in — constructor
injection, or the module-level `import { env } from "cloudflare:workers"`.)

If a token survives substitution, the context fails the request loudly (502) —
forwarding it would leak the secret's _name_ and send a garbage credential.
Loaded code gets the same deal for free: every `fetch()` a loaded isolate makes
is routed through this terminal.

### Fetch in: anything fetch-shaped can be a web server

Now the reverse. A value with a `fetch(request)` method is _fetch-shaped_ — and
the platform gives every fetch-shaped name a real HTTP door:

```
GET https://example.com/expression?context=prj_demo&itx=itx.todos.web
```

The edge forwards the expression to the context in the `x-itx-expression`
header; the context rewrites it through its rules as a terminal-fetch call, and
the value's `fetch` answers with a real `Response` — status, headers, streaming
body, even WebSocket upgrades. capnweb clients need no door: the same dotted
call with a live `Request` as its argument — `itx.todos.web.fetch(request)` —
rides the same lane from inside the session, WebSocket upgrades included.

### The tunnel: fetch into an rpc stub a _client_ provided

Put both directions together and something delightful falls out. A client can
provide a fetch-shaped stub — which means **the cloud can serve HTTP out of your
laptop**:

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

using tunnel = await itx.provide("itx.bla", new Tunnel());
```

Now `https://example.com/expression?context=prj_demo&itx=itx.bla` serves your
`localhost:3000` — WebSockets included, hot reload and all. The frames ride the
same capnweb session the provide came in on.

### Auth arrives as a side effect

The moment fetch-in exists, strangers can reach your context — so _who is
calling?_ stops being optional. The answer is a pattern, not a framework: you
can only get the real context by being handed it by a gate that checked
something.

```ts
// runs: the edge worker — this is now what /api serves
class UnauthenticatedSession extends RpcTarget {
  authenticate(credentials: { type: "shared-secret"; secret: string }) {
    if (credentials.secret !== this.env.SHARED_SECRET) throw new Error("bad credentials");
    return new Session(/* ... */); // only reachable past the check: session.projects.get(id) → IterateContext
  }
}
```

```ts
// runs: the client
using api = newWebSocketRpcSession("wss://example.com/api");
const itx = api.authenticate({ type: "shared-secret", secret: SECRET }).projects.get("prj_demo");
await itx.whoami();
```

(`authenticate` returns an RPC stub, and `projects.get` another — and note
there's no `await` on either: you can call methods on the unresolved stubs, so
authenticate, address a project, and make the first call all ride one round
trip. That pipelining is capnweb, free of charge.)

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

const { events, scannedThroughOffset } = await itx.readEvents(0);

using printer = await itx.subscribe({
  name: "printer",
  target: (events, range) => events.forEach((e) => console.log(e.type)),
});
```

- **`append`** — the commit point: idempotency keys honored, offsets from one
  monotonic sequence (this is the log every rewrite rule and every subscription
  is itself an event on), ephemeral events allowed.
- **`readEvents`** — a page of history plus how far the scan reached, so a client can
  chain pages without gaps.
- **`subscribe`** — appends one event,
  `events.iterate.com/stream/subscription-configured { name, target | null,
consumes? }`; a live callback is first lent to `itx.rpcStubs` (Chapter 1) under
  `subscription:<name>` and the target names it. HOW it is served is not
  declared: after each commit the context evaluates the target and looks at the
  value. A lent stub or a facet _owns its progress_, so it gets
  a push of `(events, range)`: over the pager, fire-and-forget, for a stub;
  awaited, in-DO, for a facet. No server cursor for either; a client owns its
  offset and heals any gap with `readEvents`. Anything else (a loaded entrypoint's
  `processEventBatch`, a sibling context) cannot, so the stream keeps a cursor
  for it and delivers at-least-once, retrying on its own alarm and halting with
  a fact after too many failures. Same name replaces; `target: null` removes.
  The handle is disposable: a subscription made through the verb is
  session-scoped, the raw event is the durable spelling.

The commit machinery is one dependency-injected class, no framework:

```ts
// runs: the context DO
new Stream({
  storage, // the DO's SQLite + alarms
  path, // the context's own address, stamped on every event
  projectId, // with `path`, the birth certificate's payload
  onCommit, // the post-commit fan-out: facets + subscribers (the core reduce is the stream's own)
});
```

The DO's constructor calls `stream.appendCreatedAndWokenEvents()` before any door opens: the first
incarnation appends `events.iterate.com/stream/created { projectId, path }` at
offset 1, then `events.iterate.com/stream/woken { incarnation }` at offset 2;
every later incarnation appends its `woken` first, and core's own live-state
delta takes offset 3 (an ephemeral). So your first `append` lands at offset 4,
and any door — a read, a snapshot — materializes a context.

### Processors: react to the log, as facets

A **stream processor** reduces the log into derived state. The processor is a
pure class extending the SDK's `StreamProcessor` (a contract and three hooks,
unit-tested with `new`); its host is just a facet (Chapter 1 machinery): a
`DurableObject` extending `StreamProcessorDurableObject` with one field,
`processor = new UnreadCounterProcessor()`, whose `processEventBatch` is subscribed to the
stream. `enableProcessor` is that subscribe, spelled for you — and durable, no
handle:

```ts
await itx.enableProcessor("unread-counts", {
  source: { "cap.js": COUNTER_SRC },
  className: "UnreadCounterDurableObject", // the host; `processor = new UnreadCounterProcessor()` inside
});
```

A processor's reduced state is queryable through its `snapshot()` — and even the
rewrite-rule table is reduced state: the context's own control events
(`events.iterate.com/stream/created`, `…/stream/woken`, `…/stream/paused`,
`…/itx/rewrite-rule-configured`, `…/stream/subscription-configured`, …) reduce
into ONE core reduce — `CoreStreamProcessor`,
the same `StreamProcessor` class you just wrote, run inline at the commit point
and read as `itx.facets.get('core').snapshot()`. "What rewrites to what" is one
slice of it (`itxExpressionRewriteRules`, a map by canonical match), reduced from
the same log that everything else rides. Policy that
need not gate an append synchronously stays out of core: a token-bucket breaker
is an ordinary facet processor that appends
`events.iterate.com/stream/paused { reason }`.

**That's the third primitive**: an append-only log with one commit point,
subscribers served over the pager, and processors — facets that reduce the log
into state.

---

## Chapter 4 — everything else is on top

Three primitives; the rest is composition, policy, and road ahead — the one home
for every FUTURE item:

**Shipped**

- **LiveState** — a processor's reduced state, made live: after each batch it
  appends an ephemeral `events.iterate.com/live-state/changed` delta
  `{key, from, to, patch}`; clients seed from `liveSnapshot()`'s `{rev, state}`
  (a mini-app's own door, such as `state()`, returns its `LiveState`'s snapshot),
  chain patches by revision,
  and re-read on any mismatch — lossy, always healable. A small React hook
  (`useLiveState`) rides this on the client.
- **Projects & routing** — a project is just the prefix of every context DO name
  (`prj_demo.iterate/agents/support-bot`). Four edge routes: `/api` (capnweb),
  `/expression` (Chapter 2's fetch-in door), `/version`, `/demo`.
- **Secrets** — Chapter 2's sentinel substitution, project- and platform-scoped,
  layered through an egress fallback chain.
- **MCP for agents** — put an MCP server in front of the context: each rewrite
  rule is a tool; a `tools/call` is an `itx.<match>(...)` invocation. Provide
  your robot from your desk — `itx.provide("itx.robot", robot)` — and your
  coding agent can make it nod. (The context layer is shipped; the MCP shim
  itself lives in the control plane, not yet wired to serving.)

**Ahead**

- **Real auth** — `authenticate()` in the shipped tree is today a no-op gate
  returning the `Session` (the catalog: `projects.get(id)`); the HMAC-signed session machinery exists in the control
  plane and drops into that one method without changing a single caller.
- **Trust** — the current model is _trusted clients_: intra-project
  coordination, no malicious-client defense, no signed events. Signing and
  membership stamps come with the auth wiring.
- **Git-backed config repos**, and a **device client** (the wire protocol is
  JSON over a WebSocket — an ESP32 can speak it; nobody has written the firmware
  yet).

---

## The shape of the whole thing

Contexts nest: a rule's target can be a facet that itself loads code and
configures rules — a call is an expression, an expression is rewritten and
walked, and every hop pipelines. Three primitives hold it all: **the context**
(rpc stubs and rewrite rules, called in both directions, hibernating on the
pager), **fetch** (out with secrets, in to anything fetch-shaped), and **the
stream** (one commit point; processors reduce it into state). Everything a client
can do is a call on `itx`; everything durable is a reduced event.

---

### Appendix: map to the source tree

The tree is laid out by primitive, one folder per chapter of this tutorial:

```text
src/
  worker.ts                          the edge: `/api` (capnweb) and `/expression` (fetch-in)
  session.ts                         UnauthenticatedSession → Session → ProjectCollection.get(id); SessionTeardown
  iterate-context.ts                 IterateContext, the client-facing RpcTarget — a proxy in front of the DO:
                                     cd · invoke · provide · subscribe · enableProcessor · disableProcessor
  iterate-context-durable-object.ts  IterateContextDurableObject — composes the stream, the rules, the stubs
  itx-entrypoint.ts                  env.ITX for loaded code
  context/   built-ins, expression, itx-expression-rewriting, dispatch, invoke-handle, dotted-path-proxy,
             rpc-stub-directory, rpc-stub-relay, worker-loader, durable-object-names
  fetch/     rpc-stub-fetch
  stream/    stream (the commit pipeline + the core reduce), events, processor (the engine), reduce-checkpoint, core-processor,
             subscriptions, subscription-delivery, live-state
  sdk/       index (→ processor.js), stream-processor-durable-object (the host)
  lib/       errors, logs, patch, timeout
  client/    the browser LiveState client + demo page      generated/  build outputs
e2e/         `pnpm e2e` — the real worker booted once, one <primitive>-<claim>.e2e.test.ts per claim,
             every test a capnweb client at /api (support/client.ts is the whole client surface)
__workers-tests__/  `pnpm test` (workers project) — inside workerd, the hibernation cases only
specs/       `pnpm spec` — Playwright drives the hosted /demo page
```

| Tutorial                                                     | Real code (`packages/v3/project-worker`)                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ch 1 edge worker + `IterateContext` + `provide`              | `src/worker.ts` (`/api`), `src/iterate-context.ts`                                                                                                                                                                                                                                  |
| Ch 1 the context DO                                          | `IterateContextDurableObject`, `src/iterate-context-durable-object.ts`                                                                                                                                                                                                              |
| Ch 1 rewrite rules / the walker                              | `src/context/itx-expression-rewriting.ts` (the rules 1–5, `rewriteRuleConfiguredEvent`, `ItxExpressionResolver`), `src/context/expression.ts` (the codec), `src/context/dispatch.ts` (the step walk); the edge verb `provide` in `src/iterate-context.ts`                           |
| Ch 1 workers.get / facets.get / tail replay                  | `src/context/built-ins.ts`, the DO's private facet door                                                                                                                                                                                                                             |
| Ch 1 the pager (the `itx.rpcStubs` built-in's backing table) | `RpcStubDirectory`, `src/context/rpc-stub-directory.ts` (two layers: borrowed stubs, then pagers), and the edge's `lendRpcStubOverPager`, `src/context/rpc-stub-relay.ts`; the built-in itself in `src/context/built-ins.ts`, the edge half (`provide`) in `src/iterate-context.ts` |
| Ch 2 secret sentinel                                         | `{{secret:project:NAME}}` — `../shared/src/egress.ts`, the DO's `#egress` terminal                                                                                                                                                                                                  |
| Ch 2 fetch-in / tunnel                                       | `/expression` in `src/worker.ts`, `src/fetch/rpc-stub-fetch.ts` (the `x-itx-expression` lane), `upgradeWebSocketResponse` in the capnweb fork                                                                                                                                       |
| Ch 2 auth gate                                               | `UnauthenticatedSession.authenticate()` → `Session` → `projects.get(id)` in `src/session.ts`                                                                                                                                                                                        |
| Ch 3 stream                                                  | `Stream` in `src/stream/stream.ts`                                                                                                                                                                                                                                                  |
| Ch 3 subscribe / the one delivery loop                       | `src/stream/subscriptions.ts` (the one command; the reduce is `src/stream/core-processor.ts`), `src/stream/subscription-delivery.ts` (push vs stream-kept cursor, decided by the evaluated target)                                                                                  |
| Ch 3 processors                                              | `StreamProcessor` (pure author class) + `ProcessorEngine` in `src/stream/processor.ts`; the host `src/sdk/stream-processor-durable-object.ts` (bundled into `processor.js`)                                                                                                         |
| Ch 4 LiveState / control plane                               | `src/stream/live-state.ts`; `packages/v3/control-plane` (not yet wired)                                                                                                                                                                                                             |
