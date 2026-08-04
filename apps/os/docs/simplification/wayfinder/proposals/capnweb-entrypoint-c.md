# Proposal C — one resolution mechanism, all the way down

_Designer C. Committed, non-hedged. Grounded in the capnweb 0.10.0 source, today's
`apps/os` capability host, and the clean-room control-plane / project-worker._

## Thesis

There is no "RPC surface" to design and there is no second mechanism anywhere. There is
**one interface** — a capnweb `RpcTarget` — and the whole platform is `RpcTarget`s that
**resolve** child `RpcTarget`s. `projects.get(id)` (navigate a shell), `streams.get(path)`
(a built-in capability), and `slack.chat.postMessage(...)` (a mounted live cap) are the
**same act**: resolve a path to a provider and call it. Resolution is a single fallthrough —
**local mounts → the recorded fallback host (dialed by name, over whatever transport its
location implies) → the constructive config default baked into the worker** — and the
"iterate product," "control-plane capabilities," "the auth mechanism," and "a Raspberry-Pi
stream" are all just **mounts at different points on that one chain**. The entrypoint is a
~20-line transport shim: exactly one reserved `fetch` (HTTP door: terminates capnweb _and_
tunnels upgrades/streaming) and exactly one RPC method `get()` (the loopback door). Both hand
to the **same** shell factory, so one `RpcTarget` implementation is reachable over Workers
RPC _and_ over capnweb with **zero adapter code** — because on workerd capnweb's `RpcTarget`
_is_ `cloudflare:workers`' `RpcTarget` (`dist/index-workers.d.ts:371-373`: _"on Cloudflare
Workers, this `RpcTarget` is an alias for the one exported from the `cloudflare:workers`
module, so they can be used interchangeably"_). The kernel is the `.d.ts` files and nothing
else.

---

## The one mechanism

```
        ┌── caller enters the chain at some node ──┐
        │                                          │
 capnweb /api  ──► UnauthenticatedRoot.authenticate(creds)
   (WS / batch)         └► ControlPlaneShell.projects.get(id)
                                └► ProjectShell  ◄── env.ITX.get()  (loopback: enter here, pre-authed)
                                        │
                                        ▼
                            resolve(path)  ── ONE function ──────────────────────────┐
                                        │                                             │
      1. LOCAL MOUNT?  (capability-host DO fold; a record exists ONLY for a shadow)   │
                        └─ live stub (Pi/BYO, dialed-in)  or  itx-expression  ────────┤ hit → invoke
                                        │ miss                                        │
      2. FALLBACK HOST  (a durable NAME, resolved fresh — never captured authority):  │
            project ──► control-plane ──► iterate product ──► …  (dial by location:   │
                        loopback RPC same-account, capnweb WS cross-account/Pi)  ──────┤ hit → invoke
                                        │ miss everywhere                             │
      3. CONFIG DEFAULT baked into the worker (CONSTRUCTIVE, zero records):           │
            streams → compute a DO name from the path; repos → same; else miss  ──────┘ terminal
```

**Diff from today.** This is what `apps/os` already _does_ — `installPrototypeInvokeCapabilityFallback`
(`domains/itx/utils.ts:338`) inserts a proxied prototype hop so built-ins win in-isolate and
misses fall through to `capabilityHost.invokeCapability`; the mount table is a stream fold
(`CapabilityHostProcessor`); `capabilityFallbackForScope` (`capability-host-processor-contract.ts:407`)
records a one-hop fallback to the project root. **Three concrete changes:** (1) delete the
7,667-LOC `ProjectRpcTarget` god-object (`rpc-targets.ts:5238`) — its 18 getters become
imported one-liners; (2) extend the fallback expression so it can name a host in _another
shell / another account / a Pi_, not just the project root, and dial it over the transport
its location implies; (3) make the terminal default **constructive** for `streams`/`repos`
so unshadowed paths keep costing zero records.

---

## TypeScript sketches

### 1. The entrypoint — one `fetch`, one `get()`, two doors, zero adapters

