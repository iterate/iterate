# itx, the clean core

A from-scratch derivation of **itx** — Iterate's capability layer — reduced to the
parts that actually carry weight. Every code block below is quoted from
[`clean-core.mjs`](./clean-core.mjs), a runnable, self-checking model:

```bash
node clean-core.mjs    # prints one ✓ per claim in this doc, or throws
```

> **What this version drops on purpose.** Earlier iterations grew three mechanisms
> that, on review, cost more than they bought:
>
> - **No `origin` tracking.** There is no "act on behalf of" tag riding the wire.
> - **No dragging the calling context around.** A capability is never handed an
>   ambient `itx` argument on every call. When a capability needs another capability,
>   it **captures that specific reference** when it is built — authority rides the
>   reference, not an ambient channel.
> - **No dependency on capnweb's internal `followPath`.** We write our own traversal.
>   It's ~20 lines and we own it.
>
> What's left is the irreducible core, and it still does the interesting thing — the
> capstone (inheritance + shadow + super) works end-to-end without any of the above.

itx is built on **Cap'n Web**: a session over a socket where you call methods on a
typed stub and stubs can be passed as arguments in either direction. In this model a
"stub" is just a JS object and a "session" is just a function call, so we can run the
whole thing in plain Node. The shapes — the algorithms and the data — are the real
ones; only the transport is faked.

We build it in four parts, then assemble the capstone.

---

## Part 1 — A capability is a callable reached by a path

The atom of the system is a **capability**: a reference you can call. You reach one by
a **path** — an array of segments like `["db", "users", "get"]`. The registry (Part 3)
resolves the longest _named_ prefix to a target object; whatever segments are left over
are walked on that object and the last one is called.

That walk is `followPath`. We write it ourselves so itx depends on nothing internal to
capnweb:

```js
function followPath(target, path, args) {
  if (path.length === 0) {
    if (typeof target !== "function") {
      throw new Error("capability is not callable and no path was given");
    }
    return target(...args);
  }

  let holder = target;
  // Walk every segment except the last, descending into own properties.
  for (let i = 0; i < path.length - 1; i++) {
    assertSafeSegment(holder, path[i]);
    holder = holder[path[i]];
    if (holder == null) {
      throw new Error(`path segment "${path[i]}" resolved to ${holder}`);
    }
  }

  const method = path[path.length - 1];
  assertSafeSegment(holder, method);
  const fn = holder[method];
  if (typeof fn !== "function") {
    throw new Error(`"${method}" is not a function`);
  }
  return fn.apply(holder, args); // preserve the receiver
}
```

Two rules in `assertSafeSegment` are load-bearing, not decoration:

```js
const RESERVED_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "then",
  "catch",
  "finally",
]);

function assertSafeSegment(holder, segment) {
  if (typeof segment !== "string") {
    throw new Error(`path segment must be a string, got ${typeof segment}`);
  }
  if (RESERVED_SEGMENTS.has(segment)) {
    throw new Error(`refusing reserved path segment "${segment}"`);
  }
  if (!Object.hasOwn(holder, segment)) {
    // own-property only: never traverse up the prototype chain.
    throw new Error(`"${segment}" is not an own property of the capability`);
  }
}
```

1. **Reserved segments are refused.** `__proto__`/`constructor`/`prototype` would let a
   path climb the prototype chain; `then`/`catch`/`finally` would make a returned value
   look like a promise to the RPC layer. Neither is ever a real capability member.
2. **Only own properties are followed.** A path may not reach through an object's
   prototype to call a method it never explicitly exposed. `obj.toString` is refused.

Both rules trace to one root: **a path is a string array, not a reference.** The
prototype names let a string climb the prototype chain; `then`/`catch`/`finally` let a
returned value masquerade as a promise — neither hazard exists if you hold a real
reference and never do string member-access at all. That's why this guard is the one
piece that doesn't simplify away, no matter what else changes.

> **Model scope.** This reserved set is for a model where every target is a plain JS
> object or function. Over a real Cap'n Web wire the target is a stub, and the set must
> additionally refuse the stub-control names — `dup`, `map`, `apply`, `call`, `bind` —
> which here are either caught by the own-property guard (they live on `Function.prototype`)
> or simply don't exist. Port the _rule_ (refuse what isn't a real member), not this
> literal set.

