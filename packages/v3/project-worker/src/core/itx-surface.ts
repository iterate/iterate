// core/itx-surface.ts — the client-facing capnweb surface + the stateless RELAY. This is the ONE place capnweb
// terminates (the `/api` worker); it reaches the IterateContextDurableObject only over Workers RPC (the hard rule).
//
// INVARIANT (owner): THE CLIENT IS JUST CAPNWEB. Every class in this file is a SERVER-side
// RpcTarget; what a client holds is a plain capnweb proxy of it. There is no client SDK and
// none may be introduced — a client's whole dependency is the capnweb package. Anything that
// would need client-side smarts belongs HERE, behind an RpcTarget method.
//
// THE EDGE DOCTRINE — what the `IterateContext` RpcTarget is FOR (three roles):
//   (a) PROXY: the stream verbs (append / read / waitForEvent), egress (fetch) and capability
//       dispatch (invokeCapability, provide / revoke, subscribe, enable-/disableProcessor) forward
//       to the context DO over Workers RPC — the DO owns every contract, these methods just relay;
//   (b) FOLD + PARK: the two jobs only the edge can do, because only the edge holds the client's
//       capnweb session — path invocation (the prototype fallback at the bottom folds dotted
//       sugar `itx.a.b(x)` into ONE invokeCapability expression) and the live-stub Parking (the
//       DON'T-PIN relay — see below);
//   (c) FUTURE — DO-free serving: this is where KV-cached mounted capabilities would land
//       (answering cached table rows / kv / whoami at the edge WITHOUT waking the DO).
//       Documented on purpose, deliberately NOT built.
//
// THE SESSION SHAPE (apps/os's, verbatim): a client dials `/api` and holds an `UnauthenticatedSession`
// whose only door is `authenticate()` → a `Session` → `projects: ProjectCollection` →
// `get(projectId)` → the project's ROOT `IterateContext` ("/"). Contexts within a project are
// reached from a context with `cd(path)` (absolute by convention, relative resolves). One
// session may hold contexts of many projects; the Parking (below) is keyed by canonical context
// name so they never touch each other's relays.
//
//   using api = newWebSocketRpcSession("wss://<worker>/api");
//   const itx = api.authenticate().projects.get("prj_123");
//
// ONE provide door: `itx.provide(path, target)` — target is an itx EXPRESSION (a durable mount) or
// a LIVE capnweb value (function/RpcTarget). A live target is SUGAR over two axioms: the value is
// parked in the `itx.rpcStubs` built-in under the path (retained HERE — the physical half), then the
// ordinary mount event `path ⇒ itx.rpcStubs.get('<path>')` is appended (the pure-data half).
// Calling `itx.<path>.method(x)` resolves the mount like any other. Re-providing the same path
// re-parks (reconnect) and appends nothing. `itx.rpcStubs` is the registry itself, for the two-step
// spelling: `provide(value, { key })` parks, `get(key)` / `list()` ride the dotted surface to the
// DO's built-in.
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
import type { DeliveryPolicy, StreamEvent, StreamEventInput } from "./events.ts";
import type { WaitForEventFilter } from "./stream.ts";
import {
  parseCapabilityPath,
  toExpression,
  type Expression,
  type ItxExpression,
} from "./expression.ts";
import { installPrototypeInvokeCapabilityFallback } from "./dotted-path-proxy.ts";
import { InvokeHandle } from "./invoke-handle.ts";
import {
  DurableObjectNameCodec,
  resolveContextPath,
  type DurableObjectAddress,
} from "./durable-object-names.ts";
import {
  Parking,
  startRpcStubRelay,
  type IterateContextStub,
  type ProviderStub,
  type RetainedProviderStub,
} from "./rpc-stub-relay.ts";

type ContextNamespace = DurableObjectNamespace<IterateContextDurableObject>;
type WaitUntil = (p: Promise<unknown>) => void;