```ts
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb"; // WS + HTTP-batch in ONE call

/** Scope authority handed into a project/agent isolate's ITX binding. The props ARE the
 *  capability — a loopback caller is pre-authenticated by holding this binding. */
type ScopeProps = { projectId: string; path: string /* "/" or "/agents/x" */ };

/**
 * The loopback door: `env.ITX.get()` inside a confined worker.
 * `get()` is a plain (non-reserved) RPC method → returns the SAME shell type capnweb serves.
 * `fetch` is the runtime's reserved HTTP handler → used only for HTTP that RPC cannot carry.
 * The two never collide: `get` is a method, `fetch` is a handler.
 */
export class ItxEntrypoint extends WorkerEntrypoint<Env, ScopeProps> {
  /** Enter the chain PRE-AUTHENTICATED at the project shell — props are the authority. */
  get(): ProjectShell {
    return projectShell(this.env, this.ctx, this.ctx.props);
  }
  /** HTTP that RPC methods can't tunnel: 101 upgrades + streaming bodies. Dispatched by the
   *  `x-iterate-worker-dispatch` header, exactly like today's ItxEntrypoint.fetch. */
  override async fetch(request: Request): Promise<Response> {
    return httpTunnel(this.env, this.ctx, request);
  }
}

/**
 * The public door: the control plane's `/api`. capnweb terminates here; the SAME shell
 * factory feeds it. `newWorkersRpcResponse` serves BOTH WebSocket and HTTP-batch from one
 * call and is deliberately cross-origin (`dist/index-workers.d.ts:406-417` SECURITY WARNING),
 * which is SAFE precisely because our root uses in-band authorization: `authenticate(creds)`
 * is the only method and it returns the authority.
 */
export class ControlPlaneEntrypoint extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api")
      return newWorkersRpcResponse(request, new UnauthenticatedRoot(this.env, request));
    return httpIngress(this.env, this.ctx, request); // host→projectId dial + tunneling
  }
}
```

The single fact that makes this zero-adapter: the object passed as capnweb's `localMain`
and the object returned by `get()` are **instances of the same classes**. capnweb's
`RpcTarget` and `cloudflare:workers`' `RpcTarget` are the _same constructor_ on workerd, so a
`ProjectShell` is simultaneously a valid capnweb main and a valid Workers-RPC return. No
bridge, no wrapper, no `toCapnweb()`.

