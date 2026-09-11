# The Iterate Context, layer by layer

This is the platform built brick by brick, in the order the code builds it. Each chapter adds one
idea and ends with something you can call. Each chapter exists because the one before it left a
flaw on the table, and the flaw is named before the next brick is laid.

You are a strong engineer meeting the platform for the first time. Two facts to hold first:

- **A client is just a capnweb peer.** There is no client SDK. What you hold is a plain capnweb
  proxy of a server-side `RpcTarget`; your only dependency is the `capnweb` package
  (`npm:@iterate-com/capnweb`). Everything a client does is one dotted expression on `itx`.
- **Two words are kept apart, because the code keeps them apart.** An **rpc stub** is physical:
  a live value a session LENDS under a key, which the context BORROWS and RETURNS at idle. A
  **rewrite rule** is pure data, `{ match, target }`: a call starting with `match` runs as the same
  call with `match` replaced by `target`. One is a socket; the other is a row.

Every client snippet is a call the e2e lane makes today against the one real worker, and ends with
a comment naming the test file it is lifted from (`// e2e/secrets.e2e.test.ts`); one assembled from
pieces of the lane is marked `(composed)`. Server snippets are the real code, abridged; an elision
is marked `// …`. Names in code are fully qualified (`itx.rewriteRules.list()`, never `rules.list()`).

Every snippet assumes this preamble — exactly how the lane opens a session. The demo project is
`acme-support` throughout:

```ts
import { newWebSocketRpcSession } from "capnweb";

const wsApi = new URL("/api", WORKER_BASE_URL); // the one worker under test: a local boot, or the deployed one
wsApi.protocol = "ws:";

/** A fresh session — an UnauthenticatedSession stub. Hold it with `using`: a capnweb stub is
 *  disposable, and disposing the session says goodbye — every stub it lent is recalled, every
 *  handle it holds disposed (chapter 1). */
export const session = () => newWebSocketRpcSession(wsApi.toString());

/** The lane's credential — the deployment's admin secret, every project; a browser names its
 *  login cookie instead. */
export const adminCredentials = () => ({ type: "admin-secret", secret });

/** The lane's shorthand: a project's ROOT context on a fresh session. The lane registers that
 *  session for disposal in afterEach; in your own code the session is the `using` (below). */
export function openItx(project: string) {
  return session().authenticate(adminCredentials()).projects.get(project); // the project's root IterateContext
}
// e2e/support/client.ts (session, adminCredentials, openItx) · the `using` row: e2e/session-wire-frames-one-round-trip.e2e.test.ts
```

Nothing is awaited on the way in: `authenticate(credentials)`, `.projects`, `.get(project)` are one pipelined
capnweb chain, and the first call on the result flushes it. What you dispose is the session, never
a context: `IterateContext` has no `Symbol.dispose`; the session stub and every `provide` /
`subscribe` handle do. There are exactly three primitives —
the **context** (things you can call, in both directions), **fetch** (in both directions), and the
**stream** — and everything after chapter 0 is composition.

---

## 0. The shape

### One worker, one package

`src/worker.ts` is the stateless edge: capnweb terminates at `/api`; a project host —
`<app>--<project>.<base>`, `<app>.<project>.<base>` (parsed and served locally; deployed, the
one-label wildcard certificate does not cover it), or the apex `<project>.<base>`, `<project>` an
id or a slug — is routed by hostname into the project's root context, the app label riding as a
trusted `x-iterate-app` header the DO's fetch lane ALWAYS overwrites; and everything else on the worker's own
hostname is the control plane, in-process (`src/control-plane.ts`: an OAuth 2.1 Authorization
Server, a D1 directory of users, orgs and projects, `/mcp`, a console with a login form). A project
host is the one HTTP way in: an app host answers with the app, and a host naming no app with the
project's config worker (chapter 7), whose `fetch` routes by hostname.
`src/iterate-context-durable-object.ts` is THE CONTEXT: one Durable Object per `{ projectId, path }`,
holding the event log, the core reduce, subscription delivery, the facets, the rpc-stub pagers and
the fetch door.