/** What `/api` serves: nothing but the gate. The ROOT capnweb target, so its lifetime IS the
 *  socket's — capnweb disposes it when the client's session ends, and that is when every relay
 *  this session parked is torn down (the DO-side stubs die with their session instead of lying
 *  in the presence list). */
export class UnauthenticatedSession extends RpcTarget {
  readonly #parking = new Parking(); // held for the session so retained callbacks + pager sockets aren't GC'd
  readonly #session: Session;

  constructor(contexts: ContextNamespace, ctx: ExecutionContext) {
    super();
    this.#session = new Session(contexts, this.#parking, (p) => ctx.waitUntil(p));
  }

  // Symbol.dispose referenced defensively (lib target predates it) — same trick as disposeStub.
  [(Symbol as { dispose?: symbol }).dispose ?? Symbol.for("dispose")](): void {
    this.#parking.disposeAll();
  }

  /** THE introduction door (the `authenticate()` pattern: the only way to hold authority is to be
   *  handed it by a gate that checked something). Deliberately a NO-OP today — this is where the
   *  real credential check lands without changing any caller: clients already spell
   *  `api.authenticate(credentials).projects.get(id)`. */
  authenticate(_credentials?: unknown): Session {
    return this.#session;
  }
}

/** What you authenticate into: a catalog that vends contexts. A session is NOT a context — it is
 *  the directory you reach one through (apps/os: "a session is what authenticate() returns"). */
export class Session extends RpcTarget {
  readonly #projects: ProjectCollection;

  constructor(contexts: ContextNamespace, parking: Parking, waitUntil: WaitUntil) {
    super();
    this.#projects = new ProjectCollection(contexts, parking, waitUntil);
  }

  /** The project catalog. A GETTER, not a field: capnweb (like Workers RPC) exposes prototype
   *  members only — an instance property is private state and is refused over the wire. */
  get projects(): ProjectCollection {
    return this.#projects;
  }
}

/** The project catalog. `get(projectId)` is pure addressing → that project's ROOT context. No
 *  `list`/`create` yet (owner: not now); when they come they ride a deployment context's events. */
export class ProjectCollection extends RpcTarget {
  readonly #contexts: ContextNamespace;
  readonly #parking: Parking;
  readonly #waitUntil: WaitUntil;

  constructor(contexts: ContextNamespace, parking: Parking, waitUntil: WaitUntil) {
    super();
    this.#contexts = contexts;
    this.#parking = parking;
    this.#waitUntil = waitUntil;
  }

  /** The project's root context ("/"). Side-effect free: nothing is minted until the context is
   *  first written to. A project ID only — a context name belongs to `cd`. */
  get(projectId: string): IterateContext {
    const address = DurableObjectNameCodec.parse(projectId);
    if (address.path !== "/")
      throw new Error(
        `projects.get(projectId): got a context name ${JSON.stringify(projectId)} — pass the project id and cd(path) from its root`,
      );
    return new IterateContext(this.#contexts, address, this.#parking, this.#waitUntil);
  }
}

/** The `itx.rpcStubs` REGISTRY, edge half — the physical axiom under a live provide. `provide` is
 *  the one member that must live HERE (only the edge holds the client's capnweb session, so only
 *  the edge can retain a stub — DON'T-PIN); `get`/`list` fold onto the DO's built-in exactly as the
 *  dotted surface would. Parking is SEPARATE from mounting: nothing in this class appends an
 *  event. A declared getter on `IterateContext` (not the dotted fallback) because `provide` and
 *  `close` are edge verbs. */
class RpcStubs extends RpcTarget {
  readonly #context: IterateContextStub;
  readonly #parking: Parking;
  readonly #parkingKey: (key: string) => string;
  readonly #waitUntil: WaitUntil;
  constructor(
    context: IterateContextStub,
    parking: Parking,
    parkingKey: (key: string) => string,
    waitUntil: WaitUntil,
  ) {
    super();
    this.#context = context;
    this.#parking = parking;
    this.#parkingKey = parkingKey;
    this.#waitUntil = waitUntil;
  }

