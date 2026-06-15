# itx, the clean core — restoring deep shadowing

`clean-core.md` reduced itx to a core with **no ambient authority**, and paid one
honest price: shadowing became _chain-local_. An inherited capability that internally
calls `fetch` resolves it against the chain it was **provided** on (the project's),
never the chain that **invoked** it (the agent's). So an agent that shadows `fetch` to
log or attenuate egress cannot see the egress of a capability it merely invoked.

This doc is a **menu**, not a sequel — `clean-core` stays exactly as it is. Here are
**four different ways** to buy that capability back, from a thin layer on top to a
mechanism woven through the core. Every one is validated against the _same_ capstone in
the runnable [`clean-core-2.mjs`](./clean-core-2.mjs):

```bash
node clean-core-2.mjs   # 11 checks across 4 versions — the scorecard below is not opinion
```

All four are written as **small deltas over one shared `BaseItx`** (which is clean-core
verbatim: chain-local, no interposition), so the _size of each delta_ is the honest
measure of "thin layer" vs "woven throughout."

### The capstone every version must pass

The only thing that changes between versions is the **mechanism** by which `petstore`'s
internal `fetch` finds the _caller's_ chain:

```js
project.provide("fetch", realFetch);
project.provide("petstore" /* a cap whose list() internally calls fetch("/pets") */);
const agent = project.extend("agent"); // agent shadows "fetch" to log → super

agent.invoke(["petstore", "list"]); // MUST log "agent.fetch /pets" + return base body
project.invoke(["petstore", "list"]); // MUST NOT log (project's own fetch)
```

### Scorecard

The rubric: **R1** does the full capstone work · **R2** thinness · **R3** ocap soundness
(least authority, no ambient) · **R4** raw-SDK-mount safety · **R5** fidelity to shipped
prod (`apps/os/src/itx`) · **R6** validity across a real DO/isolate boundary.

| Version                  | R1  | R2 thin | R3 ocap | R4 SDK | R5 prod | R6 x-isolate | one-line verdict                                       |
| ------------------------ | --- | ------- | ------- | ------ | ------- | ------------ | ------------------------------------------------------ |
| **A** factory injection  | 5   | **5**   | 4       | 5      | 4       | 2            | thin & clean, but hands the cap the _whole_ caller ctx |
| **B** explicit threading | 5   | 5       | 3       | **1**  | 2       | 3            | the yardstick; silently corrupts SDK mounts            |
| **C** ambient scope      | 3   | **5**   | **1**   | 5      | 2       | **1**        | a trap as primary; useful only in-isolate              |
| **D** membrane on borrow | 5   | 2       | **5**   | 4      | **5**   | 4            | least-authority, _is_ what prod does; woven            |

---

## Version A — borrow-time factory injection

A capability may be provided as a **factory** `(itx) => surface`. When it's borrowed,
the factory is built with the _calling_ context, so its internal `itx.invoke(["fetch"])`
resolves against whoever invoked it. The calling context is threaded as a default
parameter — it is the receiver `this` at the start of `invoke`, never a wire field, and
the parent climb happens _inside_ `resolve()` so it's never reset.

```js
class A_Itx extends BaseItx {
  _borrow(ctx, entry, name, callerCtx) {
    if (entry.kind === "factory") {
      const make = ctx.liveStubs.get(name);
      if (!make) throw new Error(`capability "${name}" is offline`);
      return make(callerCtx); // build the surface bound to the CALLER's itx
    }
    return super._borrow(ctx, entry, name);
  }
  invoke(path, args = [], callerCtx = this) {
    const r = this.resolve(path);
    if (r === MISS) throw new Error(`no capability at "${path.join(".")}"`);
    const target = this._borrow(r.ctx, r.entry, r.name, callerCtx);
    return followPath(target, path.slice(r.matchedLen), args);
  }
}
```

The capstone in this style:

```js
project.provide(
  "petstore",
  factory((itx) => ({ list: () => itx.invoke(["fetch"], ["/pets"]) })),
);
```

**~6 lines of delta, fully localized** (one `_borrow` branch, one defaulted `invoke`
param). itx lives in the _factory's_ argument, never in a method signature — so a raw
SDK mount (which is **not** a factory) is invoked untouched. The checks prove the deep
shadow fires for the agent, not the project, and that late binding still holds through
the factory.

- **The catch (R3 = 4, R6 = 2).** The factory receives the caller's _entire_ context —
  it can reach anything the caller can, which is more authority than it needs. And the
  literal `make(callerCtx)` only works in-process: across a real DO boundary you can't
  hand a remote isolate a local `this`. Prod gets this effect by _injecting a binding_
  into the loaded isolate (Version D), not by applying a JS closure.
- **The fix is small:** hand the factory an _attenuated_ view — `make(callerCtx.facet(["fetch"]))`
  — exposing only the names it declared it needs. That closes R3 and points straight at
  Version D.

---

## Version B — explicit threading (the yardstick)

The most literal mechanism: `itx` rides every call as the first positional argument. A
threaded `followPath` splices it in; a capability that needs egress declares `itx` as
its first parameter.

```js
function followPathThreaded(target, path, args, callerItx) {
  // …walk path… then:
  return fn.apply(holder, [callerItx, ...args]); // itx spliced first
}
class B_Itx extends BaseItx {
  invoke(path, args = [], callerItx = this) {
    const r = this.resolve(path);
    const target = this._borrow(r.ctx, r.entry, r.name);
    return followPathThreaded(target, path.slice(r.matchedLen), args, callerItx);
  }
}
```

It's the **thinnest** mechanism and the deep shadow works perfectly. Its job in this
lineup is to fail the one test that matters and show _why_ the cleverer options exist:

```js
itx.provide("slack", { chat: { postMessage: (opts) => `posted to ${opts?.channel}` } });
itx.invoke(["slack", "chat", "postMessage"], [{ channel: "#general" }]);
// → "posted to undefined"   — itx landed in arg 0, the real opts fell off the end. NO ERROR.
```

**R4 = 1, disqualifying.** A raw `@slack/web-api` client never agreed to take an `itx`
first parameter; splicing one in (leading _or_ trailing — v12 rejected the trailing form
for the same reason) silently corrupts every call. The corruption doesn't throw — it
posts to `undefined`. Mounting unadapted SDKs is a _stated core feature_ of itx
(`followPath`'s receiver preservation exists for it), so in-signature threading is
unshippable as the general mechanism. The only escapes are a separate channel or a
factory — i.e. the other three versions.

---

## Version C — ambient dynamic scope

A "current context" rides an `AsyncLocalStorage`; `invoke` wraps its body in
`CURRENT.run(this, …)`. The capability author writes **zero ceremony** — just call
`fetch` (via a shim) and it routes to whoever invoked you. This is the in-language twin
of prod's `globalOutbound` implicit door.

```js
const CURRENT = new AsyncLocalStorage();
const ambientFetch = (url) => currentItx().invoke(["fetch"], [url]);

class C_Itx extends BaseItx {
  invoke(path, args = []) {
    return CURRENT.run(this, () => super.invoke(path, args));
  }
}
// petstore.list = () => ambientFetch("/pets")   ← no factory, no arg, no captured ref
```

Thinnest call sites of all, and ideal for SDK mounts (a bundled npm dep calling bare
`fetch()` is caught with no adaptation). But it fails the two things that matter most,
and the checks prove both:

- **R3 = 1 — ambient authority.** A capability _provided by the project_ and never
  handed the agent's secrets can read an **agent-private** cap, simply because the agent
  invoked it: `currentItx().invoke(["agentSecret"])` returns the key. That is exactly
  the ambient authority clean-core abolished, reintroduced.
- **R6 = 1 — the boundary, silently.** `AsyncLocalStorage` does not cross a Workers-RPC /
  DO / isolate hop, and itx _lives_ across those hops. A dialed `petstore` runs with the
  scope cleared; its `ambientFetch` throws and the agent's shadow is never consulted —
  the door fails **silently** exactly where the real system puts its capabilities.

**Verdict:** a trap as the primary mechanism; legitimate only as an in-isolate ergonomic
shim _layered on top of_ the real (on-the-wire) carrier — never instead of it.

---

## Version D — membrane on borrow (the prod-faithful answer)

A capability is a factory of `(env) => surface`, but `_borrow` builds it with an `env`
that exposes **only an attenuated `fetch`**, re-rooted at the borrowing chain. The cap
author writes against a stable `env.fetch`, never sees the caller, never reads an
ambient — and receives _only_ the authority the platform chose to grant.

```js
class D_Itx extends BaseItx {
  _membraneEnv(originCtx) {
    return { fetch: (...args) => originCtx.invoke(["fetch"], args) }; // ONLY fetch, late-bound
  }
  _borrow(ctx, entry, name, originCtx) {
    if (entry.kind === "factory") {
      const make = ctx.liveStubs.get(name);
      return make(this._membraneEnv(originCtx));
    }
    return super._borrow(ctx, entry, name);
  }
  invoke(path, args = [], originCtx = this) {
    /* …threads originCtx into _borrow… */
  }
}
// petstore = factory((env) => ({ list: () => env.fetch("/pets") }))
```

- **R3 = 5 — best on ocap.** A membrane is the textbook least-authority construction. The
  check proves `env` is `{ fetch }` and _nothing else_ — no `invoke`, no `db`, no caller
  handle. Authority rides one attenuated reference, minted by the trusted borrow seam.
- **R5 = 5 — this _is_ prod.** `wireIsolateEnv` already constructs every loaded isolate
  with an `env.ITERATE`/`globalOutbound` scoped to the originating context at dial time
  (`apps/os/src/itx/isolate.ts`, threaded from `dial.ts`). The model's `_membraneEnv` is
  a faithful in-process reduction of that.
- **R6 = 4 — crosses the boundary** precisely _because_ it's binding injection into a
  freshly-built isolate, not a captured in-memory reference (the check shows two children
  get disjoint membranes for the same cap).
- **The cost (R2 = 2).** Honestly woven: it touches the provide shape (a factory),
  `_borrow` (membrane construction), `invoke`'s signature (the origin thread), and adds a
  per-cap `env` contract. It is not "a thin layer." This is the surface area prod pays —
  it's _why_ prod has an `isolate.ts`.
- **The honest gaps:** forgetting to author a cap as a factory silently loses attenuation
  (prod dodges this because _all_ loaded isolates are implicitly factories); and a truly
  **external** live provider (a Node process calling its own OS `fetch()`) has no `env` to
  inject, so its egress stays un-attenuable — the `🔬 proposed for the live case` itx
  flags as not wired today.

---

## What to pick

```
       thin layer on top  ───────────────────────────────────►  woven throughout
   C (ambient)        A (factory injection)                         D (membrane)
   zero ceremony      opt-in, clean methods                  least-authority, = prod
   ✗ ambient auth     ~ whole-ctx authority                  ✓ only what's granted
   ✗ dies at boundary ~ in-process literal                   ✓ crosses via injection
                                   B (explicit threading) — disqualified: corrupts SDKs
```

- **Ship D for the hosted / dialed / script egress path.** It's the only candidate that
  restores deep shadowing _and_ keeps clean-core's no-ambient-authority thesis (a membrane
  never puts an origin tag on the wire), _and_ it's what production already does. Its
  weakness is honesty about scope (it isn't thin; external live providers stay
  un-attenuable), not soundness.
- **A is the gentler on-ramp** if you want a thin in-process layer first — and it upgrades
  cleanly into D by handing a `facet` instead of the whole ctx. The end of that path is
  the ocap convergence the chain kept pointing at (v12 Step 13): **authority follows the
  reference** — the agent is handed a `fetch` already bound to its egress and provides it;
  the inherited cap takes a `fetch` _reference_ at delegation time. That deletes even the
  `originCtx` thread (you pass a stub, not a closure, so it crosses DOs natively), at the
  cost of capability authors writing against an explicit `fetch` reference rather than
  picking up the caller's chain transparently.
- **C only as an in-isolate shim**, layered on D's wire-level carrier — never as the
  mechanism.
- **B never**, except as the yardstick it is here.

The throughline: clean-core traded interposition for zero ambient authority. **D shows
you don't have to choose** — a membrane recovers interposition _while staying
least-authority_ — you just have to admit the core isn't as thin as clean-core's prose
claims. Everything else on the menu is either thinner-but-unsound (C), thinner-but-broad
(A), or thinner-but-broken (B).