The loopback authority rides `ctx.exports`: a project isolate reaches its host via
`ctx.exports.ItxEntrypoint({ props: { projectId, path } })` — the caller _"can specify the
value of `ctx.props` that should be delivered to the callee"_, and `ctx.props` _"can only be
set by someone who has permission to edit and deploy the worker"_ ([Cloudflare `ctx.exports`
docs](https://developers.cloudflare.com/workers/runtime-apis/context/)). So holding the ITX
binding with a given `props` **is** the capability — no token, no in-band auth on the loopback,
which is exactly why capnweb's `authenticate()` splice point is skipped there.

### 2. The shells — a chain of thin `RpcTarget`s (assembled, not a god-object)

This is Kenton's canonical object-capability pattern, verbatim: _"It is impossible for the
client to 'forge' a session object. The only way to get one is to call `authenticate()`, and
have it return successfully"_ ([Cap'n Web announcement](https://blog.cloudflare.com/capnweb-javascript-rpc-library/)).
A capability _"designate[s] an object to call and confer[s] permission to call it"_ — so each
shell a method hands back is authority you could not otherwise reach. Delegation is just
passing the reference on; attenuation is the shell exposing only a subset (private `#` fields
never cross — [Workers RPC visibility](https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/)).

```ts
/** `/api` before any authority is known. Cap'n Web's blessed pattern: authority is never
 *  forged, only handed back by a method that already checked you. */
class UnauthenticatedRoot extends RpcTarget {
  constructor(
    private env: Env,
    private request: Request,
  ) {
    super();
  }
  /** The ONLY door. The auth *mechanism* is itself a resolved capability (see §4): config
   *  default = the deployment's LOGIN_MODE; the iterate product may shadow it with OAuth. */
  async authenticate(credentials: Credentials): Promise<ControlPlaneShell> {
    const auth = resolveProvider<AuthProvider>(this.env, ["auth"]);
    // Closure-wrapped: a vacuously-rejecting verify must be AWAITED here or its failure is
    // silently dropped (see Hard Problem 3).
    const principal = await (async () => auth.resolve(credentials, this.request))();
    return new ControlPlaneShell(this.env, principal);
  }
}

/** MIDDLE shell: manage projects. Nothing else — cross-project authority stops here. */
class ControlPlaneShell extends RpcTarget {
  constructor(
    private env: Env,
    private principal: Principal,
  ) {
    super();
  }
  get projects(): ProjectCollection {
    return new ProjectCollection(this.env, this.principal);
  }
}

class ProjectCollection extends RpcTarget {
  constructor(
    private env: Env,
    private principal: Principal,
  ) {
    super();
  }
  /** Membership gate → INNER shell. Returns a REAL instance (pipelinable — Hard Problem 1). */
  async get(id: string): Promise<ProjectShell> {
    await assertMember(this.env, this.principal, id);
    return projectShell(this.env, /* ctx */ undefined, { projectId: id, path: "/" });
  }
}
```

Same classes, two splice points: capnweb clients enter at `UnauthenticatedRoot`; the loopback
binding enters at `ProjectShell`. **A shell never knows which transport it arrived on.**

### 3. `ProjectShell` — de-godded: a handful of one-line built-ins + the fallthrough hop

```ts
/**
 * The itx tree. Built-ins are ONE-LINE delegations to self-contained provider factories in
 * their own modules (kernel/streams/provider.ts, …) — NOT 7,667 lines of getters on one
 * class. Everything else falls through the prototype hop to `invokeCapability`.
 *
 * WHY the handful of real getters (not "everything is a mount"): workerd classifies an RPC
 * result for promise pipelining with a NATIVE brand check a JS Proxy can never pass
 * (`serializeJsValueWithPipeline`, cloudflare/workerd#6873). A built-in returned from a getter
 * must be a REAL branded RpcTarget or `itx.streams.get(p).append(e)` dies mid-pipeline. The
 * getters resolve BEFORE the hop; only misses hit the proxy. This is exactly today's
 * `installPrototypeInvokeCapabilityFallback` trade-off, kept on purpose.
 */
class ProjectShell extends RpcTarget {
  #scope: Scope; // { env, ctx, projectId, path }
  constructor(scope: Scope) {
    super();
    this.#scope = scope;
  }

  get streams(): Stream.Collection {
    return streams(this.#scope);
  } // constructive default
  get repos(): Repo.Collection {
    return repos(this.#scope);
  } // constructive default
  get secrets(): Secret.Store {
    return secrets(this.#scope);
  }

  /** The fallthrough sink the prototype hop dispatches misses to. */
  invokeCapability(call: { path: string[]; args: unknown[] }): Promise<unknown> {
    return capabilityHostFor(this.#scope).invokeCapability(call);
  }
}
// Called ONCE (today's registry block). Built-ins win in-isolate; unknown roots become
// dynamic capability path-proxies terminating in a single pipelinable invokeCapability call.
installPrototypeInvokeCapabilityFallback(ProjectShell, {
  invokerFor: (shell) => shell,
});

function projectShell(env: Env, ctx: unknown, props: ScopeProps): ProjectShell {
  return new ProjectShell({ env, ctx, projectId: props.projectId, path: props.path });
}
```

### 4. The capability-host DO — the ONE stateful resolver, and the fallthrough

```ts
/** The single source of truth AND resolver (requirement 6: everything through one DO now;
 *  the KV projection is a LATER optimization). The mount table is a stream fold; a RECORD
 *  exists ONLY when a path is shadowed. */
export class CapabilityHost extends DurableObject<Env> {
  async invokeCapability(call: { path: string[]; args: unknown[] }): Promise<unknown> {
    // 1. LOCAL MOUNT — longest-prefix match in the fold. Live stub or itx-expression.
    const mount = this.#resolveLocalMount(call.path);
    if (mount) return this.#invokeMount(mount, call);

    // 2. FALLBACK HOST — a DIALABLE NAME, resolved fresh, never captured authority
    //    (contract §fallback: "resolved fresh on every fallback read … a durable name,
    //    never captured authority"). Dial by location: loopback RPC or capnweb WS.
    if (this.#fallback) return this.#dial(this.#fallback).invokeCapability(call);

    // 3. TERMINAL: the config default baked into the deployed worker (CONSTRUCTIVE).
    return configDefault(this.env, this.#scope, call);
  }

  /** Shadow a path. Appends ONE mount event; full shadowing allowed (guards deferred). */
  async provideCapability(input: ProvideCapabilityInput): Promise<{ providedAtOffset: number }> {
    return this.#appendMount(input);
  }

  /** The Pi/BYO path: a live provider dials in and hands us a stub; we hold it as a mount.
   *  onRpcBroken tears the mount down so later reads fall through (Hard Problem 4). */
  async provideLive(path: string[], provider: RpcStub<unknown>): Promise<void> {
    provider.onRpcBroken(() => this.#revokeMount(path));
    await this.#appendMount({ type: "live", path, capability: provider.dup() });
  }
}
```

### 5. The constructive default — requirement 8, unshadowed streams cost zero records

```ts
/** The terminal of the fallthrough. `streams`/`repos` are COMPUTED from the path — O(1),
 *  zero registry rows. A mount row is written ONLY to shadow a path onto a non-default
 *  provider (a Pi). Same shape as ingress: default host convention + a routes table of
 *  overrides. Everything else is a real miss. */
function configDefault(env: Env, scope: Scope, call: { path: string[]; args: unknown[] }) {
  const [root, ...rest] = call.path;
  if (root === "streams") {
    // Constructive: path → DO name. No record consulted, none created.
    const name = DurableObjectNameCodec.stringify({
      projectId: scope.projectId,
      path: "/" + rest.slice(0, streamPathLen(rest)).join("/"),
    });
    const stream = env.STREAM.getByName(name); // a DO stub === an RpcStub<Stream>
    return replayPath(stream, rest.slice(streamPathLen(rest)), call.args);
  }
  if (root === "repos") {
    /* identical: compute a Repo DO name, replay the remainder */
  }
  throw new Error(`no capability at "${call.path.join(".")}"`);
}
```

### 6. Kernel = interfaces; two impls satisfy the SAME `Stream` — CF DO vs Pi Miniflare

```ts
// kernel/stream.d.ts — THE KERNEL. Types only. No implementation ships here.
/** An append-only event log. The contract competing providers satisfy. */
export interface Stream extends RpcTarget {
  append(events: StreamEvent[]): Promise<{ offset: number }>;
  subscribe(sink: StreamSink): Promise<Subscription>; // PUSH (minimal tier)
  getEvents(range: { from: number; to?: number }): Promise<StreamEvent[]>; // PULL (full tier)
  getReducedState(): Promise<unknown>; // catch-up (full tier)
}
/** Where a stream pushes batches. A plain RpcTarget → passable by reference over both transports. */
export interface StreamSink extends RpcTarget {
  deliver(events: StreamEvent[]): Promise<void>;
}
```

```ts
// REFERENCE IMPL (cloud): a Durable Object. Kernel-blind — it just implements the interface.
export class CloudflareStream extends DurableObject<Env> implements Stream {
  async append(events: StreamEvent[]) {
    /* DO SQLite log */
  }
  async subscribe(sink: StreamSink) {
    /* register; push on append */
  }
  async getEvents(range) {
    /* range read */
  }
  async getReducedState() {
    /* fold */
  }
}
```

```ts
// SAME INTERFACE on a Raspberry Pi (Miniflare), dialing OUT through NAT — requirement 5.
class PiStream extends RpcTarget implements Stream {
  // capnweb RpcTarget, off-Cloudflare
  async append(events) {
    /* local sqlite on the Pi */
  }
  async subscribe(sink) {
    /* push over the SAME socket the Pi dialed out on */
  }
  async getEvents(range) {
    /* … */
  }
  async getReducedState() {
    /* … */
  }
}
// The Pi holds ONE persistent bidirectional session. It is the CLIENT (dials out); the cloud
// is the CALLER (calls append/subscribe on the stub). capnweb is peer-to-peer: either side
// calls the other over one connection.
const cp = newWebSocketRpcSession<ControlPlaneShell>("wss://cp.iterate.com/api", new PiStream());
const project = await cp.authenticate(piSecret).projects.get(projectId); // pipelined, one round trip
await project.streams.get("/home-assistant").provideLive(new PiStream()); // mount the live cap
```

The cloud-side resolver at `streams.get("/home-assistant")` now holds an `RpcStub<Stream>`
that happens to terminate on the Pi. It is structurally identical to the DO stub the
constructive default would have produced. **Location is a property of the provider, never of
the capability's identity.** When the socket dies the stub breaks; `onRpcBroken` revokes the
mount; reads fall through to the constructive default (or a "provider offline" miss).

---

## How each requirement is met

| #   | Requirement                                                 | How this design meets it                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Transport duality, one `RpcTarget`**                      | `RpcTarget` is the same constructor for capnweb and Workers RPC on workerd (`index-workers.d.ts:371`). One `WorkerEntrypoint`; `override fetch` terminates capnweb via `newWorkersRpcResponse` (WS+batch, `:406-417`) _and_ tunnels HTTP; the non-reserved `get()` serves the loopback. Both hand to `projectShell(...)`. Zero adapters.                                                                        |
| 2   | **Nested shells + outer shell? + pluggable auth**           | `authenticate()` → `ControlPlaneShell` → `projects.get(id)` → `ProjectShell`, same classes over both transports. **Committed answer: there is NO outer iterate shell** — the iterate product is a _mount_ at the top of the fallthrough chain (§4), and `authenticate` resolves its auth mechanism as a capability (config default = `LOGIN_MODE`; iterate shadows with OAuth). One mechanism, not a new layer. |
| 3   | **Provided data/events, fallthrough chain, full shadowing** | Mounts are events in the capability-host stream fold. `invokeCapability` walks local mount → recorded fallback host → config default. Each host knows its fallback (a dialable name). Full shadowing allowed; guards explicitly deferred.                                                                                                                                                                       |
| 4   | **Kernel = interfaces, impls pluggable**                    | `kernel/*.d.ts` ship types only (`Stream`, `StreamSink`, `Repo`). `CloudflareStream extends DurableObject implements Stream` is the reference impl; `PiStream extends RpcTarget implements Stream` runs in Miniflare. Repo is "just a provider" the identical way.                                                                                                                                              |
| 5   | **Extreme self-host / Pi dials out**                        | Project on a bare server = a capnweb client of `/api` (`newWebSocketRpcSession` → `authenticate` → `projects.get`). Pi = a capnweb client holding a bidirectional session, mounted via `provideLive`. Same `interface Stream` as the same-account DO stub.                                                                                                                                                      |
| 6   | **One DO for now**                                          | The `CapabilityHost` DO is both source of truth (the fold) and resolver (`invokeCapability`). KV projection named explicitly as LATER.                                                                                                                                                                                                                                                                          |
| 7   | **No `rpc-targets.ts` god-object**                          | `ProjectShell` is ~40 lines: three one-line built-in getters delegating to per-capability modules, plus the fallthrough hop. Providers are self-contained pieces assembled onto the shell, not getters on a 7,667-LOC mega-class.                                                                                                                                                                               |
| 8   | **Linear-growth of capabilities**                           | Terminal default is **constructive**: `streams`/`repos` compute a DO name from the path (O(1), zero records). A mount row is written ONLY to shadow a path onto a non-default provider. Unshadowed streams stay record-free — same as ingress's default-convention-plus-overrides.                                                                                                                              |

---

## The 3–5 hardest problems

**1. The pipelining brand check kills any instance-wrapping Proxy.** workerd classifies an RPC
call's result for promise pipelining with a native brand check (`serializeJsValueWithPipeline`,
cloudflare/workerd#6873, documented in `domains/itx/utils.ts:290-298`). A JS `Proxy` fails it
and falls to `NonPipelinable`, so `itx.streams.get(p).append(e)` would die with _"the RPC
receiver does not implement the method."_ **Resolution:** never wrap the shell instance in a
Proxy. Built-ins are real branded getters that return real instances (pipelinable); the only
Proxy is a _prototype hop_ inserted between `ProjectShell.prototype` and its parent, trapping
**misses only**, and what it returns for a miss is a function-backed path proxy that terminates
in a **single** `invokeCapability(...)` apply — one call, which _is_ pipelinable. Note this is a
Workers-RPC constraint, not a capnweb one (capnweb's own `RpcStub`/`RpcPromise` are proxies and
pipeline fine per `index-workers.d.ts:330-348`); since one object serves both transports we
satisfy the stricter runtime.

**2. `fetch` is reserved and `Request`/`Response` aren't RPC-passable.** Cloudflare's
[reserved-methods rule](https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/)
is exact: on a `WorkerEntrypoint`, `fetch` _"is treated specially — it can only be used to
handle an HTTP request"_ (Fetch API semantics, **not** RPC), `connect` is reserved for socket
connections, and the runtime handler names (`alarm`, `webSocketMessage`, `webSocketClose`,
`webSocketError`) are disallowed as RPC methods on `WorkerEntrypoint`/`DurableObject` — _"a
101 Upgrade / `Response` with a `webSocket` can only travel through `env.SERVICE.fetch(request)`,
never a plain RPC method."_ `Request`/`Response` also don't survive the loopback reliably (the
clean-room `ProjectAuth.gate` passes **primitives**, not a `Request` — `project-worker/src/index.ts:93-119`).
**Resolution:** two lanes on one entrypoint. The RPC surface never names `fetch` and never
passes HTTP objects — capabilities exchange plain data + stubs. Anything HTTP-shaped (101
upgrades, streaming bodies) rides the reserved `fetch` handler with a dispatch header
(`env.ITX.fetch(req)` is a _real_ fetch hop). `get()` and `fetch` coexist because one is an
RPC method and one is a runtime handler — and, usefully, those handler names _are_ allowed on a
plain `RpcTarget` (which has no runtime handlers), so a capability may legitimately expose e.g.
a `subscribe` sink without colliding with anything reserved.