  /** Park a live capnweb value (a function or an RpcTarget) under `key` — a canonical capability
   *  path string (the DO asserts the spelling; `itx.provide(path, fn)` passes the mount path).
   *  Re-parking the same key REPLACES the transport (reconnect). Nothing is mounted: name the stub
   *  from a mount with `itx.provide(path, "itx.rpcStubs.get('<key>')")`, or call it directly as
   *  `itx.rpcStubs.get('<key>').method(x)`. */
  async provide(target: ProviderStub, opts: { key: string }): Promise<{ key: string }> {
    if (
      typeof target !== "function" &&
      !(target instanceof RpcTarget) &&
      typeof (target as { dup?: unknown } | null)?.dup !== "function"
    )
      throw new TypeError(
        "rpcStubs.provide(target, { key }): target must be a LIVE capnweb value (function | RpcTarget)",
      );
    // Validate/normalize BEFORE attaching — an invalid key must never burn a transport reservation.
    const key = parseCapabilityPath(opts.key).join(".");
    const relay = await startRpcStubRelay(
      this.#context,
      target as RetainedProviderStub,
      key,
      this.#waitUntil,
    );
    this.#parking.add(this.#parkingKey(key), relay);
    return { key };
  }

  /** A parked stub by key — a pipelinable handle (`itx.rpcStubs.get('k').method(x)` rides one round
   *  trip on every lane; core/invoke-handle.ts). Offline ⇒ CONNECTION_OFFLINE at call time. */
  get(key: string): unknown {
    return new InvokeHandle((path, args) =>
      this.#context.invoke([
        "itx",
        "rpcStubs",
        ["get", key],
        ...path.slice(0, -1),
        [path.at(-1)!, ...args],
      ]),
    );
  }

  /** PRESENCE — the keys with an open transport right now (the DO's built-in). */
  list(): Promise<unknown> {
    return this.#context.invoke(["itx", "rpcStubs", ["list"]]);
  }

  /** Dispose THIS session's relay for `key`: the pager closes and the DO drops the stub. A no-op
   *  for a key this session never parked. Mounts naming the key are untouched (`itx.revoke`). */
  close(key: string): void {
    this.#parking.dispose(this.#parkingKey(parseCapabilityPath(key).join(".")));
  }
}

/** The iterate context (`itx`) at one `{ projectId, path }`. Dotted capability calls + the
 *  built-in collections forward to the DO over Workers RPC. capnweb terminates upstream in `/api`,
 *  so a client stub `itx.a.b(x)` never touches the DO's transport — it lands here and becomes a
 *  `DO.invoke(["itx", "a", ["b", x]])` call Expression. */
export class IterateContext extends RpcTarget {
  readonly #contexts: ContextNamespace;
  readonly #address: DurableObjectAddress;
  readonly #context: IterateContextStub;
  readonly #parking: Parking;
  readonly #waitUntil: WaitUntil;

  constructor(
    contexts: ContextNamespace,
    address: DurableObjectAddress,
    parking: Parking,
    waitUntil: WaitUntil,
  ) {
    super();
    this.#contexts = contexts;
    this.#address = address;
    this.#context = contexts.getByName(address.name);
    this.#parking = parking;
    this.#waitUntil = waitUntil;
  }