> **Landing:** a custom hostname the directory knows (`acme.com`, `<app>.acme.com`) is a later
> build — a hostname row and a lookup by hostname; the three shapes under the base are what the edge
> serves today (apps/os's `decideIngressRoute` is the model).

The hard rule: capnweb never terminates in the Durable Object. The edge is a proxy in front of the
DO and reaches it only over Workers RPC. Everything you hold is minted at the edge.

### A client is a capnweb peer, and the door is `authenticate(credentials)`

`/api` serves an `UnauthenticatedSession` whose only door is `authenticate(credentials)`. It answers
a `Session`: a catalog that vends contexts, never a context itself. `Session.projects.get(project)`
and `Session.projects.create({ project })` vend a project's ROOT context — the `IterateContext` you
will call `itx` from here on. The credential names where the identity already is, or the secret
that proves it (chapter 10 has the four kinds).

```ts
// session.ts — what /api hands a client BEFORE it holds a context (abridged)
export type SessionCredentials =
  | { type: "from-server-cookie" } // a browser: the login cookie rode the handshake, same origin only
  | { type: "project-token"; token: string } // one user on one project
  | { type: "project-secret"; project: ProjectIdOrSlug; secret: string } // the project itself: a device, a headless app
  | { type: "admin-secret"; secret: string; as?: { sub: string; email: string } }; // every project; `as` impersonates
export class UnauthenticatedSession extends RpcTarget {
  async authenticate(credentials: SessionCredentials): Promise<Session> { /* … */ }
}
class Session extends RpcTarget {
  whoami(): SessionPrincipal { /* … */ }
  get projects(): ProjectCollection { /* … */ } // a GETTER: capnweb exposes prototype members only
}
class ProjectCollection extends RpcTarget {
  list(): Promise<Project[]> { /* … */ }
  create(input: { project: ProjectIdOrSlug }): Promise<IterateContext> { /* … */ }
  get(project: ProjectIdOrSlug): Promise<IterateContext> { /* … */ }
}
```

The first thing to call is `whoami`; it answers from the Durable Object's own name:

```ts
using api = session(); // scope exit says goodbye: every stub this session lent is recalled
const itx = api.authenticate(adminCredentials()).projects.get("acme-support");
const who = await itx.invoke(["itx", ["whoami"]]);
// { projectId: "acme-support", path: "/" }
// e2e/context.e2e.test.ts · the `using` row: e2e/session-wire-frames-one-round-trip.e2e.test.ts
```

### The client helpers

There is no client SDK today: the two lines above are what every client writes by hand, and they
are all the lane's `openItx` does. The stack that should exist is two helpers, one layered on the
other — an open design, not a decision:

```ts
// PROPOSED, not built — the names are placeholders; the layering is the point
using iterate = await connectToIterate({ baseUrl: "https://<worker>", credentials: { type: "project-token", token } }); // a Session: whoami, projects
using itx = await connectToIterateProject({ baseUrl, credentials, project: "acme-support" }); // the project's root context, on a session of its own
```

`connectToIterate` opens `/api` and authenticates: one session, many projects, the thing you
dispose. `connectToIterateProject` is that plus `projects.get(project)`, for the client that lives
in one project; disposing it disposes the session it opened. Both take the `credentials` union
`authenticate` takes, so a browser, a script and a device differ in one field.

> **Landing:** an open design — today's clients import `capnweb` and write the two lines
> themselves (`e2e/support/client.ts`).

### The three primitives, met once each

**The context, called in both directions.** `whoami` was the server side answering; the other
direction is you handing the server a function and the server calling it — chapter 1. **Fetch, in
both directions.** A `Request` rides the wire as a value and a `Response` rides back:
`itx.fetch(request)` is fetch in the context of this project, a project host is fetch INTO it —
chapter 8. **The stream.** Every context
is an append-only event log: `itx.append` commits, `itx.readEvents` pages, `itx.waitForEvent` blocks
for the next match — chapter 4.

### The explicit door and the dotted sugar

`IterateContext` declares only a handful of methods (`cd`, `invoke`, `provide`, `subscribe`,
`mintToken`, `rotateApiKey`). Everything else you write on `itx` — `itx.whoami()`,
`itx.kv.put('k','v')`, `itx.slack.chat.postMessage(…)` — is a prototype hop that accumulates the
unknown segments into ONE `invoke(expression)` (`installPrototypeInvokeFallback`,
`src/context/expression.ts`). The two spellings are the same call:

```ts
const who = await openItx("acme-support").whoami(); // { projectId: "acme-support", path: "/" }
expect(await itx.kv.put("k", "v")).toMatchObject({ ok: true });
expect(await itx.kv.get("k")).toBe("v");
// e2e/context.e2e.test.ts
```

`/version` answers `<deployId> <environmentName>`, the stamp a deploy smoke waits for
(`e2e/session.e2e.test.ts`). One more door, supported and not front and center: capnweb's one-shot
HTTP batch (`newHttpBatchRpcSession`) is served at the same `/api` for a cron or a script — one
POST, every chained call flushed in it, reads and writes only, no live capability
(`e2e/session.e2e.test.ts`).

**What this brick leaves on the table:** a context that answers `whoami` and stores a key has
nothing of yours in it. Nothing you run can be called from the cloud.

---

## 1. rpc stubs: lend a live object

### `provide(match, stub)` lends a live object under a key

A connected client hands the server a live object, and any other caller — another client, or code
running in the cloud — can call it. A bare async function is enough; capnweb passes functions by
reference.

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const laptop = openItx("acme-support"); // a node process on your machine
const otherClient = openItx("acme-support"); // anyone else in the project — a browser tab, an agent

await laptop.provide("itx.runOnMyComputer", async (cmd: string, args: string[]) => {
  const { stdout } = await promisify(execFile)(cmd, args); // runs HERE, on the laptop
  return stdout;
});

const listing = await otherClient.runOnMyComputer("ls", ["-la"]); // the laptop's directory listing, through the cloud
// e2e/rpc-stubs-values.e2e.test.ts — the lane's stub is a fake (it answers `stdout of ls -la` and spawns nothing); the two calls are these
```

Two things happened, and one verb made both. The function is physical — a capnweb reference your
session holds — so it is LENT to the context's registry, `itx.rpcStubs`, under a key; for `provide`
the key IS the canonical match, `"itx.runOnMyComputer"`. The name you called it by is data: a
rewrite rule `itx.runOnMyComputer ⇒ itx.builtins.rpcStubs.get('itx.runOnMyComputer')`, appended to
the log as one event. Chapter 3 is the rule; for now, the log records the rule and never the socket.

### Where the stub lives: the edge, never the DO

The client's capnweb stub lives in the stateless worker that terminates its session and cannot be
moved, and the Durable Object must hibernate with any number of clients attached. So the directory
has two layers: the BORROWED table (a stub lent under an opaque key, kept while traffic flows,
returned at the idle quiesce) and the PAGERS (one hibernatable WebSocket per key, the edge's standing
offer to lend the key back on demand):

```ts
// context/rpc-stubs.ts — the DO side, abridged
async invokeRpcStub(rpcStubKey: string, itxExpressionSteps: ItxExpression): Promise<unknown> {
  let borrowed = this.#borrowedRpcStubs.get(rpcStubKey); // 1. have we got it? call it
  if (!borrowed && this.#rpcStubPagerFor(rpcStubKey))
    borrowed = await this.#pageRpcStub(rpcStubKey); // 2. can a pager lend it back?
  if (!borrowed)
    throw codedError("RPC_STUB_OFFLINE", `rpc stub ${JSON.stringify(rpcStubKey)} is offline`);
  // …a terminal `fetch(request)` rides the rpc-stub fetch path (chapter 8); everything else:
  return await borrowed.invoke(itxExpressionSteps);
}
```

`invokeRpcStub` IS the two `if`s. The pager is opened in ONE request — the upgrade's
`x-itx-rpc-stub-pager` header carries the key and the events that name it, and the DO appends those
events in the same turn it accepts the socket — so a `provide` costs the edge one round trip:

```ts
// iterate-context.ts — the live branch of `provide`, abridged
async provide(match, target) {
  const matchString = canonicalItxExpressionPrefix(match);
  // …an expression or null target is the pure-data branch (chapter 3)
  const ruleEvent = rewriteRuleConfiguredEvent(matchString, ["itx", "builtins", "rpcStubs", ["get", matchString]]);
  const pager = await lendRpcStubOverPager(this.#durableObject, target, matchString, [ruleEvent], this.#waitUntil);
  const lease = this.#sessionTeardown.add(this.#sessionTeardownKey(matchString), pager);
  return new RewriteRuleHandle(() => lease.dispose()); // the lease IS the handle
}
```

On the log the rule's offset is BELOW the key's ephemeral `rpc-stub/attached` event: the DO appended
the rule while accepting the pager, before it announced presence (`e2e/rpc-stubs-reconnect-and-attach.e2e.test.ts`).

### The dotted surface reduces to `invoke`

A lent object can be as deep as you like. The Slack shape — an `RpcTarget` whose getters return
plain objects of functions — is replayed onto exactly the dotted spelling every client writes:

```ts
const bridgeItx = openItx("acme-support");
const slack = new SlackReplayTarget(); // get chat → { postMessage }, get conversations → { list }
const slackProvided = await bridgeItx.provide("itx.slack", slack);

const itx = openItx("acme-support");
const posted = await itx.slack.chat.postMessage({ channel: "#general", text: "hello from itx" });
expect(posted.ok).toBe(true);
// the desugared form the dotted spelling compiles to, and the string half of the codec
await itx.invoke(["itx", "slack", "chat", ["postMessage", { channel: "#general", text: "via explicit door" }]]);
const listed = await itx.invoke(`itx.slack.conversations.list({ limit: 10 })`);
expect(listed.channels.length).toBe(2);
// e2e/rpc-stubs-values.e2e.test.ts
```

Every hop is native — capnweb → the edge → Workers RPC → the DO → the rules → `itx.builtins.rpcStubs.get('itx.slack')`
→ page → the lent stub → the relay → capnweb → the bridge's SDK instance — and there is no per-method table anywhere.

### The other direction: a callback fires back where it was made

Anything capnweb can serialize rides through a lent stub — a `Date`, bytes, a `Request` in and a
`Response` out, an `RpcTarget` with methods, and a callback the provider calls BACK across every
hop:

```ts
await itxA.provide("itx.tools", new ToolsA()); // transform(x, cb) { return `A:${await cb(x * 2)}` }
const cbResult = await itxB.invoke(["itx", "tools", ["transform", 21, async (n: number) => n + 1]]);
expect(cbResult).toBe("A:43"); // A called B's callback (42 → 43) and returned
// e2e/rpc-stubs-values.e2e.test.ts
```

The same lane works from cloud code: a loaded worker (chapter 7) writes `itx.demo.timer.callLater(250,
cb)` on `env.ITX.get()` and the callback runs back inside it (`e2e/rpc-stubs-values.e2e.test.ts`).

### Disposing recalls; the session ending recalls; presence is physical

`provide` hands back a DISPOSABLE handle. Disposing it recalls the stub; capnweb disposes every
exported handle when the session ends, so a dying session recalls everything it lent. Presence —
`itx.rpcStubs.list()` — is the keys with an open transport RIGHT NOW, and it shrinks at once:

```ts
const observer = openItx("acme-support");
{
  using sA = session();
  await sA.authenticate(adminCredentials()).projects.get("acme-support").provide("itx.ghosttool", new Tools("ghost"));
  expect(await observer.invoke(["itx", "ghosttool", ["hello"]])).toBe("hello-from-ghost");
  expect(await observer.rpcStubs.list()).toContain("itx.ghosttool");
} // ← Symbol.dispose fires here: the client session ends, every handle it holds is disposed

await until(async () => !(await observer.rpcStubs.list()).includes("itx.ghosttool")); // presence shrinks…
const err = await rejection(observer.invoke(["itx", "ghosttool", ["hello"]]));
expect(err.code).toBe("NO_ITX_EXPRESSION_MATCH"); // …then the rule is un-set: default-deny again
// e2e/session-wire-frames-one-round-trip.e2e.test.ts (the `using` row) · e2e/rpc-stubs-lend-recall-and-offline.e2e.test.ts
```

Two codes, two situations. `NO_ITX_EXPRESSION_MATCH` is default-deny: nothing names the call.
`RPC_STUB_OFFLINE` is narrower: a rule names a key nobody has lent under right now — a hand-written rule, or a provider that died mid-call:

```ts
await itx.provide("itx.laterTool", "itx.rpcStubs.get('itx.later')"); // a rule to a key nobody lent
expect((await rejection(itx.invoke("itx.laterTool.hello()"))).code).toBe("RPC_STUB_OFFLINE");
await openItx("acme-support").provide("itx.later", new Tools("later")); // now someone lends it
expect(await itx.invoke("itx.laterTool.hello()")).toBe("hello-from-later");
// e2e/rpc-stubs-lend-recall-and-offline.e2e.test.ts
```

Re-providing the same match replaces the transport (the old pager closes "replaced") and appends one
more rule event; the map still holds one rule. Disposing a STALE handle after a reconnect tears down
nothing of its replacement — the lease is the handle (`e2e/rpc-stubs-reconnect-and-attach.e2e.test.ts`).

### Lends are per context

One session hands out an `IterateContext` per context, and an rpc-stub key is only unique per
context. The root and `/sub` may both lend under `itx.clash`, and both stay callable — the
session's teardown keys by `[iterateContextName, rpcStubKey]`:

```ts
using s = session();
const a = s.authenticate(adminCredentials()).projects.get("acme-support"); // the root context
const b = a.cd("/sub"); // another context of the project, same session
await a.provide("itx.clash", (x: number) => x + 1);
await b.provide("itx.clash", (x: number) => x + 100);
expect(await a.invoke("itx.clash(1)")).toBe(2);
expect(await b.invoke("itx.clash(1)")).toBe(101);
// e2e/session.e2e.test.ts
```

Contexts can still inherit from one another — through the rules, not the registry. A child's
WHOLE-CONTEXT override, `provide("itx", "itx.builtins.cd('/')")`, sends every call no more specific
row of the child claims — the built-in roots included — to the project root, resolved through the
root's rules, so a lend on the root is reachable from every child that says so. The target must be
the physical spelling `itx.builtins.cd('/')`: the door refuses `itx.cd('/')`, which would re-enter
the table the row just claimed (chapter 3 has the rule):

```ts
using s = session();
const root = s.authenticate(adminCredentials()).projects.get("acme-support");
await root.provide("itx.tool", new Tools("root")); // lent at the root only
await root.cd("/x").provide("itx", "itx.builtins.cd('/')"); // /x inherits: every unclaimed call goes to the root, through its rules
expect(await root.cd("/x").invoke("itx.tool.hello()")).toBe("hello-from-root"); // (composed)
expect(await root.cd("/x").builtins.whoami()).toEqual({ projectId: "acme-support", path: "/x" }); // the physical door at /x is still /x
// e2e/rewrite-rules.e2e.test.ts — the whole-context override row (`root.cd("/x").provide("itx", live)`) and the door row (`itx.cd('/x')` refused, "physical spelling"; `itx.builtins.cd('/y')` accepted)
```

**What this brick leaves on the table:** the name you called the stub by was a string we never
explained, and `itx.invoke("itx.clash(1)")` is a string that carries arguments. And a lent stub dies
with its session: nothing you have made so far outlives you.

---

## 2. itx expressions: what a call is

### A call is data

Every call on `itx` is one value, an **itx expression**: the scope root `itx`, then steps. A step is
a property read (a string) or a call (`[method, ...args]`) whose args are plain JSON. The codec
(`src/context/expression.ts`) has two halves that mean the same thing:

| Half | Shape | Example |
| --- | --- | --- |
| string | dotted names, `.method(args)` with JSON5 args | `"itx.kv.get('x')"` |
| array | `ItxExpression`: `["itx", ...steps]` | `["itx", "kv", ["get", "x"]]` |

`ItxExpressionInput` is either; every door that dispatches accepts both, and the dotted sugar
compiles to the array half. You used all three spellings on one call in chapter 1
(`itx.slack.chat.postMessage(…)`, the array, the JSON5 string). Two more shapes. `invoke(call,
...args)` applies LIVE args to the value the expression denotes — the string is the pure part, the
args the live part:

```ts
await itx.kv.put("k", "v");
expect(await itx.invoke("itx.kv.get", "k")).toBe("v"); // a name-final call plus its live arg
expect(await itx.invoke("itx.whoami()")).toMatchObject({ projectId: "acme-support" }); // no args: the call as spelled
// e2e/rewrite-rules.e2e.test.ts
```

And the ANONYMOUS call step, method `""`, calls the value itself. It is what a rule spells when a
lent bare function is called with args: `itx.clash(1)` on `itx.clash ⇒
itx.builtins.rpcStubs.get('itx.clash')` runs as `["itx","builtins","rpcStubs",["get","itx.clash"],["",1]]`
— which is how `a.invoke("itx.clash(1)")` reached a bare function with `1`.

### Why a string

Because expressions are persisted NAMES: a rule's target, a subscription's target, a facet's hosting
spec. Deleting the name IS revocation. A string is what a person types; the parsed form is what the
platform stores. Both go through the codec's one door — a string is parsed once and PRINTED back
canonically (whitespace, quotes and key order normalized), an array is shape-checked in place — so
`itx.rewriteRules.get(match)` finds a row however you spell the match
(`e2e/rewrite-rules.e2e.test.ts`). One sizing rule follows: a STRING expression is
capped at 2 KiB (`EXPRESSION_TOO_LONG`); anything bigger — a worker's source — rides the array half,
plain data that never meets the JSON5 parser. Two reserved spellings belong to chapter 3: `@`, the
caller's input, and the root `itx.builtins`, the physical scope.

### `cd(path)` is pure addressing

A project has many contexts, addressed by path. `itx.cd(path)` names another context of THIS
project; pure addressing, no Durable Object hop. Absolute by convention, relative resolves against
the current path, and the result is canonical, so no spelling can mint a twin:

```ts
await itx.invoke("itx.cd('x').append({type:'ping-x'})");
const page = await itx.invoke("itx.cd('/x').readEvents(0, 50)");
expect(page.events.map((e) => e.type)).toContain("ping-x"); // cd('x') and cd('/x') are ONE context
const [self] = await itx.invoke("itx.cd('').append({type:'self-ping'})"); // '' is THIS context
// e2e/context.e2e.test.ts
```

There are two `cd` doors on purpose. The edge `IterateContext.cd(path)` returns an EDGE context, so
a later `provide` on it lends in your session (`a.cd("/sub").provide(…)` in chapter 1); the built-in
`itx.cd(path)` inside an expression is for expressions evaluated INSIDE the DO, where there is no
edge — a subscription target `itx.cd('/archive').append`. Same resolver, two evaluation sites. A
context's Durable Object name is `{projectId}.iterate{path}`, the project id gated to `[A-Za-z0-9_-]`
at the one place every name is parsed — the isolation wall: a `:` can never be spelled, so a
project-prefixed KV key can never alias another project's.

### The words that never become segments

The prototype hop hides JS and transport machinery at every depth — `then`, `dup`, `onRpcBroken`,
`toString`, `constructor` and their kin — so a protocol probe can never conjure a dispatcher: awaiting
a dangling chain node settles to a live handle, `JSON.stringify` of one fires nothing, a settled stub
is not a thenable (`e2e/context.e2e.test.ts`).

**What this brick leaves on the table:** every call so far resolved to a built-in or to a lent
stub. Nothing durable names anything: your laptop's function has a name only while your socket is
open.

---

## 3. rewrite rules: a durable name for a target

### `provide(match, expression)` is a pure rewrite

The same verb, with an expression instead of a live object. Nothing is lent; one event is appended,
`events.iterate.com/itx/rewrite-rule-configured { match, target }`. From then on a call starting
with `match` runs as the same call with `match` replaced by `target`:

```ts
await itx.provide("itx.notify", "itx.slack.chat.postMessage"); // a rule onto the live bridge
const rewritten = await itx.invoke(`itx.notify({ channel: '#alerts', text: 'rewritten!' })`);
expect(rewritten.ok).toBe(true);
// e2e/rpc-stubs-values.e2e.test.ts
```

Rules chain, and `itx.rewriteRules.resolve(call)` shows the chain — the pure half of `invoke`, each
rewrite printed, ending at the call that would run:

```ts
await itx.kv.put("k", "v");
await itx.provide("itx.db", "itx.kv");
await itx.provide("itx.store", "itx.db");
expect(await itx.rewriteRules.resolve("itx.store.get('k')")).toEqual([
  "itx.store.get('k')",
  "itx.db.get('k')",
  "itx.kv.get('k')",
  "itx.builtins.kv.get('k')", // the fixed point: this is what runs
]);
// THE LAW: invoke(call) ≡ invoke(resolve(call).at(-1))
for (const call of ["itx.store.get('k')", "itx.whoami()", "itx.builtins.kv.get('k')"]) {
  const chain = await itx.rewriteRules.resolve(call);
  expect(await itx.invoke(chain.at(-1))).toEqual(await itx.invoke(call));
}
// e2e/rewrite-rules.e2e.test.ts
```

### The seven rules, in plain words

`src/context/itx-expression-rewriting.ts` is one file: the rules, the one event, the resolver.
Every rule below is a row in its table test.

1. **A match is a prefix.** Dotted names; any step may be a call step that pins literal args:
   `itx.ai.run('gpt-5')`.
2. **A name step matches the same property** — or, as the final step, a call of that name. A call
   step matches a call whose leading args equal the pinned literals; pinned args are CONSUMED.
3. **The most specific row wins:** longest match, then most pinned args. A bare `itx` row matches
   every call — the whole-context override.
4. **The rewrite is the target, then the unpinned args, then the call's remaining steps.** Args
   fold into the target's final step when it is a name (`itx.grok ⇒ itx.openai.chat`, so
   `itx.grok(x)` becomes `itx.openai.chat(x)`); otherwise they become an anonymous call on the
   target's result (`itx.cam ⇒ itx.builtins.rpcStubs.get('cam')`, so `itx.cam(1)` becomes
   `itx.builtins.rpcStubs.get('cam')(1)`). A target denotes a VALUE; calling the match calls it.
5. **The fixed point is `itx.builtins`.** A call rooted there runs as is and never reads the
   table. Any other `itx.…` call: RULES FIRST — a matching row whose target is `null` is a MASK and
   the call is refused; a matching row rewrites and the loop repeats; no matching row and a root
   that is a built-in is the IMPLICIT PLATFORM ROW `itx.<root> ⇒ itx.builtins.<root>`, applied and
   done; anything else is `NO_ITX_EXPRESSION_MATCH`, default-deny. 32 rewrites is the budget.
6. **The door.** A match is rooted at `itx`, never at `itx.builtins`, never at a proxy verb
   (`cd`, `invoke`, `provide`, `subscribe`). A target is
   rooted at `itx`. A whole-context override must target the physical spelling `itx.builtins.…`
   and may not name its own context.
7. **`@` is the caller's input.** A target whose final call step holds `@` is a template. As a
   top-level argument `@` is the unpinned argument list, spliced; nested inside an object or array
   literal it is THE one argument; `...@` as an object entry merges the one argument's fields under
   the template's own keys, the template winning.

The resolver (`resolveItxExpression` in the same file) is rule 5 as a loop: while the call is not
rooted at `itx.builtins`, pick the most specific context row and rewrite (a `null` target throws
`NO_ITX_EXPRESSION_MATCH` "is masked"); with no row, a built-in root becomes `itx.builtins.<root>` and
the loop ends; one more platform row, `itx.worker`, is chapter 7's; anything else is
`NO_ITX_EXPRESSION_MATCH` "no rewrite rule matches … (default-deny; configure a rule first)".

### The implicit platform rows, and `itx.builtins`

The built-ins are a plain record (`src/context/built-ins.ts`, the `BuiltInScope` interface), and THE
RECORD IS `itx.builtins`. `itx.builtins.kv.get('x')` runs against it directly and reads no rule. The
short name `itx.kv.get('x')` reaches the same door through the implicit platform row — never stored,
applied by the resolver when no context row matches. `itx.rewriteRules.list()` is the EFFECTIVE
table, your rows plus the platform rows, each with its origin:

```ts
const before = await itx.rewriteRules.list();
expect(before).toContainEqual({ match: "itx.kv", target: "itx.builtins.kv", origin: "platform" });
expect(before).toContainEqual({ match: "itx.worker", target: expect.stringMatching(/^itx\.workers\.get\(/), origin: "platform" }); // the config worker's default (chapter 7)
await itx.provide("itx.kv", "itx.builtins.whoami");
const after = await itx.rewriteRules.list();
expect(after.filter((row) => row.match === "itx.kv")).toEqual([
  { match: "itx.kv", target: "itx.builtins.whoami", origin: "context" }, // replaced the platform row in the listing
]);
// e2e/rewrite-rules.e2e.test.ts
```

The platform never spells a short name: every expression it writes — the proxy's own append, a lent
stub's rule, a processor's row — is rooted at `itx.builtins`, so a row you put at `itx.rpcStubs`
redirects YOUR calls and nothing the platform relies on. Mask `itx.rpcStubs` with `null`, and
`provide("itx.tool", fn)` still lands and serves while `itx.builtins.rpcStubs.list()` still answers
(`e2e/rewrite-rules.e2e.test.ts`).

### Masks: `provide(match, null)`

`null` is a deliberate DENY where a platform row lies beneath, and a plain deletion elsewhere. A mask
refuses the short name; the physical door still answers; a partial mask refuses only what it claims;
disposing the deny lifts it; the platform-equivalent target deletes the row explicitly:

```ts
await itx.kv.put("k", "v");
const deny = await itx.provide("itx.kv", null);
expect((await rejection(itx.kv.get("k"))).code).toBe("NO_ITX_EXPRESSION_MATCH"); // "is masked"
expect(await itx.builtins.kv.get("k")).toBe("v"); // the row: { match: "itx.kv", target: null, origin: "context" }
await itx.provide("itx.kv.put", null); // a partial mask under the root
deny[Symbol.dispose](); // lifts the mask at itx.kv…
expect(await itx.kv.get("k")).toBe("v");
expect((await rejection(itx.kv.put("k", "w"))).code).toBe("NO_ITX_EXPRESSION_MATCH"); // …the partial one stands
await itx.provide("itx.kv.put", "itx.builtins.kv.put"); // the platform-equivalent target DELETES the row
expect(await itx.rewriteRules.get("itx.kv.put")).toBeNull();
// e2e/rewrite-rules.e2e.test.ts
```

Under a name with nothing beneath, `null` simply deletes and the match is default-deny
(`e2e/rewrite-rules.e2e.test.ts`).

### Pinned arguments

A match may pin literal args on a call step. The pinned row is more specific than the plain one, the
pinned args are consumed, and a live stub can sit behind a pinned match:

```ts
await itx.provide("itx.llm.run", "itx.kv.get"); // the plain rule: itx.llm.run(k) → itx.kv.get(k)
await itx.provide("itx.llm.run('special')", "itx.whoami"); // pinned: itx.llm.run('special') → itx.whoami()
await itx.invoke("itx.kv.put('other', 'from-kv')");
expect(await itx.invoke("itx.llm.run('special')")).toMatchObject({ projectId: "acme-support" });
expect(await itx.invoke("itx.llm.run('other')")).toBe("from-kv");
await itx.provide("itx.llm.run('live')", (...unpinned) => `live:${JSON.stringify(unpinned)}`);
expect(await itx.invoke("itx.llm.run('live', 7)")).toBe("live:[7]"); // the pinned arg never reaches the stub
// e2e/rewrite-rules.e2e.test.ts
```

### `@`, the caller's input

`itx.ai` is Cloudflare's Workers AI binding, verbatim, under the platform row. THE DREAM is one
rule: `itx.fable ⇒ itx.ai.run('@cf/…', @)` pins the model and splices the caller's inputs and
options into the call:

```ts
const MODEL = "@cf/meta/llama-3.2-1b-instruct";
await itx.provide("itx.ai", new FakeAi()); // a test shadows the binding (below); deployed, the real one answers
await itx.provide("itx.fable", `itx.ai.run('${MODEL}', @)`);
expect(await itx.fable({ prompt: "hi" })).toEqual({ response: `deterministic:${MODEL}`, inputs: { prompt: "hi" } });
expect(await itx.rewriteRules.resolve("itx.fable({ prompt: 'hi' })")).toEqual([
  "itx.fable({prompt:'hi'})",
  `itx.ai.run('${MODEL}',{prompt:'hi'})`,
  `itx.builtins.rpcStubs.get('itx.ai').run('${MODEL}',{prompt:'hi'})`,
]);
// e2e/ai-root-shadow-and-fable.e2e.test.ts
```

THE GATEWAY SHAPE is the merge form: `itx.claude ⇒ itx.ai.gateway('g').run({ provider:
'anthropic', endpoint: 'v1/messages', query: { model: 'claude-x', ...@ } })` merges the caller's
fields under the pinned model — a caller passing `model: "evil"` still runs `claude-x`. `@` is refused
in a match, in a call, and outside a target's final step, in the marker's own words.

### The table is a map; the raw event is the durable spelling

The table is a plain record keyed by canonical match: set replaces, `null` deletes or masks, no
stack, no identity beyond the match — five concurrent re-sets of one match leave the last-committed
target and five events. A rule made through `provide` is SESSION-SCOPED (the handle is disposable,
and the session's end disposes it); a rule that must outlive its session is the raw event, the verb
minus the handle. Rules are event-sourced, so 300 of them go in one append:

```ts
const rules = Array.from({ length: 300 }, (_, i) => ({
  type: "events.iterate.com/itx/rewrite-rule-configured",
  payload: { match: `itx.m${i}`, target: ["itx", "whoami"] },
}));
expect(await itx.append(...rules)).toHaveLength(300);
expect(await itx.invoke(["itx", ["m299"]])).toMatchObject({ projectId: "acme-support", path: "/" });
// e2e/rewrite-rules.e2e.test.ts
```

The event stores the match as its canonical string and the target in the parsed form (a target may
carry a facet's whole source, which must never go through the string codec again); a raw event with
a string target is parsed at the reduce, and a malformed one is skipped without wedging later rules.

### Shadowing a root with a stub, and what dies with the stub

Misha's test, on the real root: `provide("itx.ai", fake)` shadows the binding for the context;
`itx.builtins.ai` stays the real one; disposing the handle restores the platform row — because the
DO un-sets the rule when the stub's LAST pager closes, and a removal is spelled as the
platform-equivalent target, never as `null` (which would mask):

```ts
expect(await itx.rewriteRules.get("itx.ai")).toEqual({ match: "itx.ai", target: "itx.builtins.ai", origin: "platform" });
const handle = await itx.provide("itx.ai", new FakeAi());
expect(await itx.rewriteRules.resolve("itx.ai.run")).toEqual(["itx.ai.run", "itx.builtins.rpcStubs.get('itx.ai').run"]);
handle[Symbol.dispose]();
await until(async () => (await itx.rewriteRules.get("itx.ai"))?.origin === "platform");
// e2e/ai-root-shadow-and-fable.e2e.test.ts
```

What names a dead stub is decided against one frozen table: every rule and every subscription whose
target RESOLVES to `itx.builtins.rpcStubs.get('<key>')` goes. So a user's alias to a shadowed root
(`itx.me ⇒ itx.whoami`, with a fake at `itx.whoami`) survives the fake dying in either configuration
order and resolves to the platform row beneath (`e2e/rewrite-rules.e2e.test.ts`).

### The compare-and-set undo: a handle only ever removes the row it wrote

An expression rule's handle appends the removal spelling when disposed — but only while the row is
still its own. The removal carries the target this handle wrote (`ifTarget`), and the core reduce
compares inside the commit:

```ts
// context/itx-expression-rewriting.ts — abridged
export function rewriteRuleRemovedEvent(match, ifTarget?) {
  const matchPrefix = parseItxExpressionPrefix(match);
  const event = rewriteRuleConfiguredEvent(matchPrefix, ["itx", "builtins", ...matchPrefix.slice(1)]);
  return ifTarget === undefined ? event : { ...event, payload: { ...event.payload, ifTarget } };
}
// stream/core-processor.ts — the reduce's one line for it
if ("ifTarget" in payload && (!existing || !jsonEqual(existing.target, payload.ifTarget)))
  return undefined; // a replacement owns the match now; a stale undo is a no-op
```

So a session that provided `itx.m ⇒ itx.kv` and let go after another session's live provider took
the match over un-sets nothing (`e2e/rpc-stubs-reconnect-and-attach.e2e.test.ts`). Two known reds sit
beside this, `test.fails` in the lane: two sessions providing the IDENTICAL expression rule share one
identity, so disposing the first removes the second's row; and a handle disposed while the stream is
paused loses its removal for good (the undo runs in `waitUntil` and discards the refusal).

**What this brick leaves on the table:** a rule names something you call. Nothing yet calls YOU
when something happens — and "when something happens" needs a log to happen in. The event this
chapter appended went somewhere; the next brick is that somewhere.

---

## 4. the stream: the log every context is

### `append`, `readEvents`, `waitForEvent`

Every context is one append-only event log. The three are built-ins under `itx.builtins`, like
everything the platform implements: `itx.append` is the implicit platform row
`itx.append ⇒ itx.builtins.append`, exactly as `itx.kv` is `itx.kv ⇒ itx.builtins.kv` (chapter 3) —
so the short name rides the dotted hop with zero edge code, and the physical spelling
`itx.builtins.append` always works and never reads the rules:

```ts
const [committed] = await itx.append({ type: "mark", payload: { n: 1 } });
expect(committed.offset).toBeGreaterThanOrEqual(1);
const page = await itx.invoke(["itx", ["readEvents"]]); // { events, scannedThroughOffset, atHead }
expect(page.events.some((e) => e.type === "mark")).toBe(true);
// e2e/context.e2e.test.ts
```

An event in is `{ type, payload?, metadata?, source?, idempotencyKey?, offset?, ephemeral? }`; an
event out adds `offset`, `createdAt`, `path`. The one runtime guard at the door is that `type` is a
non-blank string; types are namespaced by convention, `events.iterate.com/<domain>/<fact>`. A page
is cut by `limit` (default 500, at most 1000 rows) or by the server's byte budget (8 MiB), and its
length says nothing about which — `atHead` does. Read the whole log by chaining
`scannedThroughOffset`:

```ts
export const readAll = async (itx) => {
  const all = [];
  for (let after = 0; ; ) {
    const page = await itx.invoke(["itx", ["readEvents", after, 500]]);
    all.push(...page.events);
    if (page.atHead === true || page.scannedThroughOffset <= after) return all;
    after = page.scannedThroughOffset;
  }
};
// e2e/support/client.ts (readAll)
```

`waitForEvent({ type?, afterOffset?, timeoutMs? })` blocks on the DO for the next match —
`afterOffset` defaults to the head at call time, `timeoutMs` to 30 s (capped at 120 s), expiry coded
`WAIT_TIMEOUT`. Anchor at the current head and the wait resolves whether it registers first or the
append lands first:

```ts
const head = (await itxA.invoke("itx.readEvents(0)")).scannedThroughOffset;
const pending = itxA.waitForEvent({ type: "ping", afterOffset: head, timeoutMs: 20_000 });
await itxB.invoke(`itx.append({ type: 'ping', payload: { n: 1 } })`); // a second session
const got = await pending;
expect(got.payload).toEqual({ n: 1 });
expect(got.offset).toBeGreaterThan(head);
// e2e/stream.e2e.test.ts
```

The callback form exists today, and it is chapter 5's brick: `subscribe({ target: (events) => …,
consumes: [type] })` lends the function, and the context pushes it every matching commit:

```ts
const c = collector(); // records every (events, range) it is handed
await itxA.subscribe({ name: "pings", consumes: ["ping"], target: c.fn }); // a lent callback, pushed
await itxB.invoke(`itx.append({ type: 'ping', payload: { n: 2 } })`);
await until(() => c.types().includes("ping")); // (composed)
// e2e/push-delivery.e2e.test.ts
```

The difference in one line: `waitForEvent` is one-shot and blocks the caller; `subscribe` is
standing and pushed.

### Offsets, idempotency keys, expected offsets

Offsets come from ONE shared sequence, and a batch is atomic. An `idempotencyKey` dedupes at the
door: the same key with the same body answers with the event already in the log and burns no offset;
the same key with a different body refuses the whole batch:

```ts
const [orig] = await itx.append({ type: "note", payload: { v: 1 }, idempotencyKey: "kd" });
const batch = await itx.append(
  { type: "fresh", payload: { n: 1 } },
  { type: "note", payload: { v: 1 }, idempotencyKey: "kd" }, // a dedupe hit — consumes NO offset
  { type: "fresh", payload: { n: 2 } },
);
expect(batch[1].offset).toBe(orig.offset); // the hit answers with the ORIGINAL identity
expect(batch[2].offset).toBe(batch[0].offset + 1); // the hit did not burn an offset in between
// the same key with a DIFFERENT body: 'idempotency key "kc" already names a different event' — the whole batch rolled back
// e2e/stream.e2e.test.ts
```

An event may also carry an expected `offset`: land exactly there or refuse the batch with
`OFFSET_CONFLICT` — "nothing has happened since I last looked" (pinned in `src/stream/stream.test.ts`;
no e2e file spells it). Concurrent appends from two sessions keep offsets unique; one event's body
is capped at 8 MiB (`EVENT_TOO_LARGE`, nothing written, no offset burned); a 5 MiB body commits as
one dense event, chunked in storage and invisible to paging
(`e2e/stream-isolate-ceilings-deployed.e2e.test.ts`, `e2e/stream.e2e.test.ts`).

### Ephemerals share the sequence

An event with `ephemeral: true` takes an offset from the shared sequence but is never stored: it
rides to live subscribers, triggers zero writes, and its body is gone when the incarnation ends. An
ephemeral-only batch touches storage not at all.

```ts
const [mark] = await itx.invoke(`itx.append({ type: 'mark' })`);
let lastOffset = mark.offset;
for (let i = 0; i < 3; i++) {
  const [c] = await itx.invoke(`itx.append({ type: 'chunk', ephemeral: true })`);
  expect(c.ephemeral).toBe(true);
  expect(c.offset).toBeGreaterThan(lastOffset); // strictly increasing on the SHARED sequence
  lastOffset = c.offset;
}
// e2e/push-delivery.e2e.test.ts
```

The contract every offset-keyed consumer honours: an ephemeral's offset is unique WITHIN an
incarnation, and a later incarnation may hand the same number to a durable — so a short page's
`scannedThroughOffset` is the durable mark, never the in-memory head, and nothing a reader persists
can name an offset a later incarnation could reuse (`e2e/stream.e2e.test.ts`).

### The birth records, and the stream's own state

The DO's constructor appends the platform's own records before any door opens, so ANY door
materializes a context — a bare read included. The first incarnation writes `stream/created {
projectId, path }` at offset 1 and `stream/woken { incarnation }` at 2; the config-worker funnel
(chapter 7) subscribes `config` at 4; offsets 3 and 5 are ephemeral live-state deltas; the first user
append lands at 6:

```ts
const page = await itx.invoke("itx.readEvents(0)");
expect(page.events.map((e) => [e.type, e.offset])).toEqual([
  ["events.iterate.com/stream/created", 1],
  ["events.iterate.com/stream/woken", 2],
  ["events.iterate.com/stream/subscription-configured", 4],
]);
expect((await itx.invoke(`itx.append({ type: 'hello' })`))[0].offset).toBe(6);
// e2e/stream.e2e.test.ts
```

THE CORE REDUCE is the stream's own state, reduced inside every commit. One reduce-only processor
(`src/stream/core-processor.ts`, slug `core`, contract 8.0.0) folds the context's control events
into `{ projectId, path, createdAt, incarnation, paused, itxExpressionRewriteRules, subscriptions,
secrets }` — the rule table of chapter 3 is one slice, the subscription rows of chapter 5 another.
Runtime state IS reduced state, and its snapshot is a facet-shaped door:

```ts
const snap = await itx.invoke("itx.facets.get('core').snapshot()"); // { offset, state }
expect(snap.state).toMatchObject({ projectId: "acme-support", path: "/", incarnation });
expect(snap.state.itxExpressionRewriteRules["itx.solo"]).toEqual({ match: ["itx", "solo"], target: ["itx", "builtins", "rpcStubs", ["get", "itx.solo"]] });
// e2e/stream.e2e.test.ts · e2e/rpc-stubs-lend-recall-and-offline.e2e.test.ts
```

### Pause and resume are ordinary events

Control is ordinary events. `stream/paused { reason }` refuses every later append — durable,
ephemeral, and a batch that mixes the resume with anything else — with `STREAM_PAUSED`, and the bare
`stream/resumed` always passes:

```ts
await itx.append({ type: "events.iterate.com/stream/paused", payload: { reason: "maintenance" } });
const err = await rejection(itx.append({ type: "mark", payload: { n: 1 } }));
expect(err.code).toBe("STREAM_PAUSED"); // "stream paused: maintenance"
await itx.append({ type: "events.iterate.com/stream/resumed", payload: {} });
const [after] = await itx.append({ type: "mark", payload: { resumed: true } });
// e2e/stream.e2e.test.ts · e2e/context.e2e.test.ts
```

Who DECIDES to pause is not core's business: a breaker is a facet processor (chapter 6) that appends
`paused` with its reason, and core's pause check is one `if` reading the reduced slice.

### The commit pipeline

```ts
// stream/stream.ts — Stream.append, abridged: synchronous end to end (sync SQLite)
append(...events: StreamEventInput[]): StreamEvent[] {
  // 1. MAY THIS LAND? a non-blank type; a reserved subscription name refused; an ephemeral measured
  // 2. OFFSETS — decided in memory, nothing written yet: idempotency (dedupe, or refuse the batch), then per event
  const paused = this.#coreReducedState.paused;
  if (paused && !pauseExempt.includes(eventInput.type)) throw codedError("STREAM_PAUSED", `stream paused: ${paused.reason}`);
  if (expectedOffset !== undefined && expectedOffset !== offset) throw codedError("OFFSET_CONFLICT", /* … */);
  // 3 + 4. REDUCE + COMMIT — rows, the high-water mark and the core reduce's checkpoint, ONE transaction
  //        (an ephemeral-only batch skips this entirely: zero SQL)
  this.storage.transactionSync(() => {
    /* insert the durables — EVENT_TOO_LARGE rolls the batch back */
    reducedState = this.#reduceEventsIntoCoreReducedState(freshEvents, reducedState);
    this.storage.reduceCheckpoints.write(/* … */);
  });
  // 5. AFTER — waiters first (onCommit may append again), then the host's fan-out, then core's live delta
  this.#resolveWaitForEventWaiters(freshEvents);
  this.#onCommit(freshEvents, afterOffset, throughOffset);
}
```

Every refusal happens before a single write.

**What this brick leaves on the table:** the log fills and nothing reads it for you. A client that
wants to react has to poll `readEvents`.

---

## 5. subscriptions: a name for a delivery

### `subscribe({ target: fn })` pushes every commit to a live callback

A subscription is pure data — a name, a target expression whose terminal is callable with
`(events, range)`, an optional `consumes` filter, an optional `afterOffset` — written by ONE event,
`stream/subscription-configured`. `subscribe` is edge sugar over it. When the target is a live
callback, the callback is lent under the key `subscription:<name>` and the row targets
`itx.builtins.rpcStubs.get('subscription:<name>')`; the row rides the same pager upgrade a `provide`
uses.

```ts
const c = collector(); // records every (events, range) delivered
await itx.subscribe({ name: "chain", consumes: ["hit"], target: c.fn });
const [hit1] = await itx.append({ type: "hit" });
for (let i = 0; i < 5; i++) await itx.append({ type: "miss", payload: { i } }); // a quiet gap the filter skips
const [hit2] = await itx.append({ type: "hit" });
await until(() => c.invocations.length >= 2);
const [d1, d2] = c.invocations;
expect(d1.events.map((e) => e.offset)).toEqual([hit1.offset]);
expect(d2.events.map((e) => e.offset)).toEqual([hit2.offset]);
expect(d2.range.after).toBe(d1.range.through); // THE contract: ranges CHAIN across the gap
// e2e/push-delivery.e2e.test.ts
```

`range` is `{ after, through }`, the half-open window the delivery covers; a chain of them, each
`after` equal to the previous `through`, proves a subscriber missed nothing, and a real gap is healed
with `readEvents`. A throwing callback never hurts the producer and is never retried — a push to a
live client is fire-and-forget. `subscribe({ name, target: null })` removes the row; an unnamed
subscribe mints a unique `sub-<uuid>` name, a getter on the handle (`await s1.name`); disposing the
handle, or the session ending, removes the row and recalls the callback; re-subscribing the same name
REPLACES — one row, one more event (`e2e/rpc-stubs-reconnect-and-attach.e2e.test.ts`).

### The rows are a slice of core

`itx.subscriptions.list()` is the read door, the table joined with the stream-kept cursors. Every
context is born holding one row — the config-worker funnel of chapter 7 — so "nothing here" is `["config"]`:

```ts
expect((await itx.subscriptions.list()).map((r) => r.name)).toEqual(["config"]);
const subscription = await itx.subscribe({ target: () => undefined });
const name = await subscription.name;
expect((await itx.subscriptions.list()).map((r) => r.name)).toEqual(["config", name]);
expect(await itx.rpcStubs.list()).toContain(`subscription:${name}`); // presence: the lent callback
await itx.subscribe({ name, target: null }); // the row goes, the callback is recalled
// e2e/rpc-stubs-lend-recall-and-offline.e2e.test.ts
```

A subscription never touches the rewrite-rule table. Two layers, two tables.

### Push or cursor: decided by what the target evaluates to

Nothing is declared. After every commit, the ONE delivery loop evaluates each row's target and looks
at what came back:

| The value evaluates to | Owns its progress? | Delivery |
| --- | --- | --- |
| a `FacetHandle` (`itx.facets.get(name)…`, chapter 6) | yes — its own checkpoint | PUSH `(events, range)`, awaited, serialized per row |
| an `RpcStubHandle` (`itx.rpcStubs.get(…)`, a lent callback) | yes — the client owns its offset | PUSH, fire-and-forget; the client heals with `readEvents` |
| anything else (a loaded entrypoint, a sibling context, a remote) | no | THE STREAM KEEPS A CURSOR: at-least-once, the awaited call is the ack |

That table is three `instanceof` checks in `src/stream/subscription-delivery.ts` on the value the
target evaluated to; the brands are minted where the built-ins mint their handles, and a rule whose
target names another rule classifies correctly because it evaluates to the same handle. A stateless
worker's `processEventBatch` is the cursor case. Load one behind a rule (chapter 7 has
the load) and subscribe its method BY EXPRESSION:

```ts
await itx.provide("itx.digest", ["itx", "workers", ["get", { source: SOURCES.digest }]]);
const sub = await itx.subscribe({ name: "digest", target: "itx.digest.processEventBatch", consumes: ["mark"] });
await itx.subscribe({ name: "tab", target: () => undefined, consumes: ["mark"] }); // a live tab beside it
for (let i = 0; i < 3; i++) await itx.append({ type: "mark" });
await until(async () => (await digested(itx)) === 3); // the worker's own kv shows 3
const row = await itx.subscriptions.get("digest");
expect(row.cursor.attempt).toBe(0); // THE STREAM keeps this row's cursor…
expect(row.target).toBe("itx.digest.processEventBatch"); // …stored as written; classified by what it EVALUATES to
expect((await itx.subscriptions.get("tab")).cursor).toBeUndefined(); // a push target: no cursor
// e2e/cursor-delivery.e2e.test.ts
```

### The ladder, the halt, the resume

A plain throw from a cursor target climbs ONE retry ladder — `1s · 2ⁿ`, capped at 30 minutes, 15
attempts — on the DO's own alarm; the redelivery carries the same events (at-least-once), and a
success resets `attempt` to 0. A failure that can only repeat — `retryable: false` stamped on the
error, or one of the platform's own deterministic codes — HALTS the row at once with a
`subscription-delivery-halted` fact. Recovery is ONE operator event, a plain append:

```ts
const [poisoned] = await itx.append({ type: "mark", payload: { poison: true } }); // digest throws retryable:false
const [stuck] = await itx.append({ type: "mark" });
const halted = await until(async () => (await itx.subscriptions.get("digest"))?.halted);
expect(halted.attempts).toBe(1); // one attempt, not fifteen
expect(halted.afterOffset).toBeLessThan(poisoned.offset);
expect(await digested(itx)).toBe(3); // nothing more was delivered
// un-halt AND seek past the poison; the stuck mark lands on its own
await itx.append({ type: "events.iterate.com/stream/subscription-delivery-resumed", payload: { name: "digest", afterOffset: poisoned.offset } });
await until(async () => (await digested(itx)) === 5);
// e2e/cursor-delivery.e2e.test.ts
```

One halted row never blocks its neighbour; a resumed `afterOffset` beyond the head does not deaden
the row; a delivery targeting the stream's own `append` is refused (an array has no string `type`)
and backs off on the ladder, bounded and loud, never a deadlock. `subscribe` resolves without probing
the receiver: an unusable target fails at its first delivery, never at configure.

### `afterOffset`: a cursor lane may ask for history

A cursor-lane subscriber's cursor is born at `afterOffset` (0 = the whole log) instead of at the
configure offset, so events that landed BEFORE the subscription are delivered — at-least-once, from
the cursor the stream keeps. A push target ignores it.

```ts
for (let i = 0; i < 3; i++) await itx.append({ type: "mark" }); // three marks, no subscription yet
await itx.subscribe({ name: "digest", target: "itx.digest.processEventBatch", consumes: ["mark"] }); // from now: a fourth mark → digested 1
await itx.subscribe({ name: "digest", target: "itx.digest.processEventBatch", consumes: ["mark"], afterOffset: 0 });
await until(async () => (await digested(itx)) === 5); // the whole log: all four again, once each
// e2e/cursor-delivery.e2e.test.ts
```

### The one `consumes` rule

`consumes` absent means every durable event and never an ephemeral. `"*"` means every durable event
— and never an ephemeral. NAMING a type opts that type in, ephemerals included. One function
(`consumesEvent` in `src/stream/processor.ts`) serves the delivery loop, the processor engine and the
inline reduces; there is no second copy to drift.

```ts
await itx.subscribe({ name: "opted-in", consumes: ["chunk"], target: optedIn.fn }); // names the ephemeral type
await itx.subscribe({ name: "default", target: dflt.fn }); // no consumes — durable events only
const [chunk] = await itx.append({ type: "chunk", ephemeral: true, payload: { n: 1 } });
const [note] = await itx.append({ type: "note" });
await until(() => optedIn.offsets().includes(chunk.offset) && dflt.offsets().includes(note.offset));
expect(optedIn.types()).toEqual(["chunk"]);
expect(dflt.types()).not.toContain("chunk");
// e2e/push-delivery.e2e.test.ts
```

A cursor target that is caught up receives the ephemerals it named too — they ride the pushed
batch, never the log; a target that is behind, repairing from the log, misses them by design.

**What this brick leaves on the table:** a live callback dies with its session, and a stateless
worker keeps nothing between deliveries. A subscriber that wants to REMEMBER — a count, a presence
list, a reduced view — needs somewhere durable to keep it, and a way to be handed the log from where
it left off.

---

## 6. facets and processors: durable subscribers

### `facets.get(name, spec)` hosts a class; `facets.get(name)` addresses it

A facet is a `DurableObject` class hosted as the durable facet `name` of this context — the mirror
of Cloudflare's `ctx.facets.get(name, startupCallback)`, with its own storage. One door, two shapes:
with a spec it LOADS and hosts; without, it ADDRESSES a facet that is already running:

```ts
const SRC_COUNTER = JSON.stringify({
  "cap.js": `import { DurableObject } from "cloudflare:workers";
export class CounterDurableObject extends DurableObject {
  async bump() { const n = ((await this.ctx.storage.get('n')) ?? 0) + 1; await this.ctx.storage.put('n', n); return n; }
  async value() { return (await this.ctx.storage.get('n')) ?? 0; }
}`,
});
await itx.invoke(`itx.facets.get('c1', { source: ${SRC_COUNTER}, className: 'CounterDurableObject' }).bump()`);
expect(await itx.invoke(`itx.facets.get('c1', { source: ${SRC_COUNTER}, className: 'CounterDurableObject' }).bump()`)).toBe(2);
expect(await itx.invoke(`itx.facets.get('c1').value()`)).toBe(2); // ADDRESS BY NAME: the same running instance; 'c2' would be independent state
// e2e/workers-and-facets.e2e.test.ts
```

A facet's identity is `ctx.props` — `{ iterateContextName, name }` — minted by the parent, the only
party that knows it. Its `env.ITX` is the loopback a loaded worker gets (chapter 7); a facet may even
`storage.put` it and use the restored handle later (`e2e/workers-and-facets.e2e.test.ts`).
Mid-chain handles are genuine, branded `RpcTarget`s, so `itx.facets.get('counterA',
spec).demo.timer.callLater(ms, cb)` pipelines into one dispatch from a client and from a loaded
worker alike (`e2e/workers-and-facets.e2e.test.ts`).

### A processor is two classes

A processor is a facet that additionally gets pushed the log. The author writes a PURE
`StreamProcessor` — a contract plus `reduce` (a pure switch), `processEvent` (an effect switch),
`projectLiveState` — and a one-line `StreamProcessorDurableObject` host. Both come from the SDK
bundled into every loaded isolate as `./processor.js`:

```ts
// e2e/support/sources.ts — SOURCES.tally, the facet-spine demo processor
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "tally",
  version: "1.0.0",
  description: "Counts committed events by type — the facet-spine demo processor.",
  stateSchema: z.object({ counts: z.record(z.string(), z.number()).default({}) }),
  consumes: ["*"],
  emits: [],
});
class TallyProcessor extends StreamProcessor {
  contract = contract;
  reduce({ event, state }) {
    return { counts: { ...state.counts, [event.type]: (state.counts[event.type] ?? 0) + 1 } };
  }
}
export class TallyDurableObject extends StreamProcessorDurableObject {
  processor = new TallyProcessor();
}
```

`itx.processors.enable(name, { source, className, consumes? })` — a built-in root, the third layer
of the onion on `rpcStubs` and `subscriptions` — is literally the subscription event of
chapter 5 whose target is `itx.builtins.facets.get(name, spec).processEventBatch`. It is DURABLE
configuration — no handle; `itx.processors.disable(name)` is the explicit inverse, and
`itx.processors.list()` is the subscriptions that host a facet. `className` names the
HOST, never the pure processor:

```ts
await itx.provide("itx.before", "itx.kv"); // a rule BEFORE enabling — counted by cold catch-up
await itx.processors.enable("tally", { source: SOURCES.tally, className: "TallyDurableObject" });
const s1 = await itx.invoke("itx.facets.get('tally').snapshot()"); // { offset, state }
expect(s1.state.counts["events.iterate.com/itx/rewrite-rule-configured"]).toBe(1);
const row = (await itx.subscriptions.list()).find((r) => r.name === "tally");
expect(row.target).toBe("itx.builtins.facets.get('tally').processEventBatch"); // the platform's spelling, source elided
expect(row.hostedFacet).toEqual({ name: "tally", className: "TallyDurableObject" });
expect(row.cursor).toBeUndefined(); // a facet owns its checkpoint
// e2e/processor-facets.e2e.test.ts
```

### The doors a processor exposes

The host (`src/sdk/index.ts`) is one abstract field, `processor`, and four
doors over a `ProcessorEngine`: `processEventBatch(events, range)` (the push door),
`snapshot()` → `{ offset, state }` (caught up through the log first), `liveSnapshot()` → `{ rev,
state }` (the live-state seed), and `waitUntilProcessed({ offset, timeoutMs? })` (the barrier,
default 10 s). The engine appends and reads through `env.ITX.get().builtins.append(…)` /
`.readEvents(…)` — the platform never spells a short name — and disposes both after each call
(chapter 11). It keeps the reduced state CHECKPOINTED with the offset and contract version it was
reduced under; a push not contiguous with the checkpoint triggers GAP REPAIR from the log; bumping
`contract.version` re-reduces from offset 0 through `reduce` only — side effects never re-run, and
durable rows only, which is why durable truth must never come from an ephemeral. The barrier rejects
at its own deadline, and a facet address is an ordinary expression a rule can name:

```ts
await itx.invoke(`itx.facets.get('tally').waitUntilProcessed({ offset: 1, timeoutMs: 5000 })`);
await itx.provide("itx.counts", "itx.facets.get('tally')");
expect((await itx.invoke(["itx", "counts", ["snapshot"]])).state.counts.mark).toBe(1);
// e2e/processor-facets.e2e.test.ts
```

### `processors.disable` is one event, and the facet goes with it

`processors.disable(name)` appends `subscription-configured { name, target: null }`. When that commits
and the removed row HOSTED a facet, the DO deletes the facet, storage included, before the append
returns. The raw event agrees with the verb in both directions:

```ts
await itx.append({
  type: "events.iterate.com/stream/subscription-configured",
  payload: { name: "tally", target: ["itx", "facets", ["get", "tally", { source: SOURCES.tally, className: "TallyDurableObject" }], "processEventBatch"] },
}); // a hand-appended row IS the enablement
await itx.append({ type: "events.iterate.com/stream/subscription-configured", payload: { name: "tally", target: null } });
await expect(itx.invoke("itx.facets.get('tally').snapshot()")).rejects.toThrow(/no facet/); // NO_FACET
await itx.processors.enable("tally", { source: SOURCES.tally, className: "TallyDurableObject" }); // a clean rebuild from the log
// e2e/processor-facets.e2e.test.ts
```

Same name replaces — a re-enable while warm is one more configured event, the row a map entry, the
reduce neither reset nor doubled. A name is one segment (`[A-Za-z0-9_-]+`); `core` is refused at
both doors, being the always-on reduce and never a facet; a hosting spec's literal source is capped
at 1 MiB (`FACET_SOURCE_TOO_LARGE`, refused before anything is appended).

### Policy is a facet processor

A token-bucket breaker is an ordinary two-class source that speaks core's control events: its reduce
spends one token per durable non-control event, refilled from the EVENT's `createdAt` (pure,
replayable), and its `processEvent` trips exactly on the crossing by appending `stream/paused`:

```ts
await itx.processors.enable("breaker", { source: SOURCES.breaker, className: "BreakerDurableObject" });
const burst = await itx.append(...Array.from({ length: 8 }, (_, i) => ({ type: "burst", payload: { i } })));
expect(burst).toHaveLength(8); // the burst was admitted — policy reads the REDUCE, after the commit
const paused = await itx.waitForEvent({ type: "events.iterate.com/stream/paused", afterOffset: 0, timeoutMs: 20_000 });
expect(paused.payload).toEqual({ reason: "breaker: durable events exceeded the bucket" });
expect(paused.source.processor).toMatchObject({ slug: "breaker", version: "1.0.0" }); // provenance: the log says WHO paused it
expect((await rejection(itx.append({ type: "more" }))).code).toBe("STREAM_PAUSED"); // until the operator's `stream/resumed`
// e2e/processor-facets.e2e.test.ts
```

Core knows nothing about breakers.

### Live state

`LiveState` is one holder used two ways. A processor's engine owns one and `set`s the projection
after every batch, so reduced state is live by default (`projectLiveState` reduces runtime fields
in). A mini-app facet that is not a processor owns one directly — the sink is one line over the
scope, in a field initializer:

```ts
// e2e/support/sources.ts — SOURCES.chatroom
import { DurableObject } from "cloudflare:workers";
import { LiveState } from "./processor.js";
export class ChatroomDurableObject extends DurableObject {
  #chat = new LiveState({ append: (e) => this.env.ITX.get().append(e) }, "chat", { messages: [] });
  post(from, text) {
    this.#chat.set({ messages: [...this.#chat.get().messages, { from, text }] });
    return { ok: true };
  }
  state() { return this.#chat.snapshot(); } // the seed door: { rev, state }
}
```

Every `set` diffs, bumps the revision and appends an EPHEMERAL `events.iterate.com/live-state/changed
{ key, from, to, patch }`. Live state is not a subscription mode: a client subscribes to that one
event type, keeps its key, applies a payload whose `from` matches its held rev, and re-reads the door
on any mismatch. The shipped client does exactly that:

```ts
import { connectLiveState } from "project-worker/client"; // the package's `./client` export; the lane imports src/client/live-state.ts

await itx.provide("itx.chat", ["itx", "facets", ["get", "chatroom", { source: SOURCES.chatroom, className: "ChatroomDurableObject" }]]);
const { store } = await connectLiveState(itx, { key: "chat", name: "chatwatch", door: async () => await itx.invoke("itx.chat.state()") });
await itx.invoke(["itx", "chat", ["post", "jonas", "hi"]]);
await until(() => store.get()?.messages.length === 1);
// for a processor: door = () => itx.invoke("itx.facets.get('chunky').liveSnapshot()")
// e2e/live-state-chains-client-side.e2e.test.ts
```

Deltas are unconsumable — no processor can ever reduce the change type, so a notification about
state can never feed a reduce. The React binding, `useLiveState(itx, { key, door })` in
`src/client/demo.tsx`, is `connectLiveState` over `useSyncExternalStore` and is the whole browser
half; it is exercised by the `/demo` page and `specs/live-state-demo.spec.ts`, not by the e2e lane.

### The core reduce is the same shape, inline

`itx.facets.get('core')` is not a facet. It is the inline reduce of chapter 4 answering at a
facet-shaped address — `snapshot()`, `liveSnapshot()`, `waitUntilProcessed()` — publishing under the
one key `core`: a rewrite rule and a subscription row both reach a live-state subscriber as `core`
deltas whose patches touch `/itxExpressionRewriteRules` and `/subscriptions/<name>`
(`e2e/stream.e2e.test.ts`).

**What this brick leaves on the table:** every class so far was handed over inline, as a string
in the call. Where does code LIVE, how is one build loaded once, and how does a project get its one
handler without wiring every context by hand?

---

## 7. loaded workers: code in the context of the context

### `itx.workers.get({ source })` — the stateless host

The other host kind. `itx.workers.get({ source, cacheKey?, className?, props? })` loads a
`WorkerEntrypoint` into a confined isolate of its own — no DO, no storage — and any method it exports
is reached by name. A stateless worker has no identity beyond its spec, so it has no name; naming
one is a rewrite rule's job.

```ts
const SRC_MINE = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Mine extends WorkerEntrypoint {
  async run() {
    const itx = await this.env.ITX.get();
    return \`from-inline:\${(await itx.whoami()).projectId}\`;
  }
}`,
};
expect(await itx.invoke(["itx", "workers", ["get", { source: SRC_MINE }], ["run"]])).toBe("from-inline:acme-support");
// e2e/session.e2e.test.ts
```

A source is the worker's MODULES, literally — `{ "cap.js": code, … }`, `cap.js` the main module —
and it exports its own host: a `WorkerEntrypoint` for `workers.get`, a `DurableObject` class for
`facets.get`. There is no host-injected wrapper and no bare-lambda door. `props` is Cloudflare's own
`WorkerStubEntrypointOptions.props`, read back as `this.ctx.props`. Dialing a REMOTE capnweb API is
userspace, exactly this shape: a `Remote extends WorkerEntrypoint` whose method opens
`newHttpBatchRpcSession(this.ctx.props.url)` (the SDK exports capnweb's client constructors) and
chains `.authenticate(this.ctx.props.credentials).projects.get(this.ctx.props.projectId).whoami()`
in one POST, mounted with `provide("itx.remoteApi", ["itx", "workers", ["get", { source, className:
"Remote", props: { url, projectId, credentials } }]])` and called as `itx.remoteApi.whoami()`
(`e2e/workers-and-facets.e2e.test.ts`).

### `env.ITX` inside loaded code

Every loaded worker's `env.ITX` and its `globalOutbound` are one stub of `ItxEntrypoint`, minted with
the one prop `iterateContextName`. Two doors and nothing else:

```ts
// iterate-context.ts — a loaded worker's WHOLE WORLD, abridged
export class ItxEntrypoint extends WorkerEntrypoint<Env, { iterateContextName: string }> {
  /** THE handoff: the genuine itx scope — the SAME `IterateContext` RpcTarget a capnweb client gets. */
  get(): IterateContext { return new IterateContext(this.env.ITERATE_CONTEXT, DurableObjectNameCodec.parse(this.ctx.props.iterateContextName), new SessionTeardown(), (p) => this.ctx.waitUntil(p)); }
  /** globalOutbound: every RAW Request a loaded worker sends lands on the context DO's fetch door. */
  override fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.delete(ITX_PRINCIPAL_HEADER); // loaded code speaks for the project, never for a person
    return this.env.ITERATE_CONTEXT.getByName(this.ctx.props.iterateContextName).fetch(new Request(request, { headers }));
  }
}
```

`await this.env.ITX.get()` is the real `IterateContext`; loaded code writes the same dotted lines a
client does, and `waitForEvent`, `append`, `demo.timer.callLater(cb)` all work from inside
(`e2e/stream.e2e.test.ts`, `e2e/rpc-stubs-values.e2e.test.ts`). The
context it forwards to is a PROP of the stub, not a binding the loaded code could reach around.

### The loader's cacheKey contract

`src/context/worker-loader.ts` wraps Cloudflare's `env.LOADER.get(id, getCode)`: `getCode` runs only
when no isolate is warm under `id`, and "if anything about the content changes, you must use a new
ID". So a source is EITHER its modules (the key is their content hash) OR an itx EXPRESSION that
PRODUCES them — and then `cacheKey` is REQUIRED, the producer runs inside `getCode` on a cold isolate
only, and the caller owns "same key ⇒ same code". Every key folds in the deploy id.

```ts
await itx.provide("itx.codeStore", codeStore); // a live code store the test holds — every evaluation is countable
await expect(itx.invoke(["itx", "workers", ["get", { source: "itx.codeStore.get('greet')" }], ["run", 1]])).rejects.toThrow(/needs a cacheKey/);
const spec = { source: "itx.codeStore.get('greet')", cacheKey: "greet@v1" };
expect(await itx.invoke(["itx", "workers", ["get", spec], ["run", 1]])).toBe("greet:1");
expect(await itx.invoke(["itx", "workers", ["get", spec], ["run", 2]])).toBe("greet:2");
expect(codeStore.produced).toEqual(["greet"]); // produced ONCE; the second call rode the warm isolate
await itx.invoke(["itx", "workers", ["get", { source: "itx.codeStore.get('greet')", cacheKey: "greet@v2" }], ["run", 3]]);
expect(codeStore.produced).toEqual(["greet", "greet"]); // a new key is a new isolate
// e2e/workers-and-facets.e2e.test.ts
```

The same for a facet: hosted from a producer, its state persists, the producer ran once, and the
memo keeps the key so a bare `facets.get(name)` re-materializes it. A producer that THREW does not
poison its key: the next attempt re-runs the producer and loads under the id's next generation.

### The config worker convention

A project has ONE event handler, and every context subscribes it at birth. Three things:

1. **`itx.worker` is a platform row** — `itx.worker ⇒ itx.workers.get({ source: <the bundled
   no-op ConfigWorker>, cacheKey: 'config:default' })`, shown by `itx.rewriteRules.list()`. A project
   OVERRIDES it with its own rule; a `null` at it MASKS (default-deny), never the no-op.
2. **Every context subscribes `config` in its constructor**, cross-context, at-least-once:

```ts
// iterate-context-durable-object.ts — the constructor, abridged
this.#stream.appendCreatedAndWokenEvents();
this.#stream.append({
  ...subscriptionConfiguredEvent({ name: "config", target: "itx.cd('/').worker.processEventBatch", consumes: ["*"] }),
  idempotencyKey: "config-subscription", // one row per context whatever the incarnation
});
```

3. **The author extends `ConfigWorker`** from the SDK and overrides `processEvent`; the platform calls
   `processEventBatch`. Stateless by design — the SUBSCRIBING context keeps the cursor — so
   `processEvent` must be idempotent. The same class answers the project's hosts through `fetch`
   (chapter 8):

```ts
// sdk/index.ts — abridged
export abstract class ConfigWorker<Env> extends WorkerEntrypoint<Env> {
  async processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void> {
    const itx = this.env.ITX.get();
    try { for (const event of events) await this.processEvent({ event, range, itx }); }
    finally { (itx as unknown as Disposable)[Symbol.dispose]?.(); }
  }
  processEvent(_args: ConfigEventArgs): void | Promise<void> {}
}
```

The whole convention on one context, source in KV as the repo stand-in:

```ts
const CONFIG_WORKER_SRC = `import { ConfigWorker } from "./processor.js";
export default class Config extends ConfigWorker {
  async processEvent({ event, itx }) {
    if (event.type === "events.iterate.com/config-ping")
      await itx.builtins.append({
        type: "events.iterate.com/config-pong",
        payload: { pinged: event.offset },
        idempotencyKey: "config-pong@" + event.offset, // an at-least-once redelivery is a no-op
      });
  }
}`;
await itx.kv.put("/repos/config/worker.ts", CONFIG_WORKER_SRC);
await itx.provide("itx.worker", ["itx", "workers", ["get", { source: `itx.kv.get('/repos/config/worker.ts')`, cacheKey: "config:v1" }]]);
await itx.subscribe({ name: "config", target: "itx.worker.processEventBatch", consumes: ["events.iterate.com/config-ping"] });
const [ping] = await itx.append({ type: "events.iterate.com/config-ping" });
await until(async () => (await readAll(itx)).some((e) => e.type === "events.iterate.com/config-pong" && e.payload?.pinged === ping.offset));
// e2e/config-worker.e2e.test.ts
```

And the FUNNEL: set the override at the root, and a fresh child context's ping reaches the root's
config worker with no manual subscribe — the child's birth row did it:

```ts
const root = openItx(project); // the KV source and the `itx.worker` override as above, at the root
const child = root.cd("/child"); // auto-subscribes itx.cd('/').worker.processEventBatch at birth
const [ping] = await child.append({ type: "events.iterate.com/funnel-ping" });
await until(async () => (await readAll(root)).some((e) => e.type === "events.iterate.com/funnel-pong" && e.payload?.at === ping.offset));
// e2e/config-worker.e2e.test.ts
```

### `itx.repos` and `itx.cfArtifacts`: where code lives

`itx.cfArtifacts` is Cloudflare Artifacts, project-scoped: every repo name is forced under
`${projectId}.`, `list` is filtered locally, and `get(name)` returns a handle whose `createToken`
pipelines across `/api` (its `fork`, whose name escapes the wall, is withheld). `itx.repos` is the
primary door built on top: a repo's file bytes, git-over-HTTPS, one root-level path on `main`. Both
are deployed-only in the lane — Artifacts has no local implementation.

```ts
expect(await itx.repos.readFile(repo, "worker.ts")).toBeNull(); // an unborn repo reads as null
const first = await itx.repos.writeFile(repo, "worker.ts", source); // creates the repo, commits on main
expect(first.commitOid).toMatch(/^[0-9a-f]{40}$/);
expect(await itx.repos.readFile(repo, "worker.ts")).toBe(source);
await itx.cfArtifacts.delete(repo); // repos and cfArtifacts address the same repo
// e2e/cfartifacts.e2e.test.ts (deployed only)
const tok = await a.cfArtifacts.get(repo).createToken("read", 300); // pipelined server-side
// e2e/cfartifacts.e2e.test.ts (deployed only)
```

The payoff is the config worker with its source moved out of KV and into a real repo, nothing else
changed — the `itx.worker` rewrite is the seam:

```ts
await itx.repos.writeFile("config", "worker.ts", CONFIG_WORKER_SRC);
await itx.provide("itx.worker", ["itx", "workers", ["get", { source: `itx.repos.readFile('config','worker.ts')`, cacheKey: "config:repo:v1" }]]);
// e2e/config-worker.e2e.test.ts (deployed only)
```

**What this brick leaves on the table:** everything so far spoke capnweb or Workers RPC. The web
speaks HTTP: a browser tab, a webhook, `curl`, a third-party API that wants a bearer token you must
not read.

---

## 8. fetch: in the context of this project, and into it

### `itx.fetch(request)`: fetch in the context of this project, secrets substituted

`itx.fetch(request)` is fetch in the context of this project — a `Request` sent AS the project:
to the internet today, to internal hostnames later. Not "egress"; the word is fetch, and the
context is what it adds. What it adds today is the secret substitution: a
`getSecret("/secrets/NAME")` placeholder in the request URL or a header is replaced at the door
with a value the caller never sees, and `getSecret("/secrets/NAME", { field: "a.b" })` picks one
field out of a JSON secret — apps/os's grammar for a URL or a header (the path and the query alike,
`:` kept in a spliced value; NOT its `Basic base64(user:getSecret(…))` peeling nor its JSON-body
template — the body is never scanned); `/secrets/NAME` is the name
`itx.secrets.set(NAME, …)` stored. `itx.secrets` is the WRITE-ONLY door to those values — `set`,
`delete`, and a `list` of names and origins, never a value. Every change appends
`events.iterate.com/secrets/changed` without the value:

```ts
expect(await itx.secrets.list()).toEqual([]);
await itx.secrets.set("api.key_v-2", "hunter2");
await itx.secrets.set("stripe", "sk_live", { origin: "https://api.stripe.com/v1/x" });
expect(await itx.secrets.list()).toEqual([
  { name: "api.key_v-2" },
  { name: "stripe", origin: "https://api.stripe.com" }, // the ORIGIN of the URL given, path dropped
]);
const changes = (await readAll(itx)).filter((e) => e.type === "events.iterate.com/secrets/changed").map((e) => e.payload);
expect(JSON.stringify(changes)).not.toContain("hunter2");
// e2e/secrets.e2e.test.ts
```

A secret set with an `origin` is sent to that origin ONLY. A placeholder with no stored secret, or a
secret bound to another origin, is a 502 to the CALLER, before the terminal fetch, naming the
placeholder and where it sat, never the value:

```ts
await itx.secrets.set("bound", "v", { origin: "https://api.example.com" });
const res = await itx.fetch(new Request("https://egress.invalid/", { headers: { authorization: 'getSecret("/secrets/bound")' } }));
expect(res.status).toBe(502);
expect(await res.text()).toContain("bound to https://api.example.com"); // and "not sent to https://egress.invalid"
const missing = await openItx("acme-support").fetch(new Request("https://egress.invalid/hunt", { headers: { "x-hunt-auth": 'Bearer getSecret("/secrets/GHOST")' } }));
expect(missing.status).toBe(502);
expect(await missing.text()).toContain('header "x-hunt-auth"'); // WHERE it sat, so the caller can fix it
// e2e/secrets.e2e.test.ts · e2e/fetch-door.e2e.test.ts
```

The door (`src/iterate-context-durable-object.ts`) scans the URL first, then every header — the
placeholder as written, or as the URL parser percent-encodes it in a path or a query — splices a URL
value as ONE component so a secret can never add a query parameter, and preserves method, `Upgrade`
and body, so a 101 flows through it. A `{ field }` placeholder whose value is not JSON, or has no
string at that path, is the same 502; the project's own API key (chapter 10) lives outside the
catalog, so `getSecret("/secrets/project-api-key")` finds nothing. The catalog is the PROJECT's: a
secret set from `/a` is listed from `/b` and the root, and the change events live in the root's log.
Deployed, the value arrives at the bound origin — proven by fetching one of the project's own apps
on its real host.

### Fetch into the project: a project host is the address

The other direction. A fetch-shaped capability is always called through a terminal
`.fetch(request)`, and from the web there is ONE way to it: a project host. `<app>--<project>.<base>`
and `<app>.<project>.<base>` name the app `<app>` of `<project>` — an id or a slug (the dotted shape
is parsed and served locally; deployed, the one-label wildcard certificate does not cover a second
label, a deploy-side fact); the apex `<project>.<base>` names no app. The edge resolves the project
through the in-process directory (the row is the id, whichever the label was), strips every inbound
`x-itx-*` header, sets the principal's stamp (chapter 10), and rides the Request VERBATIM into the
project's root context with the expression the host names in `x-itx-expression` (the internal
channel a session's terminal fetch and a loaded worker's `env.ITX.fetch` ride too), so the URL,
host-scoped cookies and WebSocket upgrades survive. There, at the DO's fetch lane, the trusted
`x-iterate-app` is ALWAYS overwritten from the expression — the label of `itx.apps.<label>`, deleted
for any other — so neither a visitor nor loaded code can pick an app the expression did not.

An app host lands on `itx.apps.<app>.fetch(request)`: an app is one rule row and the log never names
a hostname. A host naming no app lands on the project's config worker (chapter 7),
`itx.worker.fetch(request)`: the bundled default answers 404, and a project that wants its own
routing overrides `fetch` — the apex today, a custom hostname once the directory knows one:

```ts
// the config repo's worker.ts — routing by hostname, in the author's own `fetch`
export default class Config extends ConfigWorker {
  async fetch(request: Request) {
    const itx = this.env.ITX.get();
    const host = new URL(request.url).hostname;
    if (host === "acme-support.iterate.app") return itx.apps.site.fetch(request); // the apex: the site
    return new Response("no app here\n", { status: 404 });
  }
}
```

The lane, on the three shapes:

```ts
const projectId = freshDnsSafeProjectId("ingress"); // a project's id IS its DNS-safe slug
await session().authenticate(adminCredentials()).projects.create({ project: projectId }); // the directory must know it
const itx = openItx(projectId);
await itx.provide("itx.apps.site", ["itx", "workers", ["get", { source: SRC_SITE }]]);
const page = await fetchProjectHost(`site--${projectId}.${base}`, "/w?repo=x");
expect(page.status).toBe(200);
expect(page.text).toContain(`<p>site--${projectId}.${base}/w?repo=x</p>`); // the URL verbatim
expect((await fetchProjectHost(`site.${projectId}.${base}`, "/w")).status).toBe(200); // the second shape, the same row — locally: deployed, the wildcard certificate covers one label
const seen = JSON.parse((await fetchProjectHost(host, "/echo", { "x-iterate-app": "other" })).text);
expect(seen.app).toBe("site"); // what the app saw in x-iterate-app, whatever the visitor sent
expect((await fetchProjectHost(`${projectId}.${base}`, "/")).status).toBe(404); // the apex: the bundled config worker's fetch
await itx.provide("itx.worker", ["itx", "workers", ["get", { source: SRC_CONFIG_ROUTER, cacheKey: "config:ingress" }]]);
expect((await fetchProjectHost(`${projectId}.${base}`, "/echo")).status).toBe(200); // the project's own fetch routes it to the site
expect((await fetchProjectHost(`other--${projectId}.${base}`, "/")).status).toBe(404); // a label with no row: 404
expect((await fetchProjectHost(`site--${unknown}.${base}`, "/")).status).toBe(421); // a project the directory does not know
// e2e/ingress-project-host.e2e.test.ts
```

> **Landing:** a custom hostname (`acme.com`, `<app>.acme.com`) is a later build: a directory row
> and a lookup by hostname, then the same `x-iterate-app` and the same config-worker `fetch`.

Admission comes first: a context is created on first touch, so before the edge dials a Durable
Object for a project host it asks the in-process directory whether the project exists — one D1 read
— and a stranger's label under the wildcard mints nothing; a hostname under the base that fails the
grammar at all is 421 too, never the control plane. A visitor's credential is read as chapter
10 says — this project's token, its secret or the admin secret as the bearer, or the host cookie a
token was turned into; never the platform's login cookie — and the platform's own credential is
stripped before the app sees the Request. The hop budget counts what an app FORWARDS: an app that
fetches its own host with the headers it was handed comes back through the edge with that count,
and the fourth forwarded pass is a 508; a fresh Request starts at zero — an app looping its own
project with fresh Requests is its own cost (`e2e/ingress-project-host.e2e.test.ts`, the red row).
Deployed, a WebSocket upgrade rides through the host to the app.

Inside a session the door is the dotted terminal `.fetch(request)`: `invoke` forks a call whose
terminal step is `fetch` carrying a live Request onto the DO's fetch channel, the only hop kind that
carries a socket-bearing Response back — `await itx.site.fetch(new Request("https://itx.site/"))`
answers the loaded worker's 200 over capnweb (`e2e/session.e2e.test.ts`). The channel reaches a LENT
stub just as well — a Node process providing a fetch-shaped `RpcTarget` serves HTTP out of your
laptop, and upgrades WebSockets with capnweb's universal `WebSocketPair` — so a row at
`itx.apps.device` puts the laptop behind a project host:

```ts
class HttpDevice extends RpcTarget {
  async fetch(request: Request) { return new Response("pong-from-node-provider", { status: 201 }); }
}
await session().authenticate(adminCredentials()).projects.get("acme-support").provide("itx.device", new HttpDevice());
expect((await itx.device.fetch(new Request("https://itx.device/", { method: "POST", body: "ping" }))).status).toBe(201); // (composed)
// e2e/fetch-door.e2e.test.ts (the provider, reached through its project host) · e2e/session.e2e.test.ts (the dotted terminal)
```

From loaded code, `env.ITX.fetch` is a real Fetcher — set `x-itx-expression` yourself and the same
channel serves it (`e2e/fetch-door.e2e.test.ts`, the plain case).

### The fetch-upgrade leg, in one paragraph

Two platform facts force everything unusual in `src/context/rpc-stubs.ts`: workerd's Workers RPC
cannot serialize a socket-bearing Response, and capnweb could not carry sockets across a session (the
platform forked it). For a LENT stub whose `fetch` answers a 101, the DO calls the borrowed stub's
fetch in the lender's own context; a socket-bearing Response is accepted there, ONE "upgrade leg"
WebSocket is opened back into the DO tagged by an unguessable id, and the DO mints the eyeball's pair
natively and forwards frames by tag — both sockets hibernatable. The fenced section is a WORKAROUND
to be deleted the day workerd and capnweb serialize WebSockets over plain RPC. Two known reds sit
here, `test.fails` in the lane: a dynamic worker providing a fetch-shaped stub over `env.ITX.get()`
cannot answer a 101 (`DataCloneError` on its Workers-RPC return leg), and such a stub dies with its
providing invocation, the rule outliving it as `RPC_STUB_OFFLINE`
(`e2e/fetch-door.e2e.test.ts`).

**What this brick leaves on the table:** fetch gives you raw HTTP. Talking to an MCP server, an
OpenAPI service or a remote capnweb API by hand — sessions, tool lists, operation ids — is work that
is the same for every project.

---

## 9. the library: first-party code that takes only `itx`

### `connectToMcp`, `connectToOpenApi`, `connectToCapnweb`

The built-ins record has two groups. The ROOTS are implemented against `ctx` and `env`. THE LIBRARY
(`src/library.ts`) is first-party code whose ONLY dependency is `itx` — the same dotted handle a loaded
worker holds. That signature is the litmus test ("could this be written in a userspace worker?") and
the whole layering: a library module could move to userspace unchanged, and the surface shows no
level. Every connector does ALL its HTTP through `itx.fetch`, so secrets substitute for free and a
user rule shadowing `itx.fetch` redirects the library too.

```ts
const headers = await bearerFor("mcp@example.com"); // the pet shop's ordinary bearer, as the connector's `headers` option
const conn = await itx.connectToMcp(`${PETSHOP}/mcp`, { headers });
expect((await conn.serverInfo()).serverInfo).toMatchObject({ name: "dummy-petshop" });
expect((await conn.list_pets({})).pets.map((p) => p.name)).toContain("Biscuit"); // one method per tool
await expect(conn.callTool("get_pet", { id: "pet-nope" })).rejects.toThrow(/No pet with id pet-nope/); // an isError tool call throws
await conn.close();

const pets = await itx.connectToOpenApi(`${PETSHOP}/openapi.json`, { headers });
expect((await pets.operations()).map((o) => o.operationId).sort()).toEqual(["createPet", "getPet", "listPets"]);
expect(await pets.getPet({ id: "pet-1" })).toMatchObject({ id: "pet-1", name: "Biscuit" }); // one input object: path, query, header, body

const batchHeaders = await bearerFor("capnweb-batch@example.com");
const shop = await itx.connectToCapnweb(`${PETSHOP}/capnweb`, { transport: "batch", headers: batchHeaders }); // one POST per chain
expect((await shop.listPets()).owner).toBe("capnweb-batch@example.com");
// e2e/library-connectors.e2e.test.ts (against the deployed pet shop)
```

Composition with rules is the documented shape: `provide('itx.tools', "itx.connectToMcp(url, {
headers })")`, then `itx.tools.get_pet(…)` resolves to `itx.builtins.connectToMcp(…).get_pet`. A
remote's 401 reaches the caller as the connector's refusal. `connectToCapnweb` over a WebSocket
session through `itx.fetch` pipelines a chain and is held across calls (deployed only: local workerd's
outbound fetch cannot upgrade). A loaded worker can also SERVE a capnweb API — the SDK exports
`newWorkersRpcResponse` — and `connectToCapnweb` dials it back through a project host,
`<app>--<project>.<base>/<path>`, the path arriving verbatim (`e2e/library-connectors.e2e.test.ts`,
deployed only — the DO's egress cannot resolve a local host; the local twin dials the host's 101 with
`newWebSocketRpcSession`, `__workers-tests__/ws-fetch-live-101.test.ts`).

