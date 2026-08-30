// core/itx-surface.ts — the client-facing capnweb surface + the stateless RELAY. This is the ONE place capnweb
// terminates (the `/api` worker); it reaches the StreamDurableObject only over Workers RPC (the hard rule).
//
// INVARIANT (owner): THE CLIENT IS JUST CAPNWEB. Every class in this file is a SERVER-side
// RpcTarget; what a client holds is a plain capnweb proxy of it. There is no client SDK and
// none may be introduced — a client's whole dependency is the capnweb package. Anything that
// would need client-side smarts belongs HERE, behind an RpcTarget method.
//
// A client dials `/api` and gets a `ProjectSession`:
//   • `get(context?)` → the `Itx` of that context (the root by default). Pure addressing.
//   • to offer a LIVE capability, `itx.rpcStubs.provide(stub, { key })` — the client's live capnweb
//     stub is retained here and reachable as `itx.rpcStubs.get(key)`; name it at a path by mounting
//     `itx.provide({ path, target: "itx.rpcStubs.get('<key>')" })`. Re-providing the same key
//     replaces (reconnect). `subscribe` parks its live callbacks through the same door.
//
// DON'T-PIN: the retained capnweb callback stub lives HERE, in this stateless worker (the relay). The relay
// opens a STUB PAGER WebSocket to the DO (core/hibernatable-rpc-stub.ts); the DO records only the stub's
// transport id on it. When the DO wants the client — event-batch delivery, state changes, request/response
// calls, all the same lane — it PAGES this worker, which answers over Workers RPC with a fresh
// RetainedCallbackInvoker stub. The DO keeps that stub warm while traffic flows and disposes it at its idle
// quiesce (a page gets it back). So the DO holds no stub while idle and hibernates with any number of clients.

import { RpcTarget } from "capnweb";
import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import type { DeliveryPolicy } from "./events.ts";
import { print, type Expression } from "./expression.ts";
import { disposeStub, openStubPagerWebSocket } from "./hibernatable-rpc-stub.ts";
import { codedError } from "./errors.ts";
import { InvokeHandle } from "./invoke-handle.ts";
import { installPrototypeInvokeCapabilityFallback } from "./dotted-path-proxy.ts";
import { canonicalName, DurableObjectNameCodec, normalizePath } from "./durable-object-names.ts";
import type { StreamDurableObject } from "../stream-durable-object.ts";

type ItxHostStub = DurableObjectStub<StreamDurableObject>;

/** A retained provider stub (capnweb) from the client. ON THE WIRE it is a callable stub
 *  Proxy (`typeof === "function"` — capnweb pipelines property access through it), so a
 *  structural validator can never inspect it: validated permissively BY DESIGN, typed at the
 *  use sites (`.dup()` keeps it past the provide call; other keys are its remote methods,
 *  resolving back on the client). */
type ProviderStub = unknown;
type RetainedProviderStub = { dup(): RetainedProviderStub; [k: string]: unknown };

/** Is this a LIVE capnweb capability (a stub function or an RpcTarget) rather than an expression
 *  (a string or an Expression array)? Live things get parked as rpc stubs; expressions are mounted
 *  directly. */
function isLiveStub(target: unknown): boolean {
  return typeof target === "function" || (typeof target === "object" && !Array.isArray(target));
}

/** The per-burst borrowed Workers-RPC leg: wraps the RETAINED CAPNWEB CALLBACK STUB and forwards
 *  `invoke(capPath, args)` onto it (a DIRECT dotted dispatch — never `.apply`), so a call from the
 *  stream reaches the client's actual function over the capnweb WebSocket. */