  /** The Parking key for a live relay: `"<contextName> <capabilityPath>"`. The Parking is
   *  SESSION-lived and shared by every IterateContext the session hands out (across projects),
   *  while a capability path is only unique PER CONTEXT — keying by capability path alone let two
   *  contexts providing at the same path dispose each other's relay. A space separator is
   *  unambiguous: a context name has no spaces and a capability path is dotted IDENT segments. */
  #parkingKey(capabilityPath: string): string {
    return `${this.#address.name} ${capabilityPath}`;
  }

  /** Another context of THIS project. Absolute by convention (`cd("/agents/support")`); relative
   *  (`"agents/support"`, `"../inbox"`) resolves against this context's path — one resolver, shared
   *  with the built-in `itx.cd(...)` root. Returns an EDGE context, so `provide(path, fn)` on it
   *  parks in this same session. Pure addressing: nothing is minted. */
  cd(path: string): IterateContext {
    const address = DurableObjectNameCodec.parse(
      DurableObjectNameCodec.stringify({
        projectId: this.#address.projectId,
        path: resolveContextPath(this.#address.path, path),
      }),
    );
    return new IterateContext(this.#contexts, address, this.#parking, this.#waitUntil);
  }

  /** The live-stub registry (`itx.rpcStubs.provide/get/list/close`) — the physical axiom `provide`
   *  composes with a mount. A declared getter so it wins over the dotted fallback (the fallback
   *  would fold `get`/`list` correctly but cannot park). */
  get rpcStubs(): RpcStubs {
    return new RpcStubs(this.#context, this.#parking, (k) => this.#parkingKey(k), this.#waitUntil);
  }

  /** THE dispatch door (built-ins + provided capabilities) — the ONE way to call the itx surface.
   *  Takes an `ItxExpression`: a dotted string (`"itx.append({...})"`) OR the parsed array
   *  (`["itx",["append",{...}]]`); both carry mid-path call args, and both work here. The dotted
   *  sugar `itx.a.b(x)` folds into `["itx","a",["b",x]]` (see the prototype fallback at the bottom
   *  of this file) and lands right here.
   *
   *  ONE routing rule: a call whose TERMINAL step is `fetch(request)` carrying a live Request rides
   *  the DO's FETCH CHANNEL with the capability in the `x-itx-cap` header, not `invoke` — the fetch
   *  channel is the only hop kind that carries a socket-bearing Response back (a 101 from a tunnel
   *  or a WS-serving worker; core/fetch-capabilities.ts doctrine, points 1 & 4). So
   *  `itx.todos.web.fetch(request)` just works, upgrades included, and there is no second door. */
  invokeCapability(call: ItxExpression): Promise<unknown> {
    const expr = toExpression(call);
    const last = expr.at(-1);
    if (
      Array.isArray(last) &&
      last[0] === "fetch" &&
      last.length === 2 &&
      last[1] instanceof Request
    ) {
      const headers = new Headers(last[1].headers);
      headers.set(CAPABILITY_FETCH_HEADER, encodeCapabilityFetchHeader(expr.slice(0, -1)));
      return this.#context.fetch(new Request(last[1], { headers }));
    }
    return this.#context.invoke(expr);
  }

  /** Append events to this context's log — the flattened stream verb, same commit pipeline as the
   *  expression spelling `itx.append({...})` (built-ins.ts root). Validation, idempotency, the
   *  inline reduces, and the fan-out all live on the DO (Stream.append owns the contract); this
   *  method just proxies. Returns the committed events with their assigned offsets. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]> {
    return this.#context.append(...events);
  }

  /** Read a page of the durable log after `afterOffset` (default 0; `limit` default 500).
   *  `scannedThroughOffset` is the client's contiguity cursor — chain it for the next page. A
   *  non-minting probe: reading a virgin stream leaves it virgin. */
  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number }> {
    return this.#context.read(afterOffset, limit);
  }

  /** Wait for the next event matching `filter` — or the first committed durable match after an
   *  explicit `afterOffset` (the default is the head at call time: "the next occurrence"). The
   *  parked wait lives on the DO (Stream.waitForEvent owns the whole contract — type filter,
   *  30s/120s timeout → WAIT_TIMEOUT, non-minting); this method just proxies, and the client's
   *  own open call is what keeps the wait alive. */
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent> {
    return this.#context.waitForEvent(filter);
  }

  /** EGRESS through the context (the tutorial's chapter 2): `{{secret:project:NAME}}` placeholders
   *  are substituted in the DO, then the request leaves through FALLBACK. A Request with no itx
   *  header is egress by definition — the DO's fetch walks its doors (stub pager, live-capability
   *  upgrade leg, `x-itx-cap`) and egress is what remains. The same terminal a loaded worker's
   *  `globalOutbound` and the built-in `itx.fetch` root land on. */
  fetch(request: Request): Promise<Response> {
    return this.#context.fetch(request);
  }

  /** THE ONE PROVIDE DOOR — mount a capability at `path`. `target` is EITHER:
   *    • an itx EXPRESSION (a dotted string or the parsed array — what the event stores; full
   *      shadow-stack semantics), OR
   *    • a LIVE capnweb value (a function or an RpcTarget) — SUGAR over two axioms: park the value
   *      in `itx.rpcStubs` under the path (retained HERE, relay-side — DON'T-PIN), then mount the
   *      pure-data target `itx.rpcStubs.get('<path>')`. `itx.<path>.method(x)` resolves that mount
   *      like any other. Re-providing the same path re-parks (reconnect — the transport is
   *      replaced) and, the mount being identical, appends NOTHING (the door is idempotent). If
   *      the provider vanishes the mount STAYS: calls answer CONNECTION_OFFLINE until `revoke`.
   *  Anything else is a loud TypeError. Returns the mount's identity for `revoke`. */
  async provide(
    path: string | string[],
    target: ItxExpression | ProviderStub,
    opts?: { delivery?: DeliveryPolicy },
  ): Promise<{ providedAtOffset: number }> {
    const delivery = opts?.delivery;
    if (typeof target === "string" || Array.isArray(target))
      return this.#context.provideCapability({ path, target, ...(delivery && { delivery }) });
    if (
      typeof target !== "function" &&
      !(target instanceof RpcTarget) &&
      typeof (target as { dup?: unknown } | null)?.dup !== "function"
    )
      throw new TypeError(
        "provide(path, target): target must be an itx expression (string | array) or a LIVE capnweb value (function | RpcTarget)",
      );
    // Park FIRST, mount SECOND (the event records a capability that can already serve). The
    // registry key IS the canonical mount path — one canonicalizer, done inside rpcStubs.provide.
    const { key } = await this.rpcStubs.provide(target, {
      key: typeof path === "string" ? path : path.join("."),
    });
    try {
      return await this.#context.provideCapability({
        path: key,
        target: ["itx", "rpcStubs", ["get", key]],
        ...(delivery && { delivery }),
      });
    } catch (e) {
      // The DO refused the mount (STREAM_PAUSED / STREAM_BREAKER_OPEN / a validation throw): the
      // relay just parked would otherwise linger for the whole session — retained stub, pager
      // socket, and a DO transport that serves nothing. Tear it down and let the refusal propagate.
      this.rpcStubs.close(key);
      throw e;
    }
  }

  /** Pop a mount off the shadow stack (what it shadowed is restored) — by capability path (the
   *  newest winner at that exact path) or by identity (`{ providedAtOffset }`). The by-PATH
   *  spelling is the inverse of `provide(path, fn)`: it also closes THIS session's parked stub
   *  under that path, if any (a local fact — no DO round trip, no other session's stub is touched).
   *  The by-offset spelling revokes the mount only; a stub this session parked stays addressable
   *  as `itx.rpcStubs.get('…')` until `rpcStubs.close` or session end. */
  async revoke(input: string | string[] | { providedAtOffset: number }): Promise<void> {
    if (typeof input === "string" || Array.isArray(input)) {
      const path = parseCapabilityPath(typeof input === "string" ? input : input.join(".")).join(
        ".",
      );
      await this.#context.revokeCapability({ path });
      this.rpcStubs.close(path);
      return;
    }
    await this.#context.revokeCapability(input);
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
    return this.#context.enableProcessor(slug, ref);
  }

  disableProcessor(slug: string): Promise<{ ok: true }> {
    return this.#context.disableProcessor(slug);
  }

  /** Subscribe — sugar for a subscription mount at `itx.subscribers.<name>`, through the ONE
   *  provide door. How it is SERVED depends only on the target's shape (see DeliveryPolicy in
   *  core/events.ts):
   *    • a LIVE CALLBACK (any capnweb function/RpcTarget): parked in `itx.rpcStubs` under
   *      `itx.subscribers.<name>` and mounted there (target `itx.rpcStubs.get('…')`), then
   *      delivered ONE-DIRECTIONALLY — the stream fire-and-forgets each committed batch as
   *      `(events, range)` over the paged-in stub, no acks, no server cursor. The CLIENT owns its
   *      offset: check the ranges chain, heal any gap with read(afterOffset). Re-subscribing the
   *      SAME name REPLACES the transport (the old callback's parked stub gets the replaced-close)
   *      and appends nothing when the policy is unchanged; a changed policy shadows the old row,
   *      and fan-out delivers to the winner only.
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
    // must never shadow each other), then ONE ordinary provide at itx.subscribers.<name> with the
    // delivery policy riding the event. A live callback parks at that path directly.
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    const { name: _n, target, ...delivery } = input;
    const { providedAtOffset } = await this.provide(`itx.subscribers.${name}`, target, {
      delivery,
    });
    return { name, providedAtOffset };
  }

  /** Revoke the subscription mount and dispose the parked stub (if it was a live callback).
   *  Clears the WHOLE stack at the path — an off-switch must not restore an older shadowed
   *  expression mount (prove_disable_shadow.mjs). */
  async unsubscribe(input: { name: string }): Promise<void> {
    const path = `itx.subscribers.${input.name}`;
    await this.#context.revokeCapability({ path, all: true });
    this.rpcStubs.close(path);
  }

  /** Recovery from a forwarder HALT (or an operator cursor seek) — absent targets only;
   *  connected targets have no server cursor to move. */
  resumeSubscription(input: { name: string; afterOffset?: number }): Promise<{ ok: true }> {
    return this.#context.resumeSubscription(input);
  }
}

