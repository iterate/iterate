// core/itx-surface.ts — the client-facing capnweb surface + the stateless RELAY. This is the ONE place capnweb
// terminates (the `/api` worker); it reaches the IterateContextDurableObject only over Workers RPC (the hard rule).
//
// INVARIANT (owner): THE CLIENT IS JUST CAPNWEB. Every class in this file is a SERVER-side
// RpcTarget; what a client holds is a plain capnweb proxy of it. There is no client SDK and
// none may be introduced — a client's whole dependency is the capnweb package. Anything that
// would need client-side smarts belongs HERE, behind an RpcTarget method.
//
// A client dials `/api` and gets a `ProjectSession`:
//   • `get(context?)` → the `IterateContext` of that context (the root by default). Pure addressing.
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
import type { IterateContextDurableObject } from "../stream-durable-object.ts";
import { CAPABILITY_FETCH_HEADER, encodeCapabilityFetchHeader } from "./fetch-capabilities.ts";
import type { DeliveryPolicy, StreamEvent } from "./events.ts";
import type { WaitForEventFilter } from "./stream.ts";
import { print, type Expression, type ItxExpression } from "./expression.ts";
import { InvokeHandle } from "./invoke-handle.ts";
import { installPrototypeInvokeCapabilityFallback } from "./dotted-path-proxy.ts";
import { canonicalName, DurableObjectNameCodec, normalizePath } from "./durable-object-names.ts";
import {
  isLiveStub,
  Parking,
  startRpcStubRelay,
  type CapnwebCallbackRelay,
  type ItxHostStub,
  type ProviderStub,
  type RetainedProviderStub,
} from "./rpc-stub-relay.ts";

/** `session` at `/api` (bound to one projectId). `get(context?)` yields an `IterateContext`. */
export class ProjectSession extends RpcTarget {
  readonly #hostNamespace: DurableObjectNamespace<IterateContextDurableObject>;
  readonly #projectId: string;
  readonly #root: ItxHostStub;
  readonly #parking = new Parking(); // held for the session so retained callbacks + pager sockets aren't GC'd
  readonly #waitUntil: (p: Promise<unknown>) => void;