`fn.apply(holder, args)` preserves the receiver, so a mounted SDK's `this`-using
methods work unchanged — a real `@slack/web-api` client can be a capability with zero
adaptation.

> ✓ _checks:_ `followPath` calls a bare function; walks an own path preserving `this`;
> refuses `__proto__`/`then`; refuses inherited `toString`.

---

## Part 2 — Two kinds of capability: live and sturdy

A capability is one of two kinds, and the distinction runs through everything:

- **Live** — an in-memory object or function (a Cap'n Web stub on a live socket). It
  cannot be serialized; when its connection dies, it is gone.
- **Sturdy** — a serializable **address**, `{ worker, entrypoint, props }`, that a
  **restorer** can turn back into a live target on demand. This is Cap'n Proto's
  SturdyRef + restorer pattern. Cap'n Web gives you live stubs but no sturdy refs; this
  is the main thing itx adds on top.

`dial` is the restorer — it maps an address back to a live target. In production it's
the platform's worker loader / Durable Object namespace; here it's a `Map`:

```js
const WORKERS = new Map(); // worker name → (entrypoint, props) → live target

function isAddress(value) {
  return (
    value != null &&
    typeof value === "object" &&
    typeof value.worker === "string" &&
    "entrypoint" in value
  );
}

function dial(address) {
  const make = WORKERS.get(address.worker);
  if (!make) throw new Error(`cannot dial unknown worker "${address.worker}"`);
  return make(address.entrypoint, address.props);
}
```

Hold on to the live/sturdy split. It looks like it could be unified ("a live cap is
just a sturdy one with a trivial restorer"), but Part 4 shows why it can't: only one of
the two can be written down.

---

## Part 3 — A context is a registry of capabilities, and is itself a capability

A **context** (`Itx`) is a named registry. It maps capability names to entries, holds
live stubs in a side overlay, and points at a parent context for inheritance:

```js
class Itx {
  constructor(name, parent = null) {
    this.name = name;
    this.parent = parent;
    this.providers = new Map(); // name → { kind: "live"|"sturdy", address: object|null }
    this.liveStubs = new Map(); // name → live target (overlay; never serialized)
    this.log = []; // durable event log
  }

  extend(childName) {
    return new Itx(childName, this);
  }
  // ...
}
```

The key idea: **a context is itself a capability**. Its call surface is `invoke`, so a
context can be provided into another context as just another entry — contexts compose
recursively. That's what makes the inheritance chain (Part 5) work without any special
machinery.

### provide and revoke

`provide` splits on the kind. An address is recorded durably; anything else is a live
stub held in the overlay:

```js
provide(name, target) {
  if (isAddress(target)) {
    this.providers.set(name, { kind: "sturdy", address: target });
    this.liveStubs.delete(name);
    this.log.push({ type: "capability-provided", name, address: target });
  } else {
    // LIVE-STUB BRIDGE (simplified): hold the stub so a *different* caller, who
    // never had it passed to them, can still reach it. The fold records
    // address:null so a restart knows the capability existed but is now offline.
    this.providers.set(name, { kind: "live", address: null });
    this.liveStubs.set(name, target);
    this.log.push({ type: "capability-provided", name, address: null });
  }
}
```

That `liveStubs` overlay is the **live-stub bridge**, the one piece people find nasty,
so it's worth saying exactly what it's for and nothing more. When client A provides a
live capability, A's stub has to be reachable by a _different_ client B who never had it
passed to them. The single place both connections meet is the context (a Durable Object
in production), so the stub is held there. That's it — a holding pen so a live reference
outlives the one call that delivered it and is reachable by someone other than its
provider.

Two real-deployment details the model elides, called out so the bridge isn't
mysterious:

- In production the held stub must be **retained against disposal** — Cap'n Web disposes
  an argument stub when the delivering call returns, so the context keeps it alive with
  a `.dup()`. A live _object_ whose members are themselves stubs (a mounted SDK like
  `{ chat: { postMessage } }`) needs a **recursive** dup of each member, not a single
  top-level one. Here a plain reference suffices because nothing disposes it.
- Teardown is **one wire**: capnweb's `onRpcBroken` fires when A's socket drops, and the
  overlay entry is reaped. There is no separate bookkeeping — no journaled
  "disconnected" event, no parallel release map, no keep-the-isolate-alive timer. The
  durable record stays (so a restart knows the capability existed); only the live stub
  is dropped.

```js
revoke(name) {
  this.providers.delete(name);
  this.liveStubs.delete(name);
  this.log.push({ type: "capability-revoked", name });
}

onConnectionBroken(name) {
  this.liveStubs.delete(name); // the only teardown path for a live capability
}
```

### resolve, borrow, invoke

Resolution finds the entry that owns a path: longest named prefix within a context,
then climb to the parent. Borrowing produces the live target — the held stub for a live
cap, a fresh `dial` for a sturdy one. `invoke` ties them together and hands the leftover
path to `followPath`:

```js
resolve(path) {
  for (let len = path.length; len >= 1; len--) {
    const name = path.slice(0, len).join(".");
    const entry = this.providers.get(name);
    if (entry) return { ctx: this, entry, name, matchedLen: len };
  }
  if (this.parent) return this.parent.resolve(path);
  return MISS;
}

#borrow(ctx, entry, name) {
  if (entry.kind === "live") {
    const stub = ctx.liveStubs.get(name);
    if (!stub) {
      throw new Error(`capability "${name}" is offline (live provider disconnected)`);
    }
    return stub;
  }
  return dial(entry.address);
}

invoke(path, args = []) {
  const r = this.resolve(path);
  if (r === MISS) throw new Error(`no capability at "${path.join(".")}"`);
  const target = this.#borrow(r.ctx, r.entry, r.name);
  return followPath(target, path.slice(r.matchedLen), args);
}
```

That's the whole call path: **resolve → borrow → traverse → call.** Three of the four
verbs (`provide`, `revoke`, `invoke`) are here; `describe` is a pure read over the chain.

> ✓ _checks:_ provide+invoke a live function; a live object via a dotted path;
> longest-prefix selection; a sturdy cap dialed and invoked.

---

## Part 4 — The fold: durable state is a reduction over the log

A context's `providers` map is not the source of truth — the **event log** is. Folding
the log rebuilds the registry. This is where live and sturdy stop being symmetric:

```js
function reduceItxEvent(registry, event) {
  switch (event.type) {
    case "capability-provided":
      registry.set(event.name, {
        kind: event.address ? "sturdy" : "live",
        address: event.address ?? null,
      });
      break;
    case "capability-revoked":
      registry.delete(event.name);
      break;
    // Unknown events are ignored — the fold only consumes what it understands.
  }
  return registry;
}

function rebuildFromLog(name, log) {
  const ctx = new Itx(name);
  for (const event of log) reduceItxEvent(ctx.providers, event);
  // liveStubs is intentionally empty: the overlay did not survive the restart.
  return ctx;
}
```

- A **sturdy** cap is fully reconstructed — its address is in the event, so after a cold
  start it is immediately invocable again via `dial`.
- A **live** cap cannot be reconstructed — a socket can't be serialized. The fold knows
  it _existed_ (`address: null`) and marks it offline. It returns only if the provider
  reconnects and provides again.

This is the answer to "why not unify the two kinds": **only the sturdy one can be
written down.** The live kind is, by definition, the part of the system that does not
survive the fold — that's not an implementation detail you can refactor away, it's the
distinction itself.

> ✓ _check:_ after `rebuildFromLog`, the sturdy cap is invocable; the live cap is
> present-but-offline and throws on invoke.

---

## Part 5 — The chain: inheritance, shadow, and super

A context can `extend` a parent. Because `resolve` climbs to the parent when it finds
nothing locally, a child reaches every parent capability **by reference**, resolved
fresh on every call (late binding). Three behaviours fall out for free:

**Inheritance.** A child invokes a capability it never provided; resolution climbs and
finds the parent's.

**Shadowing.** A child provides the same name; its own entry is found before the climb,
so the child's wins — and the parent's is untouched for everyone else.

**Late binding / one-cap-N-references.** Because resolution re-runs every call, revoking
or swapping a capability at the base is seen _instantly_ by every child. There is no
copying; a child holds a reference to the chain, not a snapshot.

The interesting one is **super** — how a shadow delegates to the version it shadows.
This is exactly where earlier versions reached for ambient context (`origin`, a
calling-context argument). We don't. A shadow gets super by **capturing a reference**:

```js
superRef(path) {
  if (!this.parent) throw new Error("no parent to super into");
  const parent = this.parent;
  return (...args) => parent.invoke(path, args);
}
```

`superRef(["fetch"])` returns a callable that resolves `fetch` **starting at the
parent**, skipping the child's own (shadowing) entry. The shadow captures it when it's
built and calls it at runtime. It's late-bound — if the parent later swaps `fetch`, the
captured ref follows — but it carries **no caller identity**. It is one specific
authority, held as one reference. That's the whole replacement for origin: instead of
threading "who is calling" through every invocation, you hand a capability the exact
references it needs, once, when you build it.

```js
const superFetch = child.superRef(["fetch"]);
child.provide("fetch", (url) => {
  log.push(url); // observe
  return superFetch(url); // delegate up the chain
});
```

> ✓ _checks:_ child inherits by reference; child shadow wins; shadow reaches super via a
> captured ref; base revoke removes the cap for the child instantly; a base swap is seen
> by every child; `superRef` follows a base swap.

---

## Capstone — inheritance + shadow + super, end to end, no origin

The whole point, assembled and observable. A project provides `fetch` and `db`. An agent
extends it, shadows `fetch` to log every request and delegate to the project's real one
via a captured super reference, and inherits `db` untouched.

```js
const log = [];

const project = new Itx("project");
project.provide("fetch", (url) => `200 ${url}`); // a real egress capability
project.provide("db", { query: (sql) => `rows(${sql})` }); // a real data capability

const agent = project.extend("agent");
const superFetch = agent.superRef(["fetch"]);
agent.provide("fetch", (url) => {
  log.push(`agent.fetch ${url}`);
  return superFetch(url);
});

// 1) The agent's own fetch: shadow fires, super reaches the base. No origin tag,
//    no calling context was passed — the shadow simply holds super's reference.
agent.invoke(["fetch"], ["/pets"]); // → "200 /pets", and logs "agent.fetch /pets"

// 2) The agent invokes the INHERITED db (it never provided one) — by reference.
agent.invoke(["db", "query"], ["SELECT 1"]); // → "rows(SELECT 1)"

// 3) The project calling its OWN fetch is NOT logged — the shadow is the agent's alone.
project.invoke(["fetch"], ["/admin"]); // → "200 /admin"; log still has 1 entry

// 4) Late binding holds end-to-end: revoke db at the base, the agent loses it.
project.revoke("db");
agent.invoke(["db", "query"], ["x"]); // throws — gone for the child instantly
```

Point **3** is the precise consequence of dropping origin, and it's worth being honest
about: a capability the _project_ calls runs against the _project's_ chain — it never
sees the agent's shadow. The subtler half of the same loss: even on an
**agent-initiated** call, an _inherited_ capability that internally calls a bare
`fetch` resolves that `fetch` against the chain it was **provided** on (the project's),
not the agent's — so the agent's shadow is invisible to it too. The shadow only governs
paths the agent itself resolves; it does not follow authority down into a capability it
merely invoked. With origin tracking, that inner `fetch` could be made to honour the
agent's shadow; we gave that up. In exchange, the model has no ambient authority
threading through it at all: **what a capability can reach is exactly the set of
references it was built with, plus its own chain.** Shadowing is real but
**chain-local** — it affects calls made _through_ the context that installed it, not
calls some other context (or some inherited capability) happens to make into a shared
capability.

That trade — lose cross-chain interposition, gain a system with no ambient authority —
is the entire thesis of this version.

> ✓ _check:_ the capstone runs all four steps and asserts each, including that the
> project's own fetch does **not** hit the agent's shadow.

---

## The core, in one breath

- A **capability** is a callable reference reached by a **path**; `followPath` walks the
  path (own-properties only, reserved segments refused) and preserves the receiver.
- A capability is **live** (a held stub, dies with its connection) or **sturdy** (a
  serializable address re-`dial`ed on demand). Only the sturdy kind survives the fold —
  which is why the two can't be unified.
- A **context** is a registry that is itself a capability; its verbs are `provide`,
  `revoke`, `invoke`, `describe`, and the call path is **resolve → borrow → traverse →
  call**.
- Durable state is a **fold** over an event log; the **live-stub bridge** is just a
  holding pen (retain on provide, reap on `onRpcBroken`) so a live reference is reachable
  by someone other than its provider.
- Contexts form an **inheritance chain**: children reach parents by reference (late
  binding), shadow by providing the same name, and reach **super** by _capturing a
  reference_ — no origin, no ambient calling context.

Everything else itx has ever grown is an addendum on top of this. This is the part that
has to be right.
