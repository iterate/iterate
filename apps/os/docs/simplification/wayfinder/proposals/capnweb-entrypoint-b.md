# Proposal B — One object type: the **Shell**. Transport is a _mount_; provision is a _fallthrough stub_.

_Designer B. Committed, single-design. Grounded in `@iterate-com/capnweb@0.10.0` source, Cloudflare
Workers RPC docs, Kenton Varda's writing, and the clean-room `apps/control-plane` + `apps/project-worker`._

## Thesis

There is exactly **one kind of capability object in the whole platform: a `Shell` — a class that
`extends RpcTarget`.** Product, control plane, project, and every kernel provider (a stream, a repo) are
all Shells. **Transport is never a property of a Shell.** The same `Shell` instance is handed to a
same-account caller as a Workers-RPC stub (returned from a `WorkerEntrypoint` method) _and_ to a
cross-machine caller as a capnweb stub (passed as `localMain` to `newWorkersRpcResponse`) — this works
because, on Workers, **`capnweb`'s `RpcTarget` is literally an alias of `cloudflare:workers`'s
`RpcTarget`** (capnweb `index.d.ts:371-372`; Kenton confirms you can "take a Workers-native stub … and
just pass it over Cap'n Web … Proxying is arranged automatically"). Navigation between the nested shells
(`authenticate() → session → projects.get(id) → the itx tree`) is just Shells returning Shells — the
unforgeable-reference pattern Kenton calls out: _"It is impossible for the client to 'forge' a session
object. The only way to get one is to call `authenticate()`."_ And **capability provision is one field:
every Shell holds a `fallthrough: RpcStub<Shell> | null`.** A local miss is dispatched to that stub. The
stub is transport-agnostic (a Workers-RPC service binding, or a capnweb session's `getRemoteMain()`, or a
Raspberry Pi's dial-out `localMain`), so _"the control plane provides capabilities to the project"_ reduces
to _"the project's fallthrough stub points at the control-plane Shell,"_ and the terminal (`fallthrough ===
null`) answers from the config baked into the deployed worker. Kill the 7,667-LOC god-object by assembling
the Shell's built-in branches from many small modules onto one prototype, and keep unshadowed streams
record-free by making the kernel branches **constructive** and short-circuiting the fallthrough entirely.

---

## 0. The two linchpin facts everything hangs on

1. **`RpcTarget` is one class across both transports.** capnweb's `RpcTarget` docstring: _"on Cloudflare
   Workers, this `RpcTarget` is an alias for the one exported from the `cloudflare:workers` module, so they
   can be used interchangeably"_ (`index.d.ts:371-372`). So a single `class ProjectShell extends RpcTarget`
   is simultaneously (a) a legal return value of a `WorkerEntrypoint` method → the caller gets a Workers-RPC
   `RpcStub`, and (b) a legal `localMain` for `newWorkersRpcResponse(request, shell)` → the caller gets a
   capnweb `RpcStub`. **No adapter, no second implementation.** This is the entire answer to requirement 1.

2. **Stubs cross the two RPC systems transparently, and pipelining collapses dotted chains to one round
   trip on _both_.** capnweb README §"Cloudflare Workers RPC interoperability" (lines 408-423): _"RPC stubs
   and promises originating from one RPC system can be passed over the other. This will automatically set up
   proxying. You can also send Workers Service Bindings and Durable Object stubs over Cap'n Web … So
   basically, it 'just works.'"_ Native Workers RPC pipelines too (_"Calling any method name on the promise
   forms a speculative call on the promise's eventual result … promise pipelining"_). Cap'n Proto's framing:
   the nested access that _"takes four round trips"_ traditionally _"[takes] only one … with Cap'n Proto!"_
   ⇒ a `fallthrough` stub can be a Workers-RPC stub in one deployment and a capnweb stub in another, and
   `project.egress.fetch(url)` is one hop either way.

Everything below is built only from these two facts plus the proven clean-room shape.

---

## 1. The `Port` — one `WorkerEntrypoint`, one `fetch`, both transports (requirement 1)

`fetch`, `connect`, `dup`, `constructor`, `alarm`, `webSocketMessage/Close/Error` are **reserved** over
Workers RPC (`developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/`): `fetch` is silently
bound as the HTTP handler and is _not_ callable as `env.X.fetch()`. We lean into that: **`fetch` is the
transport multiplexer**, and the same-account RPC entry is a differently-named method, `enter()`.

```ts
// kernel/port.ts — the ONLY worker-runtime glue. Each worker exports its own subclass.
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb"; // its RpcTarget === the line above's (fact #1)

export abstract class Port<Env, Props> extends WorkerEntrypoint<Env, Props> {
  /** Build the UNAUTHENTICATED outer shell for a capnweb caller (the /api door). */
  protected abstract entryShell(request: Request): EntryShell;
  /** Build the shell a SAME-ACCOUNT caller wants for a minted scope. */
  protected abstract scopedShell(scope: Props): Shell;
  /** Non-RPC HTTP the worker also serves (project app, console pages, /mcp). */
  protected abstract serveHttp(request: Request): Promise<Response>;

  // ── Transport A: capnweb over WS or HTTP-batch. `fetch` is RESERVED for HTTP —
  //    perfect, because that is exactly the door capnweb speaks through. ONE call
  //    handles both WS upgrade and POST batch and returns a Response.
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/api") {
      // newWorkersRpcResponse auto-selects WebSocket vs HTTP-batch from the request
      // (index-workers.d.ts:417). The SAME EntryShell instance is the capnweb localMain.
      return newWorkersRpcResponse(request, this.entryShell(request), sessionOptions());
    }
    return this.serveHttp(request);
  }

  // ── Transport B: same-account Workers RPC. `env.ITX.enter(scope)` from a confined
  //    config worker, or `ctx.exports.<Port>.enter(scope)` as a loopback. Returns the
  //    SAME Shell class fetch() would hand to capnweb → one implementation, two doors.
  enter(scope: Props): Shell {
    return this.scopedShell(scope);
  }
}
```

- Same-account loopback is the **proven** shape: the clean-room project worker mints `env.ITX` via
  `ctx.exports.ProjectEntrypoint({ props })` and the sandbox calls methods on it
  (`apps/project-worker/src/index.ts:70-76, 139-147`). `ctx.exports` lets the caller stamp `ctx.props` —
  the scope — which is exactly how `enter(scope)` is authorized (docs:
  `changelog/2025-09-26-ctx-exports`; today gated by `enable_ctx_exports`).
- Cross-account/cross-machine is the **proven** capnweb door: `newWorkersRpcResponse` /
  `newWorkersWebSocketRpcResponse` already front `/api` in `apps/os/src/worker.ts:284-286` and the
  clean-room CP in `apps/control-plane/src/app.ts:255`.
- **We never expose a Workers-RPC method named `fetch`/`connect`.** Note capnweb itself is _fine_ with an
  `RpcTarget` method called `fetch` (its WebSocket-tunnel `Gateway` does exactly that, README 340-406) —
  but a shell reachable over _both_ transports must obey the stricter side. So HTTP-shaped capabilities pass
  **primitives**, not `Request`/`Response` (see §6, H2), mirroring the clean-room `ProjectAuth.gate(...)`
  which returns `{ authorized, loginUrl }` precisely because _"over Workers RPC, `fetch` is a reserved
  method name and Request/Response are not reliably serializable across the loopback"_
  (`apps/project-worker/src/index.ts:93-119`).

---

## 2. The nested shells — Shells returning Shells (requirement 2)

Navigation is unchanged from what `apps/os` and the clean room already do; we only rename it "shells."

```ts
// The capnweb door hands out an EntryShell. authenticate() is the ONLY method — you
// cannot forge a Session; you can only be handed one (Kenton, Cap'n Web launch post).
export class EntryShell extends RpcTarget {
  constructor(
    private req: Request,
    private deps: CpDeps,
  ) {
    super();
  }
  async authenticate(creds: Credentials): Promise<SessionShell> {
    // The auth MECHANISM is itself a provided, shadowable capability (§4, fork 6):
    // resolve it through the CP shell's OWN fallthrough, so iterate ships OAuth/Access,
    // a self-hoster ships `open`, without the kernel knowing any of them.
    const actor = await this.deps.authMechanism.verify(creds, this.req);
    return new SessionShell(actor, this.deps);
  }
}

// MIDDLE shell = the control plane. Manage projects; each projects.get() vends an itx.
export class SessionShell extends RpcTarget {
  constructor(
    private actor: Actor,
    private deps: CpDeps,
  ) {
    super();
  }
  whoami() {
    return { actor: this.actor.id, email: this.actor.email };
  }
  get projects(): ProjectCollection {
    return new ProjectCollection(this.actor, this.deps);
  }
}

export class ProjectCollection extends RpcTarget {
  constructor(
    private actor: Actor,
    private deps: CpDeps,
  ) {
    super();
  }
  async get(id: string): Promise<ProjectShell> {
    // membership gate
    await this.deps.directory.assertMember(this.actor, id);
    // The INNER shell. Its fallthrough stub points back OUT at the caller's CP shell —
    // that is how the project consumes CP capabilities (auth.gate, egress, directory).
    return buildProjectShell({ projectId: id, fallthrough: this.deps.cpFallthrough(id) });
  }
}
```

Three shells, matching the existing `UnauthenticatedOsRpcTarget.authenticate → SessionRpcTarget →
ProjectCollectionRpcTarget → ProjectRpcTarget` chain (`apps/os/src/rpc-targets.ts:6085, 6031, 4703, 5238`)
and the clean-room `Os → Session → ProjectCollection → Project` (`apps/control-plane/src/api.ts`).

**Is there an OUTER (iterate-product) shell above `authenticate`? No — and that is the point.** Per §4's
lean, `authenticate` stays a **control-plane** concern; the iterate product is not a shell you navigate
_through_, it is a **capability provider** _to_ the CP — its lifecycle hooks (`onProjectCreated`,
`flavorPrompt`) and its auth mechanism are mounts the CP resolves via **its own fallthrough** (§4). So
"product above the CP" and "auth is a CP concern" are both true: the product is one more link further out
on the same fallthrough chain, not a fourth `RpcTarget` in the `authenticate` path. This keeps the kernel
carrying **zero product shape** (the §1 LOCK: provision, not a config bag).

---

## 3. The Shell base — assembled branches, not a god-object (requirement 7)

The god-object dies not by deleting branches but by **inverting ownership**: the `Shell` base is ~40 lines;
each capability is a self-contained module that _registers_ its branch onto the shell prototype at load.
No 7,667-LOC class body, no file every DO imports.

```ts
// kernel/shell.ts — the whole base class.
import { RpcTarget } from "cloudflare:workers";

export abstract class Shell extends RpcTarget {
  abstract readonly mounts: MountTable;          // dynamic shadows + config-seed (the fold, §5)
  abstract readonly fallthrough: RpcStub<Shell> | null; // next shell OUT; null = terminal

  // The ONE dynamic entrypoint. The prototype hop (below) forwards every unknown
  // root here. Constructive branches (streams/repos/…) are real getters and never
  // reach this method — they resolve locally, O(1) (§5, requirement 8).
  async invokeCapability(call: { path: string[]; args: unknown[] }): Promise<unknown> {
    const local = this.mounts.lookup(call.path);            // dynamic shadow / live stub / expression
    if (local) return local.invoke(call.path, call.args);
    if (this.fallthrough) {                                 // OUTWARD: project → CP → product
      try { return await this.fallthrough.invokeCapability(call); }  // AWAITED — see H3
      catch (e) { if (!isUnbound(e)) throw; }               // a genuine CP miss falls to config defaults
    }
    const seed = this.configDefaults().lookup(call.path);   // TERMINAL = what the worker shipped with
    if (seed) return seed.invoke(call.path, call.args);
    throw new Unbound(call.path);
  }
  protected configDefaults(): MountTable { return this.mounts.seed; }
}

// A capability module registers itself — no central switch, no mega-class.
// Called ONCE per branch at module load (the "registry block" pattern already at the
// bottom of rpc-targets.ts, but now each defineBranch lives NEXT TO its provider).
export function defineBranch<S extends Shell>(
  Ctor: { prototype: S }, name: string, make: (self: S) => RpcTarget,
) {
  Object.defineProperty(Ctor.prototype, name, { get() { return make(this); }, configurable: true });
}

// e.g. domains/streams/branch.ts — the streams branch, self-contained:
defineBranch(ProjectShell, "streams", (self) => new StreamsBranch(self.projectId, self.mounts));
// domains/secrets/branch.ts, domains/ai/branch.ts, … each own ONE file.
```

**Why real prototype getters and a single proxied prototype _hop_, and never a `Proxy` around the
instance** — this is the sharpest constraint in the whole design, and it is already load-bearing in
`installPrototypeInvokeCapabilityFallback` (`apps/os/src/rpc-targets.ts` doc, lines ~290-317): workerd
classifies a call's result for pipelining with **native brand checks a JS `Proxy` can never pass**
(`serializeJsValueWithPipeline` → `NonPipelinable`; `cloudflare/workerd#6873`). A surface returned _from a
method_ must be a genuine, unproxied `RpcTarget` or `x.get(p).method()` dies with _"The RPC receiver does
not implement the method …"_. So:

```
instance ──proto──▶ ProjectShell.prototype ──proto──▶ Proxy(hop) ──proto──▶ Shell.prototype
```

- Declared branches (`streams`, `secrets`, `projects`) resolve on `ProjectShell.prototype` **before** the
  hop → native `SingleStub` → pipelinable. Built-ins always win (the intentional no-full-shadow-of-builtins
  trade; §7 accepts it).
- Unknown roots (`slack`, `home-assistant`) reach the hop's `get` trap → become one-shot
  `invokeCapability({ path, args })` path-proxies (the proven `createInvokeCapabilityPathProxy`,
  `apps/os/src/domains/itx/utils.ts:229`). The instance stays free of own properties, so Workers-RPC's
  instance-property protection needs no help.

This is the reuse: `defineBranch` + the hop **is** `installPrototypeInvokeCapabilityFallback`, just with
each branch's registration relocated into its own module so no file imports a god-object.

---

## 4. Provision & shadowing = one `fallthrough` stub + a mount fold (requirement 3)

**The whole fallthrough chain is `fallthrough: RpcStub<Shell> | null`.** Precedence for a _provided_ root
`X` (constructive kernel branches never enter this chain — §5):

| step | source                                                                     | example                                               |
| ---- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1    | this shell's dynamic mounts (the fold)                                     | agent-scope shadow of `slack`                         |
| 2    | `fallthrough` stub → the CP shell (recurses: its mounts → its fallthrough) | `egress`, `auth`, `directory`, product `flavorPrompt` |
| 3    | terminal: this worker's `configDefaults` (from `APP_CONFIG`)               | the deployment's baked-in `slack` receiver            |

Inner shadows outer by being consulted first; the CP shadows config defaults by being consulted before the
terminal. This is the literal §4 rule — _"a miss falls outward — inner → control plane → … → config
defaults baked into the deployed worker"_ — and it is the existing `capabilityFallbackForScope`
(`apps/os/.../capability-host-processor-contract.ts:407`: every non-root scope journals a one-hop fallback
`["capabilityHosts", ["get", "/"]]`), generalized so the terminal hop is a **cross-worker stub** instead of
a same-worker expression.

**Born-with-config, then stack-from-the-CP.** A project boots with `configDefaults` (terminal) available,
then at birth pulls the CP's provided mounts and installs them as **local** mounts (step 1) that shadow the
defaults. Two mount kinds, exactly today's `ProvideCapabilityInput` union
(`apps/os/.../capability-host/types.ts:46`):

- **`itx-expression`** — pure data (a recorded capnweb expression). _Copyable_ into the local fold at
  birth; replayed on the tree with no round trip. This is how the CP hands a project a static receiver.
- **`live`** — a stub to a _connected_ provider (the CP's egress door, the Pi's stream). _Not_ copyable;
  held as a stub; invoking it travels the connection and dies with it (the proven
  `retainLiveCapabilityProvider` / `deepRetainRpcStubs`, `live-capability.ts:25,57`).

So `fallthrough` is a _live_ mount too — the special "everything else" one. The mount fold is
event-sourced (`CapabilityHostProcessor`), so provision is **data**, and **full shadowing is allowed** with
no guards (§4 LOCK) — any shell may shadow any path any outer shell provided.

```ts
// The birth handshake — how a project acquires the CP's capabilities. AWAITED (H3).
async function bornShell(env: ProjectEnv, scope: Scope): Promise<ProjectShell> {
  const fallthrough = cpFallthrough(env, scope); // §7: Workers-RPC OR capnweb stub
  const fold = await CapabilityFold.open(env, scope); // the one DO (requirement 6)
  // Pull the CP's provided mounts ONCE, install as local shadows. If the CP is
  // unreachable we degrade to configDefaults — a self-hoster with no CP just works.
  using cpMounts = await fallthrough.listMounts(scope.projectId).catch(() => null);
  if (cpMounts) await fold.seedFrom(cpMounts); // itx-expressions copied; live kept as stubs
  return buildProjectShell({ ...scope, mounts: fold, fallthrough });
}
```

---

## 5. Kernel = interfaces; impls pluggable; constructive default (requirements 4, 6, 8)

**The kernel is interfaces, not classes.** A "stream" is whatever satisfies `StreamProvider`; the reference
impl is a Cloudflare DO, but the identical interface runs in Miniflare on a Pi. _(Kenton: Cap'n Web has "no
schemas … you call methods and pass objects around" — the interface is just a TS type.)_

```ts
// kernel/stream.ts — the DEFINE. Reference impl = DO; same interface runs on a Pi.
export interface StreamProvider extends RpcTarget {
  // TIER: minimal
  append(...events: Event[]): Promise<Event[]>;
  subscribe(sink: RpcStub<StreamSink>): Promise<void>; // push; sink is a stub (bidi, §7)
}
export interface DurableStreamProvider extends StreamProvider {
  // TIER: full
  getEvents(range?: Range): Promise<Event[]>; // history / catch-up
  getReducedState(): Promise<unknown>; // fold snapshot
}
// A repo is "just a provider" too:
export interface RepoProvider extends RpcTarget {
  read(p: string): Promise<Blob>;
  write(p: string, b: Blob): Promise<void>;
  commit(m: string): Promise<string>;
}
```

The two impls satisfy the same interface — this is the whole "runnable on a Pi" claim, made concrete:

```ts
// impl-cf/stream.ts — reference: one DO per (project, path); log in DO SQLite.
export class CfStream extends RpcTarget implements DurableStreamProvider {
  /* wraps StreamDurableObject */
}

// impl-mini/stream.ts — a Raspberry Pi under Miniflare. SAME interface, in-process log.
export class MiniStream extends RpcTarget implements StreamProvider {
  // minimal tier only
  #log: Event[] = [];
  #sinks = new Set<RpcStub<StreamSink>>();
  async append(...evs: Event[]) {
    this.#log.push(...evs);
    for (const s of this.#sinks) s.deliver(evs);
    return evs;
  }
  async subscribe(sink: RpcStub<StreamSink>) {
    this.#sinks.add(sink.dup());
  } // dup: keep past return (H4)
}
```

**The streams BRANCH is constructive; only shadows cost a record (requirement 8).** `streams.get(path)`
computes the default provider from the path — zero registry records — and consults the fold _only_ to see
if that one path is shadowed:

```ts
class StreamsBranch extends RpcTarget {
  // registered via defineBranch (§3)
  constructor(
    private projectId: string,
    private mounts: MountTable,
  ) {
    super();
  }
  get(path: string): StreamProvider {
    const shadow = this.mounts.streamShadow(path); // O(shadows), NOT O(paths-ever-used)
    if (shadow) return shadow; // the Pi, a BYO account, a remote origin
    // CONSTRUCTIVE DEFAULT: compute the DO name, no record written, ever.
    return new CfStream(env.STREAM.getByName(streamName(this.projectId, path)));
  }
}
```

So the hot path (a stream fed every 1-2s) **never** touches the fallthrough, never round-trips the CP, and
never writes a registry row. `provideCapability({ type: "live", path: ["streams", "/home-assistant"],
capability: piStub })` writes exactly one row; every other stream stays free. This is today's constructive
`itx.streams.get("/path")` (a computed DO name, O(1)) preserved, with shadow storage added only where a path
is overridden.

**One DO now, KV later (requirement 6).** The fold — dynamic mounts + config seed — is the single
`CapabilityHostDurableObject` (`apps/os/.../capability-host-durable-object.ts`), source of truth _and_
resolver. The stateless-worker/KV projection (§2a) is explicitly **not** in this design; it is a later read-
cache over the _routing_, never the data.

---

## 6. The extreme self-host topology — the Pi that dials out (requirement 5)

A stream provider on a Raspberry Pi behind NAT, with **no RPC bindings**, holds a **bidirectional capnweb
session** by dialing _out_. This is `newWebSocketRpcSession`'s exact purpose: capnweb is _"a symmetric
protocol, [with] no well-defined 'client' or 'server'"_ (Kenton), and the client passes its own `localMain`
that the server can call back on over the same socket.

```ts
// On the Pi (Miniflare / Node / Bun). ONE outbound WebSocket; NO inbound port.
import { newWebSocketRpcSession } from "capnweb";
const cloud = newWebSocketRpcSession<Shell>( // returns a stub for the CLOUD's shell
  "wss://iterate.example/api",
  new MiniStream(), // ← localMain: the capability WE provide back
);
using session = await cloud.authenticate(piCreds);
await session.projects.get(projectId).streams.get("/home-assistant").mount(/* self */);
```

- **The cloud side never dials the Pi.** It receives the Pi's `MiniStream` as a stub (via the session's
  `getRemoteMain()` / as an argument to `mount`) and stores it as a **live shadow** at
  `["streams","/home-assistant"]`. Calls to `streams.get("/home-assistant").subscribe(sink)` travel _back
  out_ over the held socket to the Pi. Same `StreamProvider` interface as the same-account `CfStream`.
- **Same interface, three locations, one mechanism.** A same-account DO stream (Workers RPC), a BYO-account
  project worker (the proven cross-account HTTP dial, `apps/project-worker/src/index.ts:157-185`), and a Pi
  (capnweb dial-out) are the _same_ `StreamProvider` mounted as a _live_ capability — location is a property
  of the provider, not the capability's identity (§2d). This resolves the 0017↔0013 tension exactly as the
  jam states: the _runner_ never dials out; a _capability provider_ does.
- **This is why the fallthrough stub is transport-agnostic.** In the full deployment `cpFallthrough` is a
  Workers-RPC service binding (`env.CP.enter(scope)`); in extreme self-host it is
  `newWebSocketRpcSession<Shell>(cpUrl, projectLocalMain).authenticate(...)`. Both are `RpcStub<Shell>`; the
  project shell holds one field and cannot tell them apart, because stubs cross the two systems and
  proxying is automatic (fact #2). `projectLocalMain` is what lets the CP call _lifecycle hooks back into
  the project_ over the same socket — the control-axis onion (§1).

---

## 7. Requirements coverage

| #   | Requirement                                         | How this design meets it                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Transport duality**, one `RpcTarget`, one `fetch` | `capnweb.RpcTarget === cloudflare:workers.RpcTarget` (`index.d.ts:371-372`). `Port.fetch` hands the shell to `newWorkersRpcResponse` (capnweb WS/HTTP-batch); `Port.enter(scope)` returns the _same_ `Shell` class over Workers RPC. `fetch` stays the HTTP handler (reserved); the RPC entry is `enter`. §1 |
| 2   | **Nested shells** navigated by RPC                  | `EntryShell.authenticate() → SessionShell.projects.get(id) → ProjectShell` — Shells returning Shells; unforgeable per Kenton. No outer product shell: the product is a fallthrough _provider_ to the CP; the auth _mechanism_ is a shadowable capability. §2, §4                                             |
| 3   | **Fallthrough chain + shadowing**                   | One field `fallthrough: RpcStub<Shell> \| null`. Precedence: local mounts → fallthrough (CP → product) → terminal `configDefaults`. Full shadowing, no guards. Mounts are `live` (stubs) or `itx-expression` (data). §4                                                                                      |
| 4   | **Kernel = interfaces; impls pluggable**            | `StreamProvider`/`DurableStreamProvider`/`RepoProvider` are TS interfaces over `RpcTarget`. `CfStream` (DO) and `MiniStream` (Pi Miniflare) both `implements StreamProvider`. §5                                                                                                                             |
| 5   | **Pi dials out, bidirectional**                     | `newWebSocketRpcSession(url, new MiniStream())`; symmetric session; cloud stores the Pi stub as a live shadow and calls back over the held socket. §6                                                                                                                                                        |
| 6   | **One DO now, KV later**                            | The mount fold = the single `CapabilityHostDurableObject`, source-of-truth _and_ resolver. KV projection explicitly deferred. §5                                                                                                                                                                             |
| 7   | **No `rpc-targets.ts` god-object**                  | `Shell` base is ~40 lines; each branch is its own module calling `defineBranch(...)` (= relocated `installPrototypeInvokeCapabilityFallback` registration). §3                                                                                                                                               |
| 8   | **No linear growth**                                | Kernel branches are **constructive**: `streams.get(path)` computes a DO name, writes no record; the fold is consulted only for a per-path shadow (O(shadows)). §5                                                                                                                                            |

---

## 8. The 3–5 hardest problems, and how each resolves (with the fact that forces it)

**H1 — A `Proxy` shell breaks promise pipelining.** If `Shell` were a `Proxy` wrapping the instance (the
obvious way to do dynamic dispatch), workerd's pipeline classifier `serializeJsValueWithPipeline` brands
the result `NonPipelinable` (`cloudflare/workerd#6873`), and `session.projects.get(id).streams.get(p)` —
the _entire_ shell-navigation idiom — dies with _"The RPC receiver does not implement the method."_
**Resolution:** genuine `RpcTarget` instances for every returned shell/branch (native `SingleStub`), and a
single proxied **prototype hop** between `ProjectShell.prototype` and `Shell.prototype` for unknown roots —
the exact structure already proven in `installPrototypeInvokeCapabilityFallback`. `defineBranch` just moves
each registration into its own module. Fact: capnweb pipelining + workerd brand checks
(`apps/os/src/rpc-targets.ts` fallback doc; capnweb README "promise pipelining").

**H2 — `fetch` is reserved over Workers RPC but not over capnweb.** A capability that wants
`Request → Response` (serve an app, stream a body, upgrade a WebSocket) _cannot_ be an RPC method named
`fetch` on any dual-transport shell (`reserved-methods/`), and even under a different name,
`Request`/`Response` are _"not reliably serializable across the loopback"_ (clean-room
`project-worker/src/index.ts:96-98`). **Resolution:** HTTP-shaped capabilities pass **primitives** and let
the edge reconstruct the `Response` — the proven `ProjectAuth.gate(callerHeader, cpOrigin, url) →
{ authorized, loginUrl }` shape. Genuine HTTP (app serving, 101 upgrades, streaming bodies) stays on the
**`fetch` transport lane**, _not_ RPC — exactly `apps/os` today: _"RPC method calls … cannot carry
[upgrades/streaming bodies]"_ (`itx-entrypoint.ts:47-55`). RPC is for method-shaped capabilities; `fetch`
is for byte-shaped ones; the `Port` hosts both and they never mix.

**H3 — Vacuous rejections silently swallow provision/fallthrough failures.** capnweb only transmits a
promise's resolution if you `await` it: _"If you don't actually await a promise before the batch is sent,
the system detects this and doesn't ask the server to send the return value back"_ (README 178-182); _"the
server won't even bother sending the response back over the wire"_ (593-594). A `fallthrough.invokeCapability(call)`
fired for effect, or a birth-time `listMounts()` never awaited, would **drop the CP's error** and the
project would look healthy while unbound. This is the recorded `capnweb_vacuous_rejects` gotcha.
**Resolution:** the fallthrough dispatch in `Shell.invokeCapability` is **`await`ed inside a closure** whose
rejection we actually observe (§3), the birth handshake `await`s `listMounts().catch(...)` (§4), and every
long-lived fallthrough/live stub is watched with **`onRpcBroken((err) => evict())`** (README 484-495) so a
CP or Pi disconnect _removes_ the shadow rather than hanging. Never fire-and-forget across a shell boundary.

**H4 — Stub lifetime across the fallthrough and live (Pi) mounts.** A live mount stores a peer stub past
the method return; capnweb/Workers ownership says a param stub is disposed when the call completes, so a
stored stub must be **`.dup()`'d** and later disposed, and disposing the _main_ WS stub **closes the
connection** (README 454-481, 578). Get this wrong and either the Pi socket dies mid-stream or stubs leak.
**Resolution:** reuse `deepRetainRpcStubs`/`retainLiveCapabilityProvider` verbatim — `dup()` on store,
`[Symbol.dispose]()` on revoke (`live-capability.ts:57-71`; `MiniStream.subscribe` does `sink.dup()`
above). The `fallthrough` stub is shell-lifetime and disposed with the shell; a Pi mount's stub is
session-lifetime and its `onRpcBroken` (H3) drives eviction, after which `streams.get("/home-assistant")`
falls back to the **constructive default** (§5) — graceful degradation for free.

**H5 — "CP shadows config" costs a round trip on every provided-cap miss.** Because config defaults are the
_terminal_ (consulted after the fallthrough), a root that is _only_ a config default still pays one hop to
the CP to confirm no shadow exists (§4, step 2 before step 3). For the hot path this would be fatal — but
the hot path is streams, which is **constructive and never enters the chain** (H1's short-circuit / §5). For
genuinely provided caps the cost is real but bounded, and the birth handshake **pulls CP mounts into the
local fold once** (§4 `bornShell`), so at steady state provided caps are _local_ mounts (step 1) and the
fallthrough fires only on cache-miss / late additions. Fact: native + capnweb pipelining makes even the
miss one round trip, not four (Cap'n Proto "TIME TRAVEL").

---

## 9. What I deliberately reject

- **A transport-adapter layer / two `RpcTarget` implementations.** The `RpcTarget`-alias fact (§0.1) makes
  it unnecessary; a "capnweb adapter" wrapping a Workers-RPC target would reintroduce the H1 `Proxy`
  pipelining break. One class, two mounts.
- **A `Proxy` around the shell instance for dynamic dispatch.** Breaks pipelining (H1). The prototype hop is
  the only structure workerd's classifier accepts.
- **`fetch(Request): Response` as an RPC method** on any dual-transport shell — reserved and unserializable
  (H2). Primitives over RPC; bytes over the `fetch` lane.
- **`newHttpBatchRpcSession` for the Pi / any bidirectional peer.** Its signature has **no `localMain`
  parameter** (`index-workers.d.ts:399`) — it is one-shot and cannot expose a capability back. Bidirectional
  peers (Pi, BYO account, browser callbacks) **must** use `newWebSocketRpcSession` (§6). HTTP-batch stays for
  stateless request/response callers only.
- **Config-bag parameterization of the kernel** (`platformSecrets`/`integrations`/`billing` slots). The §1
  LOCK: the kernel carries zero product shape; the product is a fallthrough provider. Provision, not config.
- **Making `streams` (or any kernel branch) a registered mount.** That is the linear-growth trap
  (requirement 8). Constructive default; store only shadows.
- **The KV routing projection, now.** Requirement 6: one DO is source-of-truth _and_ resolver; KV is a later
  read-cache over routing, never data.
- **A separate outer "iterate product" shell in the `authenticate` path.** The product is one more link on
  the fallthrough chain (§2), so the kernel's navigable surface stays exactly three shells.