class RetainedCallbackInvoker extends WorkersRpcTarget {
  #provider: RetainedProviderStub;
  /** SHARED across every page of one relay (a `{ value }` holder), flipped by the ONE `onRpcBroken`
   *  registration in `startRpcStubRelay`. capnweb has no `offRpcBroken`, so registering per paged-in
   *  invoker would accumulate a listener per page for the session's life — the leak the failing test
   *  pins. capnweb fires onRpcBroken BEFORE it rejects the in-flight import, so a call caught below
   *  sees this already true — no race. */
  #broken: { value: boolean };
  constructor(provider: RetainedProviderStub, broken: { value: boolean }) {
    super();
    this.#provider = provider;
    this.#broken = broken;
  }
  async invoke(capPath: string[], args: unknown[]): Promise<unknown> {
    try {
      // Empty path = the provider IS the callable (a bare callback parked as a capability).
      if (capPath.length === 0)
        return await (this.#provider as unknown as (...a: unknown[]) => unknown)(...args);
      let recv = this.#provider as unknown as Record<string, unknown>;
      for (let i = 0; i < capPath.length - 1; i++)
        recv = recv[capPath[i]] as Record<string, unknown>;
      return await (recv[capPath[capPath.length - 1]] as (...a: unknown[]) => unknown)(...args);
    } catch (e) {
      // The provider died mid-call: capnweb throws its raw, UNCODED close error here. Re-code
      // LOCALLY to CONNECTION_OFFLINE so the CODE (never a message) crosses the Workers-RPC hop
      // back to the caller — the same condition the offline pre-call paths throw (core/errors.ts:
      // classify by code across a hop). A genuine app error from a live client propagates untouched.
      if (this.#broken.value)
        throw codedError("CONNECTION_OFFLINE", "itx rpc stub provider went offline mid-invoke");
      // Any other throw — a genuine app error OR a wrong guess at a live provider's surface — rides
      // back as its raw capnweb error. (We used to re-grammar path-misses into NOT_A_METHOD for an
      // apps/os error-normalizer; the clean room has no such consumer, so message-sniffing bought
      // nothing here.)
      throw e;
    }
  }
}

/** One CAPNWEB CALLBACK RELAY: the retained capnweb callback stub + the stub pager WebSocket into
 *  one stream DO + a fresh RetainedCallbackInvoker per page. One relay per (rpc stub, stream) pair;
 *  a client's capnweb WebSocket carries many. */
interface CapnwebCallbackRelay {
  transportId: string;
  dispose(): void;
}

/** Session-lived registry of live relays (retained callbacks + pager sockets) so they aren't GC'd.
 *  `named` additionally keys a relay by subscription name so `unsubscribe` can dispose exactly it. */
class Parking {
  readonly #relays = new Set<CapnwebCallbackRelay>();
  /** name → ALL relays parked under it. Re-subscribing the SAME name SHADOWS (the old callback
   *  stops receiving but its connection stays live — failing-delivery.test.ts:158), so the older
   *  relay is KEPT here, not disposed. `unsubscribe` then disposes the WHOLE set — else a shadowed
   *  relay lingers online and a restored shadowed mount resumes delivering to it (the zombie,
   *  probe_resub_zombie.mjs). */
  readonly #named = new Map<string, Set<CapnwebCallbackRelay>>();
  add(relay: CapnwebCallbackRelay): void {
    this.#relays.add(relay);
  }
  addNamed(name: string, relay: CapnwebCallbackRelay): void {
    this.#relays.add(relay);
    let set = this.#named.get(name);
    if (!set) {
      set = new Set();
      this.#named.set(name, set);
    }
    set.add(relay);
  }
  remove(relay: CapnwebCallbackRelay): void {
    this.#relays.delete(relay);
  }
  disposeNamed(name: string): void {
    const relays = this.#named.get(name);
    if (!relays) return;
    this.#named.delete(name);
    for (const relay of relays) {
      this.#relays.delete(relay);
      relay.dispose();
    }
  }
  disposeAll(): void {
    for (const relay of this.#relays) relay.dispose();
    this.#relays.clear();
    this.#named.clear();
  }
}

/** Park a live capnweb stub as an rpc stub under `key`: reserve a transport on the DO, dup the
 *  provider stub, open the stub pager WebSocket, and answer every page with a fresh stub. The
 *  relay lives until disposed (explicitly, or at session end); its close makes the DO drop the stub
 *  (⇒ any mount naming the key auto-revokes). */
export async function startRpcStubRelay(
  host: ItxHostStub,
  provider: RetainedProviderStub,
  key: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<CapnwebCallbackRelay> {
  const { transportId } = await host.rpcStubAttach({ key });
  const retained = provider.dup();
  // ONE shared broken flag for the whole relay — every paged-in invoker reads it; the single
  // onRpcBroken registration below flips it. (Registering per page would leak a listener per page:
  // capnweb has no offRpcBroken. See rpc-stub-broken-leak.failing.test.ts.)
  const broken = { value: false };
  const pagerWebSocket = await openStubPagerWebSocket(host, transportId, () => {
    // The page answer: re-mint the Workers-RPC stub around the retained capnweb callback and
    // hand it to the DO, which keeps it warm until its idle quiesce.
    waitUntil(
      host
        .rpcStubActivate({ transportId, invoker: new RetainedCallbackInvoker(retained, broken) })
        .catch(() => undefined), // a stale page (nobody waiting) returns undefined; offline throws — ignore
    );
  });
  const disposeRetained = () => disposeStub(retained);
  // The library's own death signal, registered ONCE: the client's capnweb session broke → the
  // retained callback can never answer again. Flip the shared flag (so in-flight invokes re-code to
  // CONNECTION_OFFLINE) AND close the pager WebSocket NOW so the DO drops the stub immediately —
  // without this the presence list lies until a page times out (10s).
  (retained as { onRpcBroken?: (cb: () => void) => void }).onRpcBroken?.(() => {
    broken.value = true;
    try {
      pagerWebSocket.close(1000, "provider session broke");
    } catch {
      /* already closing */
    }
  });
  pagerWebSocket.addEventListener("close", disposeRetained);
  return {
    transportId,
    dispose: () => {
      try {
        pagerWebSocket.close(1000, "relay disposed");
      } catch {
        /* already closing */
      }
      disposeRetained();
    },
  };
}

/** `session` at `/api` (bound to one projectId). `get(context?)` yields an `Itx`. */
export class ProjectSession extends RpcTarget {
  readonly #hostNamespace: DurableObjectNamespace<StreamDurableObject>;
  readonly #projectId: string;
  readonly #root: ItxHostStub;
  readonly #parking = new Parking(); // held for the session so retained callbacks + pager sockets aren't GC'd
  readonly #waitUntil: (p: Promise<unknown>) => void;

  constructor(
    hostNamespace: DurableObjectNamespace<StreamDurableObject>,
    projectId: string,
    ctx: ExecutionContext,
  ) {
    super();
    this.#hostNamespace = hostNamespace;
    this.#projectId = DurableObjectNameCodec.parse(projectId).projectId;
    this.#root = hostNamespace.getByName(canonicalName(projectId));
    this.#waitUntil = (p) => ctx.waitUntil(p);
  }

  /** capnweb invokes this when the client's /api session ends: tear every relay down so the
   *  DO-side rpc stubs die with their session instead of lying in the presence list. */
  // Symbol.dispose referenced defensively (lib target predates it) — same trick as disposeStub.
  [(Symbol as { dispose?: symbol }).dispose ?? Symbol.for("dispose")](): void {
    this.#parking.disposeAll();
  }

  /** THE introduction door (the `authenticate()` pattern: the only way to get an authenticated
   *  session is to be handed one by a gate that checked something). Deliberately a NO-OP today —
   *  the clean room's `?ctx=` front door is designation-without-introduction scaffolding, and
   *  this method is where the real check lands without changing any caller: clients already go
   *  `session.authenticate(credentials).get()`. */
  authenticate(_credentials?: unknown): ProjectSession {
    return this;
  }

  /** Pure addressing → a context's itx (the root by default). */
  get(context?: string): Itx {
    return new Itx(this.#contextHost(context), this.#parking, this.#waitUntil);
  }

  /** A context's stream DO by path (the root by default). */
  #contextHost(context?: string): ItxHostStub {
    const path = normalizePath(context ?? "/");
    return path === "/"
      ? this.#root
      : this.#hostNamespace.getByName(
          DurableObjectNameCodec.stringify({ projectId: this.#projectId, path }),
        );
  }
}

/** The live-stub kernel primitive, relay-side. `provide` parks a client's capnweb stub (retained
 *  HERE, paged into the DO); `get`/`list` forward to the DO's registry. */
class RpcStubs extends RpcTarget {
  readonly #host: ItxHostStub;
  readonly #parking: Parking;
  readonly #waitUntil: (p: Promise<unknown>) => void;
  constructor(host: ItxHostStub, parking: Parking, waitUntil: (p: Promise<unknown>) => void) {
    super();
    this.#host = host;
    this.#parking = parking;
    this.#waitUntil = waitUntil;
  }

  /** Register a live capnweb stub under `key` (a client-chosen string; one is generated if
   *  omitted). Re-providing the same key replaces the incumbent (reconnect). Returns a disposable
   *  handle — `revoke()`/`dispose` closes the transport, so the stub goes offline and any mount
   *  naming its key auto-revokes. */
  async provide(target: ProviderStub, opts?: { key?: string }): Promise<ProvidedStub> {
    const key = opts?.key ?? crypto.randomUUID();
    const relay = await startRpcStubRelay(
      this.#host,
      target as RetainedProviderStub,
      key,
      this.#waitUntil,
    );
    this.#parking.add(relay);
    return new ProvidedStub(key, relay, this.#parking);
  }

  /** Address a held stub by key — a pipelinable handle (`itx.rpcStubs.get('k').method(x)` rides one
   *  round trip on every lane; core/invoke-handle.ts). Offline ⇒ CONNECTION_OFFLINE at call time. */
  get(key: string): unknown {
    return new InvokeHandle((path, args) =>
      this.#host.invoke([
        "itx",
        "rpcStubs",
        ["get", key],
        ...path.slice(0, -1),
        [path.at(-1)!, ...args],
      ]),
    );
  }

  /** The keys currently held by this context (presence). */
  list(): Promise<unknown> {
    return this.#host.invoke(["itx", "rpcStubs", ["list"]]);
  }
}

/** The provider's handle for one `itx.rpcStubs.provide(...)`. Disposing it (or calling `revoke()`)
 *  closes the transport ⇒ the DO drops the stub ⇒ any mount naming its key auto-revokes. The mount
 *  layer is SEPARATE: a caller that mounted the stub at a path revokes that with `itx.revoke`. */
class ProvidedStub extends RpcTarget {
  readonly key: string;
  readonly #relay: CapnwebCallbackRelay;
  readonly #parking: Parking;
  constructor(key: string, relay: CapnwebCallbackRelay, parking: Parking) {
    super();
    this.key = key;
    this.#relay = relay;
    this.#parking = parking;
  }
  /** METHOD (pipelinable — one round trip on the unresolved handle, per failing-capnweb-wire). */
  revoke(): void {
    this.#parking.remove(this.#relay);
    this.#relay.dispose();
  }
  [(Symbol as { dispose?: symbol }).dispose ?? Symbol.for("dispose")](): void {
    this.revoke();
  }
}

/** The iterate context (`itx`). Dotted capability calls + the built-in collections forward to the DO over
 *  Workers RPC. capnweb terminates upstream in `/api`, so a client stub `itx.a.b(x)` never touches the DO's
 *  transport — it lands here and becomes `DO.invokeCapability("itx.a.b", [x])`. */
export class Itx extends RpcTarget {
  readonly #host: ItxHostStub;
  readonly #parking: Parking;
  readonly #waitUntil: (p: Promise<unknown>) => void;

  constructor(host: ItxHostStub, parking: Parking, waitUntil: (p: Promise<unknown>) => void) {
    super();
    this.#host = host;
    this.#parking = parking;
    this.#waitUntil = waitUntil;
  }

  /** The live-stub kernel primitive (`itx.rpcStubs.provide/get/list`). A declared getter so
   *  `provide` is intercepted relay-side (the retained stub must NOT cross to the DO — DON'T-PIN). */
  get rpcStubs(): RpcStubs {
    return new RpcStubs(this.#host, this.#parking, this.#waitUntil);
  }

  /** The universal dispatch door (built-ins + provided capabilities). `itx.a.b(x)` is client-side sugar for
   *  `invokeCapability({ path: ["a", "b"], args: [x] })`. */
  invokeCapability(input: { path: string[]; args?: unknown[] }): Promise<unknown> {
    return this.#host.invokeCapability(`itx.${input.path.join(".")}`, input.args ?? []);
  }

  /** The GENERIC dispatch door: a FULL expression, either codec half — mid-path call args and
   *  all (`itx.streams.get('/').append({...})`), which the dotted sugar above cannot spell. */
  invoke(call: string | Expression): Promise<unknown> {
    return this.#host.invoke(call);
  }

  /** Mount a capability: bind a capability path to a target expression (string half preferred —
   *  it is what the event stores). Name a live stub by targeting `"itx.rpcStubs.get('<key>')"`.
   *  Returns the mount's identity for `revoke`. */
  provide(input: {
    path: string | string[];
    target: string | Expression;
    delivery?: DeliveryPolicy;
  }): Promise<{ providedAtOffset: number }> {
    return this.#host.provideCapability(input);
  }

  /** Reach a FETCH-shaped capability through the session itself (the fork's
   *  Upgrade-Response-over-RPC carries the Response — including a 101 — back over capnweb, so
   *  capnweb clients need no separate /cap door). */
  fetchCap(cap: string | Expression, request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("x-itx-cap", typeof cap === "string" ? cap : JSON.stringify(cap));
    return this.#host.fetch(new Request(request, { headers }));
  }

  /** Pop a mount off the shadow stack (what it shadowed is restored) — by identity, or by
   *  capability path (the newest winner at that exact path). */
  async revoke(input: { providedAtOffset?: number; path?: string | string[] }): Promise<void> {
    await this.#host.revokeCapability(input);
  }

  /** Enable a facet-hosted processor on this context's stream. Sugar for "load a class as a
   *  facet + subscribe it": `ref` is the same `source` + `className` that
   *  `itx.load(src).getDurableObjectClass(className)` takes (userspace code through the Worker
   *  Loader), and enabling appends a SUBSCRIPTION mount `itx.subscribers.<slug> →
   *  itx.facets.get('<slug>')` that the commit pump drives. A processor is just a subscription to a
   *  facet. Ref-less enables a built-in processor by slug. */
  enableProcessor(
    slug: string,
    ref?: { source: string | Expression; className: string },
  ): Promise<{ ok: true }> {
    return this.#host.enableProcessor(slug, ref);
  }

  disableProcessor(slug: string): Promise<{ ok: true }> {
    return this.#host.disableProcessor(slug);
  }

  /** Subscribe — sugar for a subscription mount at `itx.subscribers.<name>`. How it is SERVED
   *  depends only on the target's shape (see DeliveryPolicy in core/events.ts):
   *    • a LIVE CALLBACK (any capnweb function/RpcTarget): parked as an rpc stub (itx.rpcStubs),
   *      then delivered ONE-DIRECTIONALLY — the stream fire-and-forgets each committed batch as
   *      `(events, scannedOffsetRange)` over the paged-in stub, no acks, no server cursor.
   *      The CLIENT owns its offset: check the ranges chain, heal any gap with read(afterOffset).
   *    • an ABSENT target (an itx expression — a webhook, a stateless worker): the
   *      subscription-forwarder facet holds a cursor per target, calls the target's terminal
   *      path with `(events, scannedOffsetRange)` per batch (the awaited call IS the ack), and
   *      applies the one bounded-retry-then-halt policy.
   *  Add `liveState: {key}` for state mode: the target receives each of the key's change
   *  payloads `{key, from, to, patch}` as it commits; the CLIENT chains revisions (seed through
   *  the producer's door, re-read it on any gap). Live callbacks only — an absent target has no
   *  chain to keep. */
  async subscribe(
    input: DeliveryPolicy & {
      name?: string;
      target: string | Expression | ProviderStub;
    },
  ): Promise<{ name: string; providedAtOffset: number }> {
    // SUBSCRIBING IS PROVIDING — pure edge sugar: a unique name (concurrent anonymous subscribes
    // must never shadow each other); park a live callback as an rpc stub, then ONE ordinary mount
    // at itx.subscribers.<name> targeting it, with the delivery policy riding the event.
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    const { name: _n, target: rawTarget, ...delivery } = input;
    let target: string | Expression;
    if (isLiveStub(rawTarget)) {
      const key = `sub-${crypto.randomUUID()}`;
      const relay = await startRpcStubRelay(
        this.#host,
        rawTarget as RetainedProviderStub,
        key,
        this.#waitUntil,
      );
      this.#parking.addNamed(name, relay);
      target = print(["itx", "rpcStubs", ["get", key]]);
    } else {
      target = rawTarget as string | Expression;
    }
    const { providedAtOffset } = await this.#host.provideCapability({
      path: `itx.subscribers.${name}`,
      target,
      delivery,
    });
    return { name, providedAtOffset };
  }

  /** Revoke the subscription mount and dispose the parked stub (if it was a live callback). */
  async unsubscribe(input: { name: string }): Promise<void> {
    // Clear the WHOLE stack + dispose ALL relays for the name — a re-subscribe shadowed the older
    // mount/relay (both still present), so a single-pop revoke would restore the shadowed mount and
    // its still-live relay would resume delivering (probe_resub_zombie.mjs).
    await this.#host.revokeCapability({ path: `itx.subscribers.${input.name}`, all: true });
    this.#parking.disposeNamed(input.name);
  }

  /** Recovery from a forwarder HALT (or an operator cursor seek) — absent targets only;
   *  connected targets have no server cursor to move. */
  resumeSubscription(input: { name: string; afterOffset?: number }): Promise<{ ok: true }> {
    return this.#host.resumeSubscription(input);
  }
}

// THE NATURAL DOTTED SURFACE. Insert the dynamic-capability fallback into `Itx.prototype`'s chain
// so an unknown segment (`itx.slack`, `itx.kv`) becomes an accumulated invokeCapability dispatch,
// while the declared methods/getters above (invoke / provide / subscribe / rpcStubs / …) always win.
// The default invokerFor is the instance itself — `Itx.invokeCapability({ path, args })` is exactly
// the door the path proxy calls. Runs once at module load, after the class body. See
// core/dotted-path-proxy.ts for the workerd brand-check reason this is a prototype hop and not a
// Proxy AROUND the instance.
installPrototypeInvokeCapabilityFallback(Itx);

/** Build the itx scope for a context reached over Workers-RPC — the `ItxEntrypoint` / loaded-worker
 *  lane. It is the SAME genuine `Itx` RpcTarget the capnweb client gets from `session.get()`
 *  (`Itx extends RpcTarget from "capnweb"`, which IS the native `cloudflare:workers` RpcTarget on
 *  workerd), so a loaded worker holds a real, pipelinable scope and writes exactly what a capnweb
 *  client writes: `const itx = await env.ITX.get(); itx.demo.timer.callLater(cb)`. No capnweb relays
 *  — a loaded worker's callbacks ride as Workers-RPC stubs through the call args, not the pager. */
export function itxForHost(host: ItxHostStub, waitUntil: (p: Promise<unknown>) => void): Itx {
  return new Itx(host, new Parking(), waitUntil);
}
