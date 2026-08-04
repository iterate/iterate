# Proposal A — The entrypoint is a socket; the graph is the program

_Designer A. One committed design. Grounded in `@iterate-com/capnweb@0.10.0` source, Cloudflare Workers
RPC, our `apps/os` god-object + loopback, and the clean-room `apps/control-plane` + `apps/project-worker`._

---

## Thesis

**There is exactly one `RpcTarget` graph. Transports are sockets that hand it out; they never shape it.**
A single `WorkerEntrypoint` exposes two doors onto that one graph — `fetch` (capnweb over WebSocket / HTTP
batch, for cross-account and cross-machine) and a non-reserved `get()` (Workers RPC, for the same-account
`env.ITX` loopback) — and both hand back instances of the _same_ shell classes. On this one graph, **two
orthogonal directions** run: **navigation goes inward** by RPC method call (`authenticate()` → control-plane
shell → `projects.get(id)` → project shell → `streams.get(path)` → a stream), and **provision falls
outward** through a first-class **linked list of `Resolver`s** (project shadow-table → control-plane →
iterate product → the _constructive_ config defaults baked into the deployed worker). A capability lookup
that misses locally walks that list outward until a link answers; any link may itself be a **remote stub**,
so the _same_ fallthrough works whether the next shell is a same-account binding, a BYO Cloudflare account,
or a Raspberry Pi that dialed out over NAT. The kernel is nothing but the **interface definitions** the
providers on that list satisfy (`Stream`, `Repo`); a stream is a Cloudflare Durable Object in the reference
impl and a Miniflare-on-a-Pi object in the self-host impl, and the graph cannot tell the difference. The
god-object dies because a shell is **thin** — it owns one `Resolver`, not seventeen getters.

The whole design is two sentences of type:

```
Navigate inward  (authority):   shell.method(args)         →  a narrower shell / a capability
Provide outward  (fallthrough): resolver.resolve(path)     →  a Provider, or ask resolver.next
```

---

## 1. The one entrypoint, two doors