  constructor(
    hostNamespace: DurableObjectNamespace<IterateContextDurableObject>,
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
  get(context?: string): IterateContext {
    return new IterateContext(this.#contextHost(context), this.#parking, this.#waitUntil);
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
 *  transport — it lands here and becomes a `DO.invoke(["itx", "a", ["b", x]])` call Expression. */
export class IterateContext extends RpcTarget {
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

  /** THE dispatch door (built-ins + provided capabilities) — the ONE way to call the itx surface.
   *  Takes an `ItxExpression`: a dotted string (`"itx.streams.get('/').append({...})"`) OR the parsed
   *  array (`["itx","streams",["get","/"],["append",{...}]]`); both carry mid-path call args, and both
   *  work here. The dotted sugar `itx.a.b(x)` folds into `["itx","a",["b",x]]` (see the prototype
   *  fallback at the bottom of this file) and lands right here. */
  invokeCapability(call: ItxExpression): Promise<unknown> {
    return this.#host.invoke(call);
  }

  /** OBSERVABILITY (read-only): the context host's incarnation, core fold (paused/breaker), active
   *  subscription mounts, and live rpc-stub registry — one JSON snapshot. Replaces the old `/state`
   *  HTTP door; there is no second transport, just this method over capnweb. */
  hostState(): Promise<Record<string, unknown>> {
    return this.#host.hostState();
  }

  /** Wait for the next event matching `filter` — or the first committed durable match after an
   *  explicit `afterOffset` (the default is the head at call time: "the next occurrence"). The
   *  parked wait lives on the DO (Stream.waitForEvent owns the whole contract — type filter,
   *  30s/120s timeout → WAIT_TIMEOUT, non-minting); this method just proxies, and the client's
   *  own open call is what keeps the wait alive. */
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent> {
    return this.#host.waitForEvent(filter);
  }

  /** Mount a capability: bind a capability path to a target expression (string half preferred —
   *  it is what the event stores). Name a live stub by targeting `"itx.rpcStubs.get('<key>')"`.
   *  Returns the mount's identity for `revoke`. */
  provide(input: {
    path: string | string[];
    target: ItxExpression;
    delivery?: DeliveryPolicy;
  }): Promise<{ providedAtOffset: number }> {
    return this.#host.provideCapability(input);
  }

  /** Reach a FETCH-shaped capability through the session itself (the fork's
   *  Upgrade-Response-over-RPC carries the Response — including a 101 — back over capnweb, so
   *  capnweb clients need no separate /cap door). */
  fetchCap(cap: ItxExpression, request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set(CAPABILITY_FETCH_HEADER, encodeCapabilityFetchHeader(cap));
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
   *      `(events, range)` over the paged-in stub, no acks, no server cursor.
   *      The CLIENT owns its offset: check the ranges chain, heal any gap with read(afterOffset).
   *    • an ABSENT target (an itx expression — a webhook, a stateless worker): the
   *      subscription-forwarder facet holds a cursor per target, calls the target's terminal
   *      path with `(events, range)` per batch (the awaited call IS the ack), and
   *      applies the one bounded-retry-then-halt policy. DURABLE ROWS ONLY: the forwarder's
   *      cursor reads the log, so an EPHEMERAL event never reaches an absent target even when
   *      `consumes` names its type — ephemerals ride only the connected lane.
   *  Add `liveState: {key}` for state mode: the target receives each of the key's change
   *  payloads `{key, from, to, patch}` as it commits; the CLIENT chains revisions (seed through
   *  the producer's door, re-read it on any gap). Live callbacks only — an absent target has no
   *  chain to keep. */
  async subscribe(
    input: DeliveryPolicy & {
      name?: string;
      target: ItxExpression | ProviderStub;
    },
  ): Promise<{ name: string; providedAtOffset: number }> {
    // SUBSCRIBING IS PROVIDING — pure edge sugar: a unique name (concurrent anonymous subscribes
    // must never shadow each other); park a live callback as an rpc stub, then ONE ordinary mount
    // at itx.subscribers.<name> targeting it, with the delivery policy riding the event.
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    const { name: _n, target: rawTarget, ...delivery } = input;
    let target: ItxExpression;
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
      target = rawTarget as ItxExpression;
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

// THE NATURAL DOTTED SURFACE. Insert the dynamic-capability fallback into `IterateContext.prototype`'s chain
// so an unknown segment (`itx.slack`, `itx.kv`) becomes an accumulated invokeCapability dispatch,
// while the declared methods/getters above (invoke / provide / subscribe / rpcStubs / …) always win.
// The default invokerFor is the instance itself — `IterateContext.invokeCapability({ path, args })` is exactly
// the door the path proxy calls. Runs once at module load, after the class body. See
// core/dotted-path-proxy.ts for the workerd brand-check reason this is a prototype hop and not a
// Proxy AROUND the instance.
installPrototypeInvokeCapabilityFallback(IterateContext, ["itx"]);

/** Build the itx scope for a context reached over Workers-RPC — the `ItxEntrypoint` / loaded-worker
 *  lane. It is the SAME genuine `IterateContext` RpcTarget the capnweb client gets from `session.get()`
 *  (`IterateContext extends RpcTarget from "capnweb"`, which IS the native `cloudflare:workers` RpcTarget on
 *  workerd), so a loaded worker holds a real, pipelinable scope and writes exactly what a capnweb
 *  client writes: `const itx = await env.ITX.get(); itx.demo.timer.callLater(cb)`. No capnweb relays
 *  — a loaded worker's callbacks ride as Workers-RPC stubs through the call args, not the pager. */
export function itxForHost(
  host: ItxHostStub,
  waitUntil: (p: Promise<unknown>) => void,
): IterateContext {
  return new IterateContext(host, new Parking(), waitUntil);
}