### `itx.run`: a script as a loaded worker's one call

The fourth library verb is the smallest: `itx.run(script, { args? })` takes the TEXT of a function
whose first parameter is `itx` — `async (itx, ...args) => { … }` — and runs it once inside a confined
isolate. It is sugar over `itx.workers.get`: the text is spliced verbatim into the smallest
WorkerEntrypoint (`src/library.ts` `runScriptModule` — a default class whose `run(...args)` mints
`env.ITX.get()`, calls the script with it and the args, and disposes the scope after), then
`workers.get({ source }).run(...args)` is called through the handle the library holds, so a rule on
`itx.workers` applies to it like any other call. The same text is the same module, and the loader's
content hash reuses the warm isolate across calls. The script's `itx` is THIS context — but with no
principal: loaded code speaks for the project, never for a person, so an append inside carries no
`source.principal`. A text that is not one function expression fails at load, in the loader's words,
and does not poison the isolate id.

```ts
expect(await itx.run("async (itx) => itx.whoami()")).toEqual(await itx.whoami());
expect(await itx.run("async (itx, a, b) => a + b", { args: [2, 3] })).toBe(5);
await itx.run("async (itx) => { await itx.append({ type: 'run/hello', payload: { n: 1 } }); }");
// e2e/workers-and-facets.e2e.test.ts
```