The linchpin fact: on Workers, capnweb's `RpcTarget` **is an alias of the built-in `cloudflare:workers`
`RpcTarget`** (`dist/index-workers.d.ts:374` — _"on Cloudflare Workers, this `RpcTarget` is an alias for
the one exported from the `cloudflare:workers` module"_; README §"Cloudflare Workers RPC interoperability").
So a single class `extends RpcTarget` is **simultaneously** a legal Workers-RPC pass-by-reference target and
a legal capnweb target. We never write the graph twice.

```ts
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import { newWorkersRpcResponse, type RpcSessionOptions } from "@iterate-com/capnweb";
import type { Env, EntryProps } from "./env.ts";

// ONE entrypoint. Two transports. ONE graph of RpcTargets.
export class Itx extends WorkerEntrypoint<Env, EntryProps> {
  // ── DOOR 1 — capnweb (cross-account / cross-machine) ───────────────────────
  // `fetch` is RESERVED over Workers RPC — which is exactly why it is the RIGHT
  // home for the wire door: a Workers-RPC caller can NEVER invoke it, so it is
  // unambiguously "the socket", not a capability. `newWorkersRpcResponse` serves
  // BOTH the HTTP-batch POST and the WebSocket upgrade from one call
  // (capnweb dist/index-workers.d.ts:417).
  override fetch(request: Request): Promise<Response> {
    return newWorkersRpcResponse(request, this.#rootFor(request), this.#session());
  }

  // ── DOOR 2 — Workers RPC (same-account loopback: env.ITX.get()) ────────────
  // NOT `fetch`, and deliberately NOT `connect` (both are Fetcher-reserved).
  // `get` is the PROVEN name — domains/itx/itx-entrypoint.ts:26 already ships
  // `env.ITX.get()`. It returns the SAME shell class the wire door serves,
  // passed by reference as a Workers-RPC stub.
  get(): RpcTarget {
    return this.#rootFor(null);
  }

  // The ONLY branch in the whole entrypoint: which SHELL do you start at? The
  // answer is the props the HOST minted into this binding — identical to
  // scopeFromItxEntrypointProps today (domains/itx/itx-entrypoint.ts:26-39). A
  // pre-scoped loopback (a confined config/dynamic worker) starts INSIDE its
  // one project (the confinement). The public door starts unauthenticated.
  #rootFor(request: Request | null): RpcTarget {
    const p = this.ctx.props;
    if (p.kind === "project") {
      // Inner shell, already authenticated to exactly one project.
      return new ProjectShell(scopeOf(p), resolverForProject(p, this.env, this.ctx));
    }
    // Outer shell: you must authenticate() in-band.
    return new ControlPlaneShell(request, this.env, this.ctx);
  }

  // `onCall` is the iterate fork's per-invocation hook (dist/index-workers.d.ts:125,270).
  // Critically it "is propagated through promise pipelining", so a pipelined
  // dotted chain is still one traced logical op. This is where itx tracing lives.
  #session(): RpcSessionOptions {
    return { onCall: (info, invoke) => traceItxCall(info, invoke) };
  }
}
```

**Why one `fetch` and not the split we have today.** `apps/os/src/worker.ts:283-286` branches POST →
`newHttpBatchRpcResponse` and WS → `newWorkersWebSocketRpcResponse` to give each transport its own
`sessionId`. `newWorkersRpcResponse` already dispatches both internally, so the single-call form is cleaner;
the per-transport session id becomes a field the `onCall` hook stamps, not a reason to fork the handler. If a
deployment truly needs different limits per transport it can still branch on `request.headers.get("upgrade")`
— but that is an exception, not the shape.

**Why `get()` returns different shells for the two doors, and that is correct.** A confined config worker
has no business seeing other projects or calling `authenticate()` — it was born scoped. The public door has
no ambient identity — it must authenticate. Same classes, different _starting depth_, chosen by props. This
is exactly `ItxEntrypoint.get()` today returning `itxForScope(...)` for a scoped loopback vs
`UnauthenticatedOsRpcTarget` for the public `/api`.

---

## 2. The shells — navigation inward

Shells are plain `RpcTarget` subclasses. Each returns the next-narrower shell. Auth is **in-band and
returned**, never ambient — Kenton Varda's core argument for this shape:

> _"Due to the design of the web APIs for WebSocket, you generally cannot use headers nor cookies to
> authorize them… It is impossible for the client to 'forge' a session object. The only way to get one is
> to call `authenticate()`, and have it return successfully."_ — Cap'n Web launch post

```ts
// OUTER shell — the control plane. The only inward door is authenticate().
class ControlPlaneShell extends RpcTarget {
  constructor(
    private req: Request | null,
    private env: Env,
    private ctx: Ctx,
  ) {
    super();
  }

  async authenticate(credential?: string): Promise<SessionShell> {
    // The auth MECHANISM is itself a PROVIDED, SHADOWABLE capability (jam §4,
    // fork 6). The CP shell does not hardcode OAuth vs Cloudflare Access vs
    // wide-open — it asks its resolver for the "auth" provider, whose TERMINAL
    // default is the deployed worker's LOGIN_MODE (control-plane/src/app.ts
    // `ambientIdentity`). Iterate's deployment shadows it with OAuth; a
    // self-hoster shadows it with Clerk; the Pi floor leaves the open default.
    const auth = controlPlaneResolver(this.env, this.ctx).resolve(["auth"]) as AuthProvider;
    const caller = await auth.identify(this.req, credential);
    return new SessionShell(caller, this.env, this.ctx);
  }
}

// MIDDLE shell — a session. Identity baked in once (control-plane/src/api.ts today).
class SessionShell extends RpcTarget {
  constructor(
    private caller: Caller,
    private env: Env,
    private ctx: Ctx,
  ) {
    super();
  }
  whoami() {
    return { actor: this.caller.actor, email: this.caller.email };
  }
  get projects(): ProjectCollection {
    return new ProjectCollection(this.caller, this.env, this.ctx);
  }
}

class ProjectCollection extends RpcTarget {
  constructor(
    private caller: Caller,
    private env: Env,
    private ctx: Ctx,
  ) {
    super();
  }
  async list(): Promise<string[]> {
    /* directory-scoped, as api.ts */
  }
  async get(id: string): Promise<ProjectShell> {
    this.caller.assertMember(id); // the membership gate = an unforgeable handle to ONE project
    return new ProjectShell(scope(id, "/"), resolverForProject(id, this.env, this.ctx));
  }
  async create(slug: string): Promise<ProjectShell> {
    /* emerge org+project, as api.ts */
  }
}
```

Because these are `RpcTarget`s and both transports proxy them identically, promise pipelining collapses the
whole descent into **one round trip** (README §"HTTP batch client"; `RpcPromise` is a thenable that is also
a stub, `dist/index-workers.d.ts:348`):

```ts
using cp = newWebSocketRpcSession<ControlPlaneShell>("wss://cp.example/api", myCallbacks);
// ONE round trip: authenticate → get project → append to a stream.
await cp.authenticate(token).projects.get("prj_42").streams.get("/log").append({ type: "hello" });
```

---

## 3. The project shell is thin — this is where the god-object dies

`apps/os/src/rpc-targets.ts` is 7,667 LOC because `ProjectRpcTarget` is a mega-class whose every capability
is a getter (`streams`, `secrets`, `ai`, `email`, `egress`, `integrations`, `agents`, `workers`,
`sandboxes`, `files`, `kv`, `devices`, `mcp`, `openapi`, `auth`, `liveState`, `capabilityHost` — jam §0).
Adding a capability edits that class; every DO imports it.

Requirement 7 is met by making the project shell own **one thing: a `Resolver`.** Built-in branches are not
special-cased on the class — they are just providers whose terminal default lives in the config resolver,
reached by the same fallthrough as a Pi sensor feed. We keep the _exact_ prototype-Proxy mechanism we
already ship (`installPrototypeInvokeCapabilityFallback`, `domains/itx/utils.ts:338`), pointed at the
resolver instead of a DO.

```ts
// The INNER shell. NOT a bag of getters — a thin front over ONE Resolver.
class ProjectShell extends RpcTarget {
  constructor(
    readonly scope: Scope,
    private resolver: Resolver,
  ) {
    super();
  }
  get projectId() {
    return this.scope.projectId;
  }

  // Every member the class does NOT declare — streams, repos, secrets, ai,
  // auth.gate, a Pi feed — arrives here as a flattened dotted path and is
  // RESOLVED. `shell.streams.get("/x").append(e)` becomes
  // invokeCapability({ path: ["streams","get","append"], args:[...] }).
  invokeCapability({ path, args }: { path: string[]; args?: unknown[] }): Promise<unknown> {
    return this.resolver.resolve(path).invoke(path, args ?? []);
  }
}
// The prototype hop that turns unknown member access into invokeCapability
// (domains/itx/utils.ts:338). It ALSO makes `then` return undefined (utils.ts:371)
// so that `await shell` and pipelining do not treat the shell as a thenable.
installPrototypeInvokeCapabilityFallback(ProjectShell, { invokerFor: (s) => s });
```

A capability is now a **self-contained module** that satisfies a kernel interface and is _registered_, never
a method spliced onto a shared class. That is the death of the god-object: assembly, not inheritance.

---

## 4. Provision outward — the `Resolver` linked list (the spine)

The fallthrough chain is a **first-class linked list**. Each shell holds a `HostResolver` that knows (a) its
own **shadow table** and (b) the **one host it falls through to** (`next`, the outward shell). This is the
literal reading of the jam: _"each capability host knows which host it falls through to… the terminal of the
chain is what the worker shipped with."_

```ts
// A capability host IS a Resolver. resolve() never returns null — the terminal
// always answers (or throws a crisp "no provider").
interface Resolver {
  resolve(path: string[]): Provider;
}
interface Provider {
  invoke(path: string[], args: unknown[]): unknown;
}

// A shell's own host: its shadow table first, then fall OUTWARD.
class HostResolver implements Resolver {
  constructor(
    private shadows: ShadowTable,
    private next: Resolver,
  ) {}
  resolve(path: string[]): Provider {
    const hit = this.shadows.longestPrefix(path); // consults ONLY shadowed paths (req 8)
    if (hit) return hit.provider; // FULL shadowing — no guard (jam §4, locked)
    return this.next.resolve(path); // walk out
  }
}

// TERMINAL — the config defaults baked into the deployed worker. CONSTRUCTIVE:
// it COMPUTES a provider from the path and stores ZERO records.
class ConfigDefaultResolver implements Resolver {
  constructor(
    private scope: Scope,
    private env: Env,
    private ctx: Ctx,
  ) {}
  resolve(path: string[]): Provider {
    switch (path[0]) {
      case "streams":
        return new StreamRouter(this.scope, this.ctx); // path → DO name, O(1), no record
      case "repos":
        return new RepoRouter(this.scope, this.ctx);
      case "auth":
        return new ConfigAuthProvider(this.scope.config); // LOGIN_MODE
      default:
        throw new Error(
          `no provider for ${path.join(".")} — nothing shadowed it and it is not a config default`,
        );
    }
  }
}
```

The chain per topology is the same object type, only the links' _transport_ differs:

```
project shell ──► HostResolver(projectShadows, next) ─┐
                                                      ▼
control-plane  ──► HostResolver(cpShadows,     next) ─┐   next may be a same-account binding,
                                                      ▼   a capnweb stub to a BYO account, or a
iterate product ─► HostResolver(productShadows,next) ─┐   Pi's held stub — ALL the same interface.
                                                      ▼
                   ConfigDefaultResolver  (constructive; terminal; zero records)
```

Because `Resolver` is `RpcTarget`-shaped, **`next` can be a remote stub**. That single fact is what makes the
extreme self-host topology fall out for free (§7): the project on a bindings-less server has a `next` that is
a **capnweb stub of the control plane's resolver**, and `next.resolve(path)` is simply an RPC.

**Shadowing semantics (locked: full, no guards).** Resolution starts at the innermost shell and walks
outward, so the **first hit wins** and an inner shell can shadow anything an outer shell provided — exactly
the "inner shadows outer" rule the jam locks. The mount table is a **stream fold**, precisely as
`CapabilityHostProcessor` already is (mounts are events; the table is the fold — jam §0), and `provide` /
`revoke` are the existing `ProvideCapabilityInput` events (`live` | `itx-expression`,
`domains/capability-host/types.ts:46`).

---

## 5. The kernel — interfaces only; providers are pluggable

Requirement 4: the kernel is the _defines_. No Cloudflare in these files. They compile and run under
Miniflare on a Pi unchanged.

```ts
// kernel/stream.ts — DEFINE ONLY. The contract competing providers satisfy.
export interface Stream extends RpcTarget {
  append(...events: Event[]): Promise<Event[]>;
  getEvents(range?: Range): Promise<Event[]>;
  getReducedState(): Promise<unknown>;
  // subscribe takes a SINK CALLBACK — bidirectional RPC. The provider calls the
  // sink BACK over the same session (README §Functions: "pass a function over
  // RPC → the recipient receives a stub → invoking it calls back to the original
  // function"). Identical over Workers RPC and capnweb — stubs proxy across both
  // (README §"Cloudflare Workers RPC interoperability": you can send DO stubs
  // over Cap'n Web and it "just works").
  subscribe(sink: Sink): Promise<Subscription>;
}
export interface Sink extends RpcTarget {
  deliver(batch: Event[]): void;
}

// kernel/repo.ts — even a repo is "just a provider" (jam §4).
export interface Repo extends RpcTarget {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

Two implementations of the identical interface:

```ts
// reference impl — Cloudflare Durable Object. A thin RpcTarget over env.STREAM,
// exactly what StreamRpcTarget is today (rpc-targets.ts:517 — append/getEvents/
// subscribe/crossPostTo over `env.STREAM.getByName(codec.stringify(...))`).
class DurableObjectStream extends RpcTarget implements Stream {
  constructor(private stub: DurableObjectStub) {
    super();
  }
  append(...e: Event[]) {
    return this.stub.append(...e);
  }
  getEvents(r?: Range) {
    return this.stub.getEvents(r);
  }
  subscribe(sink: Sink) {
    return this.stub.subscribe(sink);
  }
  getReducedState() {
    return this.stub.getReducedState();
  }
}

// self-host impl — Miniflare on a Raspberry Pi. SAME interface. Log in Pi-local
// SQLite. No Cloudflare symbol anywhere in this file.
class MiniflareStream extends RpcTarget implements Stream {
  /* … */
}
```

`StreamRouter` (the constructive default) returns a `DurableObjectStream` computed from the path — the O(1),
record-free case (req 8). A path shadowed to a Pi returns the Pi's `MiniflareStream` stub from the shadow
table. The consumer cannot tell which it got.

---

## 6. Constructive default, store-only-overrides (requirement 8)

Today `itx.streams.get("/path")` computes a DO name and touches zero registry rows. We keep that as the
**terminal** of the fallthrough:

- **Unshadowed stream** → misses every shell's shadow table → hits `ConfigDefaultResolver` →
  `StreamRouter.invoke(["streams","get"], ["/log"])` → `new DurableObjectStream(codec.stringify({projectId,
path:"/log"}))`. **Zero records, O(1)** — identical cost to today.
- **Shadowed stream** (`/sensors` → the Pi) → one `capability-provided` event in the project host's stream
  fold → `HostResolver.resolve` short-circuits at the shadow before ever reaching the terminal.

So the registry grows with **overrides only**, never with paths merely _used_. `ShadowTable.longestPrefix`
runs over that small override set, not over the space of all addressable streams. The constructive default
is the fallthrough's terminal, so "nothing shadowed it" and "compute the default" are the same code path.

---

## 7. The extreme self-host topology (requirement 5), end to end

Project on a **separate server with no RPC bindings**; a stream provider on a **Raspberry Pi behind NAT**.
Same `Stream` interface as the same-account case.

**Step 1 — the Pi dials OUT and holds a bidirectional session.** capnweb sessions are **symmetric** — README
§"Custom transports": _"sessions are entirely symmetric: neither side is defined as the 'client' nor the
'server'. Each side can optionally expose a main interface."_ The Pi passes **its own main** (a resolver
vending `MiniflareStream`) as `localMain`, so the cloud can call **back** into the Pi. NAT is solved because
the Pi opened the socket outward.

```ts
// On the Pi (Miniflare / Node). ONE symmetric WebSocket session.
using cp = newWebSocketRpcSession<ControlPlaneShell>("wss://cp.example/api", piResolver);
const session = await cp.authenticate(PI_TOKEN);
// Provide a LIVE stream provider at /sensors on the target project.
await session.projects.get("prj_42").provide({
  path: ["streams", "get", "/sensors"],
  type: "live",
  capability: new MiniflareStream(),
});
```

**Step 2 — the control plane holds the Pi stub as a live shadow.** This is exactly today's
`retainLiveCapabilityProvider` (`domains/capability-host/live-capability.ts:25`): `deepRetainRpcStubs`
`.dup()`s the incoming stub so it survives the provide call's return, and disposes the duplicate on revoke.
The **durable fold stores a routing record** ("`/sensors` is a live mount on connection `c_pi_…`"), never the
stub itself.

**Step 3 — the project resolves through the chain over capnweb.** The project worker (bindings-less server)
holds a `HostResolver` whose `next` is a **capnweb stub of the CP resolver**.

```ts
// Inside the project, wherever userspace does itx.streams.get("/sensors"):
await projectShell.streams.get("/sensors").append({ temp: 21.4 });
// → project HostResolver: no local shadow → next.resolve(["streams","get","/sensors"])  [RPC to CP]
// → CP HostResolver: shadow HIT → returns the Pi's MiniflareStream stub
// → .append proxied CP→Pi over the Pi's held session.
```

Every hop speaks the same `Stream` interface. The project sees `Stream`; the CP sees `Stream`; the Pi
implements `Stream`. Location is a property of the _provider_, not of the capability's identity (jam §2d).
The one honest cost is a **three-party proxy** (README §`RpcStub`: a stub received from Bob and handed to
Carol is _"proxied through Alice… in the future we may support three-party handoff"_) — accepted for now.

---

## 8. Requirements scorecard

| #   | Requirement                                                                | How this design meets it                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Transport duality — one `RpcTarget`, both transports**                   | `RpcTarget` is the same class for Workers RPC and capnweb (`index-workers.d.ts:374`). ONE `Itx` entrypoint: `fetch` → `newWorkersRpcResponse` (batch+WS), `get()` → the same shell over the loopback. `fetch` reserved is a _feature_ — it's the wire, uncallable as RPC.      |
| 2   | **Nested shells navigated by RPC**                                         | `ControlPlaneShell.authenticate()` → `SessionShell` → `.projects.get(id)` → `ProjectShell` → resolved `Stream`. The **iterate product is not a navigation shell** — it is the outer link of the _provision_ list; the auth **mechanism** is a shadowable `auth` provider (§2). |
| 3   | **Capabilities = provided data/events, fallthrough chain, full shadowing** | `HostResolver` linked list; each host = a stream fold of `provide`/`revoke` events; inner-first walk → first hit wins → terminal = constructive config defaults. No guards (locked).                                                                                           |
| 4   | **Kernel = interfaces; impls pluggable**                                   | `kernel/stream.ts`, `kernel/repo.ts` are `RpcTarget` interfaces with zero Cloudflare. `DurableObjectStream` (reference) and `MiniflareStream` (Pi) satisfy the same `Stream`.                                                                                                  |
| 5   | **Extreme self-host**                                                      | Pi dials out with a **symmetric** capnweb session passing its own `localMain`; CP retains it as a live shadow; project's `Resolver.next` is a capnweb stub. §7 walks it end to end.                                                                                            |
| 6   | **Everything through one DO for now**                                      | Each shell's `HostResolver` is fronted by one capability-host DO (source of truth = mount fold + resolver), as `CapabilityHostDurableObject` is today (`capability-host-durable-object.ts:143`). KV projection explicitly deferred.                                            |
| 7   | **No `rpc-targets.ts` god-object**                                         | A shell owns **one `Resolver`**, not N getters. Capabilities are self-contained provider modules registered in the config-default resolver; adding one edits no shared class.                                                                                                  |
| 8   | **Linear-growth / constructive default**                                   | Terminal `ConfigDefaultResolver` computes stream providers from the path (O(1), zero records). A record exists **only** when a path is shadowed (§6).                                                                                                                          |

---

## 9. The 3–5 hardest problems, and how I resolve each

**H1 — `fetch` is reserved, and `Request`/`Response` don't cross the loopback cleanly.**
The loopback door cannot be `fetch` (reserved) and cannot ferry a `Request` as an RPC arg reliably (why
`config-worker.ts` passes `env.ITX.auth.gate(callerHeader, cpOrigin, url)` as **primitives**, not a Request).
_Resolution:_ split the two shapes. **Method-shaped** capability access uses the `get()` door and returns
`RpcTarget`s. **HTTP-shaped** needs (WebSocket 101 upgrades, streaming bodies) ride `fetch` and, when they
must travel _over_ RPC, use capnweb's **WebSocket tunneling**: a `Response` carrying a `webSocket` is passable
over RPC (README §"Tunneling WebSockets"; the tunneled socket can even be handed to `newWebSocketRpcSession`
to run a nested session). This is the principled version of the `env.ITX.fetch` lane in
`itx-entrypoint.ts:57` (_"RPC method calls cannot carry 101 upgrades and streaming bodies"_) — that lane
becomes `fetch`, everything else `get()`.

**H2 — the fallthrough Proxy must swallow `then` and protocol probes, or `await` hangs and pipelining
breaks.** The prototype hop makes an instance appear to have every member. If it answered `then`, `await
shell.foo` would treat the result as a thenable and try to _resolve `then` as a capability_, deadlocking; an
`RpcPromise` is itself a thenable-and-stub (`index-workers.d.ts:348`), so the ambiguity is real.
_Resolution:_ keep exactly the guard we already ship — the hop returns `undefined` for `then` and for
protocol-probe keys, and only conjures a dispatcher for genuine instances (`domains/itx/utils.ts:371-386`).
This is load-bearing and must be carried into the clean-room verbatim; it is not incidental.

**H3 — a resolution error used only for pipelining is silently swallowed (vacuous rejection).** capnweb
optimizes away results you never await: _"if you don't actually await a promise before the batch is sent, the
system detects this and doesn't ask the server to send the return value back"_ (README §HTTP batch) — and our
own memory (`capnweb_vacuous_rejects.md`) records that **rejections can pass vacuously**. If
`resolver.resolve(path)` returns a rejected promise that a caller only _pipelines_ through
(`streams.get("/x").append(e)`), a "no such provider" error can vanish. _Resolution:_ make `Resolver.resolve`
**synchronous** (it consults an in-memory shadow table + a constructive default — no I/O needed to _pick_ a
provider), so a bad path throws at call time, before any pipelining. Where a provider's own work is async and
risky, wrap it in an eagerly-settled closure per the memory note rather than leaving a bare pipelined
promise.

**H4 — a live provider's lifetime (mortal stub) vs the durable mount fold (immortal record).** The mount
table survives DO eviction and replays on the next incarnation; a live Pi stub does **not** — capnweb makes
no GC promises across a connection (README §"Resource Management": _"garbage collection does not work well
when remote resources are involved"_). Replaying a fold that embeds a dead stub would resurrect a corpse.
_Resolution:_ the durable fold stores a **routing record only** (path → holder connection id), never the stub;
the live stub lives in the holder DO's memory keyed by connection and is `.dup()`-retained /
`Symbol.dispose`-released exactly as `deepRetainRpcStubs` does today (`live-capability.ts:57`). On disconnect,
`stub.onRpcBroken(...)` (`index-workers.d.ts:38`; README §"Listening for disconnect") evicts the routing
record, and resolution falls back to the constructive default. This is the jam's "cache the routing, not the
data" (§2a) made concrete — and it is the reason the "one DO now" (req 6) is a _routing_ source of truth, not
a data one.

**H5 — cross-transport fallthrough is a three-party proxy with real interop cost.** When the project
(Workers RPC) resolves outward to the CP (capnweb) to the Pi (capnweb), a stub crosses two systems and is
proxied through the middle (README §`RpcStub`: _"any such calls will be proxied through Alice"_). Latency and
a liveness dependency on the middle hop are added. _Resolution:_ accept it for the self-host tier — it is the
price of "same interface, any location" and Kenton flags three-party **handoff** as future work that will
later collapse the hop. In the hot same-account tier, `next` is a binding, not a stub, so there is no proxy
at all; the cost is paid only where the topology genuinely spans machines.

---

## 10. What I deliberately reject

- **A separate `authenticate`-bearing entrypoint per transport / a second graph for the loopback.** The
  whole thesis is one graph. `RpcTarget` being a Workers-RPC/capnweb alias makes a second graph pure waste.
- **The god-object getters (rpc-targets.ts shape).** Rejected by requirement 7; replaced by a thin shell +
  registered provider modules. A capability is a file, not a method on a 7.6k-LOC class.
- **Making `authenticate` an outer _iterate-product_ shell you navigate into.** The product is a **provider**
  (outer link of the fallthrough list + lifecycle hooks), not a navigation target. `authenticate` is a
  control-plane concern; the _mechanism_ behind it is a shadowable `auth` provider. This is the jam §4 lean,
  committed.
- **Making `itx.streams` itself a mount.** Streams stay a **constructive built-in router** with pluggable
  _leaves_ (jam fork 3 lean). Turning the whole `streams` node into a registered mount would reintroduce the
  linear-growth problem req 8 exists to avoid.
- **The KV projection now.** One DO is the source of truth and the resolver (req 6). KV is a later read-path
  optimization, and — per H4 — only ever a projection of _routing_, never of live data.
- **Header/cookie auth over WebSocket.** Impossible cross-origin (Kenton) and it would make auth ambient
  instead of a returned, unforgeable capability. In-band `authenticate()` only.
- **Passing `Request`/`Response` across the loopback as RPC args.** They don't serialize reliably over the
  loopback; capabilities pass primitives (as `config-worker.ts` already does) and HTTP-shaped traffic uses
  `fetch` + WebSocket tunneling (H1).
- **A Workers-RPC-only design** (breaks cross-account and the Pi) **and a capnweb-only design** (wastes the
  same-account loopback's zero-serialization path). The duality is the requirement, not a convenience.

---

_Sources: Cap'n Web launch post ([blog.cloudflare.com/capnweb-javascript-rpc-library](https://blog.cloudflare.com/capnweb-javascript-rpc-library/));
`@iterate-com/capnweb@0.10.0` `README.md` + `dist/index-workers.d.ts`; `apps/os/src/worker.ts`,
`rpc-targets.ts`, `domains/itx/itx-entrypoint.ts`, `domains/itx/utils.ts`, `domains/capability-host/*`;
`apps/control-plane/src/{index,app,api}.ts`; `apps/project-worker/src/{index,config-worker}.ts`;
`docs/simplification/wayfinder/jam-capability-provision.md` + `control-plane-and-product.md`._