// THE NATURAL DOTTED SURFACE. Insert the dynamic-capability fallback into `IterateContext.prototype`'s chain
// so an unknown segment (`itx.slack`, `itx.kv`) becomes an accumulated invokeCapability dispatch,
// while the declared methods/getters above (invokeCapability / provide / subscribe / …) always win.
// The receiver IS the invoker — the accumulated access folds into ONE `invokeCapability(expression)`
// call (`[...root, ...prefix, [method, ...args]]`), and `IterateContext.invokeCapability` is exactly
// the door the fold dispatches onto. Runs once at module load, after the class body. See
// core/dotted-path-proxy.ts for the workerd brand-check reason this is a prototype hop and not a
// Proxy AROUND the instance.
installPrototypeInvokeCapabilityFallback(IterateContext, ["itx"]);

/** Build the itx scope for a context reached over Workers-RPC — the `ItxEntrypoint` / loaded-worker
 *  lane. It is the SAME genuine `IterateContext` RpcTarget the capnweb client gets from
 *  `projects.get()` (`IterateContext extends RpcTarget from "capnweb"`, which IS the native
 *  `cloudflare:workers` RpcTarget on workerd), so a loaded worker holds a real, pipelinable scope and
 *  writes exactly what a capnweb client writes: `const itx = await env.ITX.get();
 *  itx.demo.timer.callLater(cb)`. No capnweb relays — a loaded worker's callbacks ride as
 *  Workers-RPC stubs through the call args, not the pager. */
export function itxFor(
  contexts: ContextNamespace,
  contextName: string,
  waitUntil: WaitUntil,
): IterateContext {
  // A FRESH Parking per call (this lane parks nothing session-long), so its keys can never collide.
  return new IterateContext(
    contexts,
    DurableObjectNameCodec.parse(contextName),
    new Parking(),
    waitUntil,
  );
}