### Open question: one root, or `kernel` and `lib`?

Today one flat root holds both groups: the kernel roots, implemented against `ctx` and `env`, and
the library, written against `itx` alone — `itx.builtins.kv` and `itx.builtins.connectToMcp` sit
side by side, and nothing in the spelling says which is which. The alternative is two namespaces,
`itx.builtins.kernel.*` and `itx.builtins.lib.*` (or two platform rows, `itx.kernel` and `itx.lib`).
The trade: one root is one spelling and no level to learn; two make the litmus test visible in the
name, and let the library move to userspace without a rename. Not decided.

### Memoized per context, released at the quiesce

A connector reached THROUGH a rule is a connect per call as an expression — a fresh MCP session, an
open WebSocket that no intermediate holder disposes. So the library keeps every connection it opened,
by `(verb, url, options)`, hands the same one back while it lives, and releases them all at the
context's idle quiesce — a held connection pins the context awake exactly like a borrowed stub
(`buildLibrary` in `src/library.ts`: a `Map` from the key-sorted JSON of `(verb, url, options)`
to the connection promise, a failed connect not kept, and `releaseConnections()` calling `close()`
where there is one, else the disposer). A connection closed by a holder or broken by the far side
reopens itself on its next use, so a memoized one is never dead.

**What this brick leaves on the table:** every call so far ran as the lane's admin. An event
appended from a browser tab, a `provide` from a laptop, an MCP client's tool call — who did that?