**3. Vacuous rejections pass silently.** capnweb's transport contract states that if a session
errors but _"there are no outstanding calls (and none are made in the future), then the error
does not propagate anywhere — this is considered a 'clean' shutdown"_ (`index-workers.d.ts:186-189`).
So a mounted itx-expression or a live-provider call that rejects can vanish if nothing awaits
it inside the RPC call. **Resolution:** every risky evaluation in the resolver (`authenticate`'s
verify, `#invokeMount`, `#dial`) is wrapped in a closure that is **awaited within the same RPC
invocation**, so the failure surfaces as a real rejection to the caller. Observability rides
`RpcSessionOptions.onCall` (`RpcCallHandler`, `:242-271`), whose contract requires `invoke()` be
called synchronously and its promise returned to _"span the full asynchronous call … propagated
through promise pipelining"_ — the same hook the clean-room already threads (`worker.ts:274-286`).

**4. Live-mount stub lifetime (the Pi).** This works at all only because capnweb is
**symmetric** — _"there is no well-defined 'client' or 'server' at the protocol level … two
parties exchanging messages"_ ([Cap'n Web blog](https://blog.cloudflare.com/capnweb-javascript-rpc-library/))
— so the Pi _dials out_ (client) yet the cloud _calls_ `append`/`subscribe` back on the stub it
provided. But a live capability is an `RpcStub` that dies with its session, and disposal is
explicit **because distributed GC is impossible** — _"the garbage collector … has no ability to
trace through the remote graph"_ (capnweb README). The primitives: `StubBase extends Disposable`
with `dup()` and `onRpcBroken(cb)` (`index-workers.d.ts:35-40`); ownership of a stub _transfers_
to the recipient on pass, so you must `dup()` to keep it. If the resolver handed the raw dial-in
stub to a browser that outlived the Pi's socket, every later call would throw. **Resolution:**
the raw stub crosses exactly one boundary — into the `CapabilityHost` DO, which `dup()`s it (own
lifetime, independent of the dialing session) and registers `onRpcBroken` to revoke the mount.
Cross-boundary callers never receive the session stub; they get a fresh path-proxy that
dispatches through `invokeCapability` → DO → held stub. One indirection point owns the lifetime;
on break, reads fall through. `RpcSession.drain()` / `getStats()` (`:355-362`) give the DO a
clean teardown and an import/export leak check.

**5. The fallthrough crosses transports and accounts.** A project's fallback host may be the
local control plane (loopback RPC), a control plane in another Cloudflare account, or an
off-Cloudflare provider — different transports on one logical chain. **Resolution:** each host
stores its fallback as a **dialable name** resolved fresh per read (contract §fallback: _"a
durable name, never captured authority"_), and the resolver dials it over the transport the
name's location implies — `ctx.exports`/service-binding for same-account, `newWebSocketRpcSession`
for cross-account/Pi. Because an `RpcPromise` is **lazy** — _"the actual final result is not
requested from the server until you actually await … if you only intend to use the promise for
pipelining and never await it, there's no need to transmit the resolution"_ (`:340-347`) — a
cross-transport fallthrough like `session.projects.get(id).streams.get(p).append(e)` collapses
into **one** round trip. The chain is uniform; the transport is a property of location.

---

## What I deliberately reject

- **The 18-getter `ProjectRpcTarget` mega-class** (`rpc-targets.ts:5238`, 7,667 LOC). Rejected
  by requirement 7. Getters with bodies become imported one-line provider factories; the shell
  is a thin assembly manifest.
- **A capnweb↔Workers-RPC adapter/bridge layer.** Rejected as dead code: on workerd the two
  `RpcTarget`s are the _same constructor_ (`index-workers.d.ts:371`). Any "adapter" would be an
  identity function. The whole duality is "pass the same instance to two entrypoints."
- **A distinct "outer iterate product shell."** Rejected — it would be a second mechanism. The
  iterate product is a **mount** near the top of the fallthrough chain (`onProjectCreated`,
  `flavorPrompt`, first-party secrets), reached by the control plane through the _same_
  `invokeCapability` fallthrough. Self-host = don't mount it. Confirms jam §1's "outer layer,
  not config-parameterized," implemented as data, not a class hierarchy. This is Kenton's
  "bindings marketplace" taken literally — _"the binding only sees exactly what you explicitly
  pass to it"_ ([Workers RPC](https://blog.cloudflare.com/javascript-native-rpc/)) — the iterate
  product is one such binding, holding no ambient authority the fallthrough didn't hand it.
- **The KV projection / stateless-first read path, now.** Rejected by requirement 6 as premature.
  One DO is the resolver; KV is a later optimization that caches _routing_, never _data_ (jam §2a).
- **Making every stream a mount record.** Rejected by requirement 8. Constructive default; store
  a record only to shadow. Registry size tracks _overrides_, not _paths ever used_.
- **Guards on shadowing.** Rejected for now (jam §4 "full shadowing, on purpose"). Any shell may
  shadow any capability a prior shell provided; the risk work is explicitly parked.
- **Passing `Request`/`Response` across the RPC surface.** Rejected — primitives + stubs on the
  RPC lane; HTTP objects only on the reserved `fetch` handler.
- **Coining new framework nouns.** Rejected on principle. Everything here reuses the existing
  vocabulary — WorkerEntrypoint, RpcTarget, shell, capability host, mount, fallback, resolver,
  itx, provider, kernel. The design is a _convention_ (rhyming provider functions + one
  fallthrough), not a spec-object framework.

```

```