---

## 10. identity: who is calling

### One door, four credential kinds

`authenticate(credentials)` takes a `SessionCredentials` — where the identity already is, or the
secret that proves it — and every lane reads the same kinds off a request:

- `from-server-cookie`: the control plane owns a signed session cookie (`__Host-itx-control-plane-session`);
  `/login` is a form that verifies nothing (enter an email and you become that user — attribution,
  not authentication). A browser cannot set a header on a WebSocket, so the cookie rides the
  handshake and the call NAMES it — never implicit. It counts on a same-origin request only
  (`isSameOriginBrowserRequest`, `src/worker.ts`: the `Origin` header is this origin, or absent);
  a foreign site's socket carries the cookie too and is refused `UNAUTHENTICATED` — the one guard
  that makes an ambient cookie safe over RPC. `projects.get` admits members of the owning org only.
- `project-token`: one user on one project, below.
- `admin-secret`: the deployment's `APP_CONFIG_ADMIN_API_SECRET` (a wrangler secret) — `{ actor:
  "admin" }`, every project, `list()` is the whole directory, `create()` lands in `org_admin`. With
  `as: { sub, email }` it is that user's session without a login (the row upserted like `/login`
  does), which is how a confinement test signs in. The e2e lane runs on it.
- `project-secret`: the project itself (a device, a headless app) — its own long-lived key, minted
  by `projects.get(project).rotateApiKey()`, below. The session is `{ actor: "project:<id>" }`,
  bound to that one project exactly like a token's.

The fetch lane — a project host — is bearer and token only: this project's token, its secret or the
admin secret as `Authorization: Bearer`, or the host cookie a token was turned into (below). The
platform's login cookie is never a lane credential (`projectHostIdentityOf`, `src/worker.ts`): on a lane a
cross-site navigation would carry it with no `Origin` to check. `/mcp` is behind the OAuth AS and
takes the same bearers.

### The control plane, and MCP through the one login

Everything on the worker's hostname that is not `/api`, `/version` or a static asset is the
control plane, in-process: the console — a TanStack Start app the worker SSRs (`src/routes/**`),
four screens: `/login` (the email form; "continue as / switch account" when a session exists), the
`_auth` layout (no session ⇒ `/login?next=`), the account page at `/` (your orgs; your projects, each
with an `open` link onto its hosts; create a project; log out) and the `/authorize` consent (below) —
each screen acting through its own server functions, with `POST /login`, `/logout`, `/projects` and
`/authorize` beside them as plain form doors — for a script, and for the screens' own forms until the
page hydrates; the OAuth 2.1
Authorization Server (`/authorize`, `/oauth/token`, `/oauth/register`, `/.well-known/*`) whose ONLY
protected route — and ONE resource, `<origin>/mcp` — is `/mcp`. The directory is D1 — users → orgs →
projects, access is org membership — and a project's id IS its DNS-safe slug: the directory row, the
DO name and the host label are one name.

`/mcp` is the ONE MCP server for every project, and it authenticates through that one login. An MCP
client discovers the AS from `/.well-known/oauth-protected-resource/mcp`, registers (CIMD by URL, or
DCR), and sends the user to `/authorize`; the consent page is the project selection — her projects
as checkboxes, all checked — and approving mints a grant whose props name her and the checked
projects. The token then reaches ONE tool: `run({ project?, script, args? })` — the text of
`async (itx, ...args) => …` run (`itx.run`) in THAT project's root context, in-process, under her
principal (`invokeAs`), so what it appends carries her; `project` is
optional when the grant reaches exactly one, required for the admin secret (which reaches every
project as a bearer, `resolveExternalToken`), refused outside the grant. A project's own secret is a
bearer too — it names its project with `?project=<id>` on the `/mcp` URL — and acts as `project:<id>`. MCP is not a parallel capability
API: a tool call reaches what an expression reaches, for any project the grant names:

```ts
const { accessToken } = await grantFlow(env, adaCookie, { resource: `${ORIGIN}/mcp`, choose: (ids) => ids.filter((id) => id !== "oa-three") });
expect(tools.map((t) => t.name)).toEqual(["run"]);
expect((await run({ project: "oa-one", script: "async (itx) => itx.whoami()" })).result).toEqual({ projectId: "oa-one", path: "/" });
expect(appended.result[0].source.principal).toEqual({ actor: "user_oauth-ada@example.com", email: "oauth-ada@example.com" });
expect((await invoke({ project: "oa-three", expression: "itx.whoami()" })).text).toContain("outside this token's grant");
expect((await invoke({ expression: "itx.whoami()" })).text).toMatch(/pass project — this token reaches oa-one, oa-two/);
// __workers-tests__/control-plane.test.ts
```

### Project tokens, the admin secret, and `Session.whoami`

A PROJECT TOKEN is a signed claim `{ projectId, actor, email?, expiresAt }` — HMAC-SHA256 under
`APP_CONFIG_PROJECT_TOKEN_SECRET`, minted by whoever fronts the users after their membership check.
`authenticate({ type: "project-token", token })` answers a session that knows who it is and is bound
to the token's one project; the admin secret answers `{ actor: "admin" }`, and `as` a user:

```ts
const principal = { actor: "user_ada", email: "ada@example.com" };
const token = await mintProjectToken({ projectId, ...principal }); // e2e/support/principal.ts signs with the lane's secret
using api = session();
const authenticated = api.authenticate({ type: "project-token", token });
expect(await authenticated.whoami()).toEqual({ projectId, ...principal });
expect((await rejection(authenticated.projects.get(`${projectId}-other`).whoami())).code).toBe("FORBIDDEN"); // the token names ONE project
expect((await rejection(api.authenticate({ type: "project-token", token: `${token}x` }).whoami())).code).toBe("INVALID_CREDENTIALS");
const admin = api.authenticate(adminCredentials()); // { type: "admin-secret", secret }
expect(await admin.whoami()).toEqual({ actor: "admin" });
const ada = api.authenticate(adminCredentials({ sub: "user_ada@example.com", email: "ada@example.com" }));
expect((await rejection(ada.projects.get(projectId).whoami())).code).toBe("FORBIDDEN"); // the admin's project, not hers
expect((await rejection(api.authenticate({ type: "from-server-cookie" }).whoami())).code).toBe("UNAUTHENTICATED"); // no cookie on this socket
// e2e/session.e2e.test.ts
```

A bound session lists its one project and cannot `create()` — the catalog's writer is a control-plane
user (or the admin).

### The project secret, and minting tokens

Two doors ride the root context `projects.get(project)` vends, so `get`'s admission — a member, the
admin, the project's own secret — is their gate, and neither touches a Durable Object.

`rotateApiKey()` mints the project's own key: 32 random bytes as base64url, answered ONCE. Only the
SHA-256 hash is stored, in `SECRETS_KV` under `project-api-key:<projectId>` — outside the
`secret:<projectId>:` prefix `itx.fetch` substitutes from, so no `getSecret("/secrets/…")`
placeholder can ever mail it out. A reveal IS a rotation: the previous key stops verifying at once, and a project
has no key until the first call. `authenticate({ type: "project-secret", project, secret })` hashes
the candidate and compares in constant time (`verifyProjectSecret`, `src/principal.ts`); the session
it opens IS the project:

```ts
const key = await mintProjectApiKey(projectId); // e2e/support/principal.ts: projects.get(project).rotateApiKey() on the admin session
const device = api.authenticate({ type: "project-secret", project: projectId, secret: key });
expect(await device.whoami()).toEqual({ projectId, actor: `project:${projectId}` });
await device.projects.get(projectId).append({ type: "reading", payload: { celsius: 21 } }); // stamped { actor: "project:<id>" }
expect((await device.projects.list()).map((p) => p.id)).toEqual([projectId]); // bound: list is the one project…
expect((await rejection(device.projects.get(`${projectId}-other`).whoami())).code).toBe("FORBIDDEN"); // …get elsewhere refused
const next = await device.projects.get(projectId).rotateApiKey(); // any handle that reaches the project may rotate
expect((await rejection(api.authenticate({ type: "project-secret", project: projectId, secret: key }).whoami())).code).toBe("INVALID_CREDENTIALS"); // the old key died
// e2e/session.e2e.test.ts
```

`mintToken({ ttlSeconds? })` signs a project token for that project as whoever holds the handle —
the admin, a member, the project itself — 15 minutes by default, 24 hours at most; it is what the
console links a project host through (`/.itx/session?token=`, below), and what a script presents
as a bearer:

```ts
const adminToken = await itx.mintToken(); // the admin's handle ⇒ { projectId, actor: "admin" }
expect(await api.authenticate({ type: "project-token", token: adminToken }).whoami()).toEqual({ projectId, actor: "admin" });
const hers = await ada.projects.get(own).mintToken({ ttlSeconds: 60 }); // a member's ⇒ her principal, her project
const asItself = await api.authenticate({ type: "project-secret", project: projectId, secret: next }).projects.get(projectId).mintToken();
expect(await api.authenticate({ type: "project-token", token: asItself }).whoami()).toEqual({ projectId, actor: `project:${projectId}` });
// e2e/session.e2e.test.ts
```

Two handles have neither door (`FORBIDDEN`). One no session vended — a loaded worker's `env.ITX`:
loaded code speaks for the project and signs as nobody. And a project-TOKEN session's: a token is a
delegation, minutes long, and mints no further token and rotates no key — the member, the admin, or
the project-secret session for its own project does (`src/session.ts` hands a token session no
project doors).

### The principal is stamped on events, and carried by `cd`

The principal rides every dispatch the session makes (`invokeAs`, a DO-only Workers-RPC verb; the
`x-itx-principal` header on a terminal fetch), and the DO's append root stamps it as
`source.principal` on every event. It is the DO's field: a client's own `source.principal` is
overwritten — the admin session's with `{ actor: "admin" }` — and the platform's own rows carry it too:

```ts
const itx = authenticated.projects.get(projectId);
await itx.append({ type: "note", payload: { n: 1 }, source: { principal: { actor: "forged" } } });
await itx.provide("itx.demo", "itx.builtins.kv"); // the platform's own row, appended for this session
await openItx(projectId).append({ type: "note", payload: { n: 2 }, source: { principal: { actor: "forged" } } }); // the admin
const events = await readAll(openItx(projectId));
expect(events.find((e) => e.type === "note" && e.payload?.n === 1)?.source?.principal).toEqual(principal);
expect(events.find((e) => e.type === "events.iterate.com/itx/rewrite-rule-configured")?.source?.principal).toEqual(principal);
expect(events.find((e) => e.type === "note" && e.payload?.n === 2)?.source?.principal).toEqual({ actor: "admin" });
await itx.invoke("itx.cd('/sibling').append({ type: 'note', payload: { via: 'cd' } })"); // the built-in cd carries it
expect((await readAll(itx.cd("/sibling"))).find((e) => e.type === "note")?.source?.principal).toEqual(principal);
// e2e/session.e2e.test.ts
```

The stamp is `stampPrincipal` in `src/principal.ts`: drop whatever `source.principal` the client
supplied, set the session's, and leave no empty `source` behind. A loaded worker's `env.ITX` carries
NO principal: it speaks for the project, and the request's principal reaches an app as
`x-itx-principal` for the app to attribute what it appends itself. A secret's change event is
attributed the same way (`e2e/secrets.e2e.test.ts`).

### On a project host: the cookie and the bearer

`/.itx/session?token=<projectToken>&next=<path>` turns a token for THIS project into the host-scoped
`itx-project-session` cookie (HttpOnly, Secure, SameSite=Lax, until the token expires) and redirects,
never off the host; `?logout` clears it. A valid token — the cookie (a browser) or
`Authorization: Bearer <projectToken>` (a script; the bearer wins) —
stamps `x-itx-principal` on the Request the app sees. The token itself never reaches the app. The
project's own secret as the bearer is THE DEVICE LANE (the kit's provisioning partition carries the
project slug and this key): the app sees `{ actor: "project:<id>" }`, never the key; another
project's secret is nobody here and passes through as the app's own bearer would:

```ts
const door = await fetchProjectHost(host, `/.itx/session?token=${token}&next=/w`);
expect(door.status).toBe(303);
expect(door.headers["set-cookie"]).toContain(`itx-project-session=${token}`);
const seen = JSON.parse((await fetchProjectHost(host, "/echo", { cookie: `${cookieHeader}; theme=dark` })).text);
expect(seen.principal).toEqual(principal); // the verified stamp…
expect(seen.cookie).toBe("theme=dark"); // …never the platform's cookie; the visitor's own cookies still reach the app
expect((await fetchProjectHost(host, `/.itx/session?token=${foreign}&next=/`)).status).toBe(401); // another project's token; a visitor's own x-itx-principal is stripped
const device = JSON.parse((await fetchProjectHost(host, "/echo", { authorization: `Bearer ${await mintProjectApiKey(projectId)}` })).text);
expect(device.principal).toEqual({ actor: `project:${projectId}` }); // the device lane…
expect(device.authorization).toBeNull(); // …the platform's credential, stripped
// e2e/ingress-project-host.e2e.test.ts
```

On `/mcp`, the bearer's principal — the grant's user, `admin`, `project:<id>` — is what a
`tools/call` appends under (the control plane section above); there is no unauthenticated MCP
door: the provider refuses a request with no bearer, or a token for another resource, before a
tool runs.

**What this brick leaves on the table:** nothing about correctness. What is left is cost: a
context with a thousand clients attached, a hosted facet, a memoized MCP session and a retry ladder
grinding — what does it cost while nobody is calling?

---

## 11. hibernation and cost

### Pagers: the DO holds no stub while idle

Chapter 1 laid the brick: a borrowed live stub is an active reference, a Durable Object holding one
can never be evicted, and a thousand idle providers would pin a thousand DOs awake. So the DO holds a
hibernatable WebSocket per lent key instead and pages the edge for a key not borrowed. The relay's
30 s keepalive is answered by a WebSocket auto-response set once in the constructor, without waking
the DO. Losing the borrowed stubs at idle costs exactly one page on the next call — that is the deal.

### The idle quiesce

Three things pin a context awake: a materialized facet, a borrowed stub, a held library connection.
Sixty seconds without a call, a delivery or a borrow, the alarm aborts every idle facet, returns
every borrowed stub and releases every connection, so the actor can hibernate:

```ts
// iterate-context-durable-object.ts — alarm(), abridged
const IDLE_QUIESCE_AFTER_MS = 60_000;
async alarm(): Promise<void> {
  await this.#subscriptionDelivery.deliverEveryCursorSubscription(); // 1. due retries — AWAITED, so a re-arm lands before hibernation
  // …the self-wake breaker (below)
  const quiet = Date.now() - this.#lastActivityMs >= IDLE_QUIESCE_AFTER_MS; // 2. the idle QUIESCE
  if ((quiet || this.#stream.selfWakeHalted()) && this.#facetWorkInFlight === 0) {
    for (const facetName of this.#liveFacetNames) this.#abortFacetIfRunning(facetName, "idle quiesce");
    this.#liveFacetNames.clear(); // aborted facets re-materialize on their next call
    this.#rpcStubs.returnBorrowedRpcStubs();
    this.#library.releaseConnections();
  } // …else, with something still to quiesce, look again when the quiet period would end — never in the past
}
```

An aborted facet re-materializes from its durable startup memo on the next call, its storage having
survived. A facet's answer arrives as a Workers-RPC result carrying a disposer that holds a reference
on the facet until disposed or GC'd — GC is too late for the quiesce — so the DO copies the data out
and disposes the result at once; the SDK host releases its `env.ITX.get()` capability after every
append and read for the same reason.

### Alarms only while something is owed

The quiet clock is armed only when there is something to quiesce — a live facet or a borrowed stub —
and never re-armed otherwise; a bare probe never pays a storage write plus a billed wake for nothing.
The cursor lane arms the alarm itself whenever a delivery is owed — a batch queued for a row it does
not know as a push row, and before every awaited call — so an eviction mid-call leaves the alarm
behind to re-derive its obligations from the rows and the log.

### The watchdog on facet calls

A facet call that never answers would hold the in-flight count, and with it the quiesce, and with
that the actor, forever. So `#invokeFacet` counts the call in (`#facetWorkInFlight++`, so a
concurrent alarm's quiesce never aborts a facet mid-call), loads the class from the facet's startup
memo (aborting a running facet whose loaded identity changed, so a new source restarts it in place
with its storage surviving), runs the call under `withTimeout(call, FACET_CALL_WATCHDOG_MS = 60_000,
…)`, and on `TIMEOUT` aborts the facet — the pending call rejects, the counter drains, the next call
re-materializes it. A finished call earns a fresh quiet period. A cursor delivery's awaited call is
bounded by its own 20 s watchdog, and a push subscriber that stops reading is not buffered past 8 MiB
pending across all rows and 8 MiB in flight per context — the oldest events are dropped and the
push's `after` moves up, the span the subscriber heals from the log.

### The self-wake breaker

One control exists beyond these: a context whose alarm fires five times in a row with no public door
touched in between has woken itself for nothing, and `stream/self-wake-halted { streak }` is appended
once and the alarm stops arming until a real request clears the streak
(`e2e/stream.e2e.test.ts` is the opt-in deployed observation).

### Where it is proven

The hibernation property at scale — hundreds of clients providing into one context, the DO evicted,
every value still callable on wake — is deterministic inside workerd
(`__workers-tests__/hibernation-at-scale.test.ts`); the alarm's two duties in order are
`__workers-tests__/alarm-quiesce.test.ts`. Both use `cloudflare:test`'s eviction, which times out on
a warm DO exactly as production refuses to evict a pinned one. Isolate limits are measured deployed
only, in `e2e/stream-isolate-ceilings-deployed.e2e.test.ts` and `e2e/stream-isolate-ceilings-deployed.e2e.test.ts`.

**What this brick leaves on the table:** nothing to build. What is left is the map.

---

## 12. The map

| Chapter | What it built | Where it lives |
| --- | --- | --- |
| 0 | the session, `/api`, `whoami`, the dotted hop | `src/worker.ts`, `src/session.ts`, `src/iterate-context.ts`, `src/context/expression.ts` (the prototype hop) |
| 1 | rpc stubs: lend, borrow, page, recall, presence | `src/context/rpc-stubs.ts`, `src/session.ts` |
| 2 | itx expressions, the codec, `cd` | `src/context/expression.ts`, `src/iterate-context.ts` |
| 3 | rewrite rules, the seven rules, `itx.builtins`, masks, `@` | `src/context/itx-expression-rewriting.ts`, `src/context/built-ins.ts` |
| 4 | the stream, offsets, idempotency, ephemerals, the core reduce | `src/stream/stream.ts`, `src/stream/processor.ts`, `src/stream/core-processor.ts` |
| 5 | subscriptions, push vs cursor, the ladder, `consumes` | `src/stream/core-processor.ts`, `src/stream/subscription-delivery.ts` |
| 6 | facets, processors, live state | the DO's `#invokeFacet`, `src/stream/processor.ts`, `src/sdk/index.ts`, `src/client/` |
| 7 | loaded workers, `env.ITX`, the loader, the config worker, repos | `src/context/worker-loader.ts`, `src/iterate-context.ts`, `src/sdk/index.ts`, `src/context/repos.ts` |
| 8 | fetch in the context of this project (secrets), project hosts, the upgrade leg | `src/iterate-context-durable-object.ts`, `src/context/rpc-stubs.ts`, `src/worker.ts` |
| 9 | the library | `src/library.ts` |
| 10 | identity, tokens, the control plane | `src/principal.ts`, `src/session.ts`, `src/control-plane.ts` |
| 11 | pagers, the quiesce, alarms, the watchdog, the breaker | `src/iterate-context-durable-object.ts`, `src/stream/stream.ts` |

The invariants a reader should now be able to state:

- **The client is just capnweb.** Every class a client holds is a server-side `RpcTarget`; the
  dotted surface is a prototype hop that reduces into one `invoke(expression)`.
- **Two words, kept apart.** An rpc stub is physical, lives at the edge, and is borrowed, returned
  and paged for by the DO. A rewrite rule is data — `{ match, target }` in a map by canonical match,
  written by one event — and a lent stub is reached THROUGH a rule naming the physical registry.
- **The platform never spells a short name.** Every expression it writes is rooted at
  `itx.builtins`, the fixed point; rules resolve first, the platform rows are implicit, `null` masks
  under a platform row and deletes elsewhere, the platform-equivalent target deletes.
- **Everything else is an event.** The DO has `append` and no configuration verbs; every verb builds
  an event and appends it, session-scoped through its handle, durable as the raw event.
- **Runtime state is reduced state.** Rules, subscription rows, the pause and the secrets catalog are
  slices of the core reduce, reduced inside the commit; `itx.facets.get('core').snapshot()` shows it.
- **Delivery is decided by the value, not declared.** A facet or a lent stub owns its progress and is
  pushed; anything else gets a stream-kept cursor, at-least-once, one ladder, a halt fact, a resume.
- **A processor is a subscription whose target is a facet's `processEventBatch`.** Two classes, one
  pure; the host is hosted like any class; disabling is one event and the facet goes with it.
- **Loaded code's whole world is `env.ITX`.** `get()` is the real `IterateContext`, `fetch` is the
  DO's fetch door; the context is a prop, not a binding.
- **A fetch-shaped capability is always a terminal `.fetch(request)`.** `itx.fetch` is fetch in the
  context of this project — secrets substituted, refusals to the caller; the way in is a project
  host, answered by the config worker's `fetch`.
- **Identity is attribution.** The DO stamps `source.principal`; the session is bound by its token;
  membership is the directory's; loaded code speaks for the project.
- **The DO holds nothing across idle.** Pagers, the quiesce, alarms only while something is owed, a
  watchdog on every facet call, one breaker on self-wakes.

---

## Verified against

Every client snippet above is lifted from, or composed of calls made by, these files of the e2e lane
(`pnpm e2e`; the same suite runs against the deployed worker with `WORKER_BASE_URL`):

| Chapter | e2e files |
| --- | --- |
| preamble | `e2e/support/client.ts`, `e2e/session-wire-frames-one-round-trip.e2e.test.ts` (the `using` row) |
| 0 | `e2e/session.e2e.test.ts`, `e2e/context.e2e.test.ts`, `e2e/session-wire-frames-one-round-trip.e2e.test.ts` |
| 1 | `e2e/rpc-stubs-values.e2e.test.ts`, `e2e/rpc-stubs-reconnect-and-attach.e2e.test.ts`, `e2e/rpc-stubs-lend-recall-and-offline.e2e.test.ts`, `e2e/session.e2e.test.ts`, `e2e/session-wire-frames-one-round-trip.e2e.test.ts`, `e2e/rewrite-rules.e2e.test.ts` |
| 2 | `e2e/rpc-stubs-values.e2e.test.ts`, `e2e/rewrite-rules.e2e.test.ts`, `e2e/session.e2e.test.ts`, `e2e/context.e2e.test.ts` |
| 3 | `e2e/rpc-stubs-values.e2e.test.ts`, `e2e/rewrite-rules.e2e.test.ts`, `e2e/ai-root-shadow-and-fable.e2e.test.ts`, `e2e/rpc-stubs-reconnect-and-attach.e2e.test.ts` |
| 4 | `e2e/context.e2e.test.ts`, `e2e/support/client.ts`, `e2e/stream.e2e.test.ts`, `e2e/stream-isolate-ceilings-deployed.e2e.test.ts`, `e2e/push-delivery.e2e.test.ts`, `e2e/rpc-stubs-lend-recall-and-offline.e2e.test.ts` |
| 5 | `e2e/push-delivery.e2e.test.ts`, `e2e/rpc-stubs-reconnect-and-attach.e2e.test.ts`, `e2e/rpc-stubs-lend-recall-and-offline.e2e.test.ts`, `e2e/cursor-delivery.e2e.test.ts` |
| 6 | `e2e/workers-and-facets.e2e.test.ts`, `e2e/support/sources.ts`, `e2e/processor-facets.e2e.test.ts`, `e2e/live-state-chains-client-side.e2e.test.ts`, `e2e/stream.e2e.test.ts` |
| 7 | `e2e/session.e2e.test.ts`, `e2e/workers-and-facets.e2e.test.ts`, `e2e/stream.e2e.test.ts`, `e2e/rpc-stubs-values.e2e.test.ts`, `e2e/config-worker.e2e.test.ts`, `e2e/cfartifacts.e2e.test.ts` (deployed only), `e2e/config-worker.e2e.test.ts` (deployed only) |
| 8 | `e2e/secrets.e2e.test.ts`, `e2e/fetch-door.e2e.test.ts`, `e2e/session.e2e.test.ts`, `e2e/ingress-project-host.e2e.test.ts` |
| 9 | `e2e/library-connectors.e2e.test.ts` (against the deployed pet shop; the WebSocket transports deployed only) |
| 10 | `e2e/session.e2e.test.ts`, `e2e/secrets.e2e.test.ts`, `e2e/ingress-project-host.e2e.test.ts`, `__workers-tests__/control-plane.test.ts` (the `/mcp` rows) |
| 11 | `e2e/stream.e2e.test.ts` (opt-in, deployed only), `__workers-tests__/hibernation-at-scale.test.ts`, `__workers-tests__/alarm-quiesce.test.ts` |

The server snippets are abridged from the files named in each code block's first comment. The rule
table of chapter 3 was checked by running `src/context/itx-expression-rewriting.test.ts` and
`src/context/expression.test.ts` in the unit lane (145 rows, green) while writing.

## Not verified

- **The expected-offset contract in chapter 4** (`offset` on an event → `OFFSET_CONFLICT`) is
  stated from source; no e2e file appends an event with an expected `offset`. It is pinned in the
  unit lane, `src/stream/stream.test.ts`.
- **The 2 KiB string cap** (`EXPRESSION_TOO_LONG`) and the **1 MiB facet-source ceiling**
  (`FACET_SOURCE_TOO_LARGE`) are stated from source and their unit tables
  (`src/context/expression.test.ts`, `src/context/worker-loader.test.ts`); no e2e file drives either
  refusal.
- **`useLiveState`** (chapter 6) is described from `src/client/demo.tsx` and is exercised by
  `specs/live-state-demo.spec.ts` (Playwright over `/demo`), not by the e2e lane.
- **The cookie credential** (chapter 10) is described from `src/session.ts`, `src/worker.ts` and
  `src/control-plane.ts`; the e2e lane runs on the admin secret throughout, and the cookie's
  admissions (the same-origin check, membership) are pinned in `__workers-tests__/control-plane.test.ts`.
- **The fetch-upgrade leg's mechanism** (chapter 8) is described from the doctrine header of
  `src/context/rpc-stubs.ts`; the e2e lane proves the capnweb-provider half end to end and marks
  the dynamic-worker-provider half `test.fails`; the workerd-provider half is
  `__workers-tests__/ws-fetch-live-101.test.ts`.
- **The self-wake breaker's streak of five** is stated from `src/stream/stream.ts`
  (`SELF_WAKE_HALT_STREAK`) and `src/stream/stream.test.ts`; the e2e observation is opt-in and
  eviction-rate dependent.
