// core/itx-surface.ts — the client-facing capnweb surface + the stateless RELAY. This is the ONE place capnweb
// terminates (the `/api` worker); it reaches the IterateContextDurableObject only over Workers RPC (the hard rule).
//
// INVARIANT (owner): THE CLIENT IS JUST CAPNWEB. Every class in this file is a SERVER-side
// RpcTarget; what a client holds is a plain capnweb proxy of it. There is no client SDK and
// none may be introduced — a client's whole dependency is the capnweb package. Anything that
// would need client-side smarts belongs HERE, behind an RpcTarget method.
//
// THE EDGE DOCTRINE — what the `IterateContext` RpcTarget is FOR (three roles):
//   (a) PROXY: the stream verbs (append / read / waitForEvent) and capability dispatch
//       (invokeCapability, provide / revoke, subscribe, enable-/disableProcessor, fetchCap)
//       forward to the context DO over Workers RPC — the DO owns every contract, these methods
//       just relay;
//   (b) FOLD + PARK: the two jobs only the edge can do, because only the edge holds the client's
//       capnweb session — path invocation (the prototype fallback at the bottom folds dotted
//       sugar `itx.a.b(x)` into ONE invokeCapability expression) and the live-stub Parking (the
//       DON'T-PIN relay — see below);
//   (c) FUTURE — DO-free serving: this is where KV-cached mounted capabilities would land
//       (answering cached table rows / kv / whoami at the edge WITHOUT waking the DO).
//       Documented on purpose, deliberately NOT built.
//
// A client dials `/api` and gets a `ProjectSession`:
//   • `get(context?)` → the `IterateContext` of that context (the root by default). Pure addressing.
//   • ONE provide door: `itx.provide(path, target)` — target is an itx EXPRESSION (a durable
//     mount) or a LIVE capnweb value (function/RpcTarget). A live target is retained HERE and the
//     mount path IS its identity: calling `itx.<path>.method(x)` reaches it through the capability
//     table's live row. Re-providing the same path replaces the transport (reconnect). `subscribe`
//     parks its live callbacks through the same door, at `itx.subscribers.<name>`.
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
import { parseCapabilityPath, type Expression, type ItxExpression } from "./expression.ts";
import { installPrototypeInvokeCapabilityFallback } from "./dotted-path-proxy.ts";
import { canonicalName, DurableObjectNameCodec, normalizePath } from "./durable-object-names.ts";
import {
  Parking,
  startRpcStubRelay,
  type IterateContextStub,
  type ProviderStub,
  type RetainedProviderStub,
} from "./rpc-stub-relay.ts";

/** `session` at `/api` (bound to one projectId). `get(context?)` yields an `IterateContext`. */
export class ProjectSession extends RpcTarget {
  readonly #contextNamespace: DurableObjectNamespace<IterateContextDurableObject>;
  readonly #projectId: string;
  readonly #root: IterateContextStub;
  readonly #parking = new Parking(); // held for the session so retained callbacks + pager sockets aren't GC'd
  readonly #waitUntil: (p: Promise<unknown>) => void;

  constructor(
    contextNamespace: DurableObjectNamespace<IterateContextDurableObject>,
    projectId: string,
    ctx: ExecutionContext,
  ) {
    super();
    this.#contextNamespace = contextNamespace;
    this.#projectId = DurableObjectNameCodec.parse(projectId).projectId;
    this.#root = contextNamespace.getByName(canonicalName(projectId));
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

  /** Pure addressing → a context's itx (the root by default). The normalized context path rides
   *  along so the context can namespace its entries in the SESSION-shared Parking (two contexts
   *  may mount live stubs at the same capability path — they must never touch each other's). */
  get(context?: string): IterateContext {
    const path = normalizePath(context ?? "/");
    return new IterateContext(this.#contextStub(path), path, this.#parking, this.#waitUntil);
  }

  /** A context's stream DO by NORMALIZED path. */
  #contextStub(path: string): IterateContextStub {
    return path === "/"
      ? this.#root
      : this.#contextNamespace.getByName(
          DurableObjectNameCodec.stringify({ projectId: this.#projectId, path }),
        );
  }
}

/** The iterate context (`itx`). Dotted capability calls + the built-in collections forward to the DO over
 *  Workers RPC. capnweb terminates upstream in `/api`, so a client stub `itx.a.b(x)` never touches the DO's
 *  transport — it lands here and becomes a `DO.invoke(["itx", "a", ["b", x]])` call Expression. */
export class IterateContext extends RpcTarget {
  readonly #context: IterateContextStub;
  readonly #contextPath: string;
  readonly #parking: Parking;
  readonly #waitUntil: (p: Promise<unknown>) => void;

  constructor(
    context: IterateContextStub,
    contextPath: string,
    parking: Parking,
    waitUntil: (p: Promise<unknown>) => void,
  ) {
    super();
    this.#context = context;
    this.#contextPath = contextPath;
    this.#parking = parking;
    this.#waitUntil = waitUntil;
  }

  /** The Parking key for a live relay: `"<contextPath> <capabilityPath>"`. The Parking is
   *  SESSION-lived and shared by every IterateContext the session hands out, while a capability
   *  path is only unique PER CONTEXT (each context DO has its own capability table) — keying by
   *  capability path alone let two contexts providing at the same path dispose each other's relay
   *  (the pager close then auto-revoked a healthy live mount). A space separator is unambiguous:
   *  a capability path is dotted IDENT segments (parseCapabilityPath) and can never contain one,
   *  so the composite splits back at its last space — no (context, capability) pair collides. */
  #parkingKey(capabilityPath: string): string {
    return `${this.#contextPath} ${capabilityPath}`;
  }

  /** THE dispatch door (built-ins + provided capabilities) — the ONE way to call the itx surface.
   *  Takes an `ItxExpression`: a dotted string (`"itx.append({...})"`) OR the parsed array
   *  (`["itx",["append",{...}]]`); both carry mid-path call args, and both work here. The dotted
   *  sugar `itx.a.b(x)` folds into `["itx","a",["b",x]]` (see the prototype fallback at the bottom
   *  of this file) and lands right here. */
  invokeCapability(call: ItxExpression): Promise<unknown> {
    return this.#context.invoke(call);
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

  /** THE ONE PROVIDE DOOR — mount a capability at `path`. `target` is EITHER:
   *    • an itx EXPRESSION (a dotted string or the parsed array — what the event stores; full
   *      shadow-stack semantics), OR
   *    • a LIVE capnweb value (a function or an RpcTarget): the stub is retained HERE (relay-side
   *      — DON'T-PIN) and the MOUNT PATH is its identity — `itx.<path>.method(x)` reaches it, the
   *      capability table records `live: true` (no durable target), and the transport's final
   *      close auto-revokes the row. Re-providing the same path REPLACES the transport
   *      (reconnect — one live row per path, superseded in place).
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
    // ONE canonicalizer for the live-stub identity — validate/normalize BEFORE attaching (an
    // invalid path must never burn a transport reservation), attach the transport FIRST, append
    // the provided event SECOND (the event records a capability that can already serve).
    const pathString = parseCapabilityPath(typeof path === "string" ? path : path.join(".")).join(
      ".",
    );
    const relay = await startRpcStubRelay(
      this.#context,
      target as RetainedProviderStub,
      pathString,
      this.#waitUntil,
    );
    const parkingKey = this.#parkingKey(pathString);
    this.#parking.add(parkingKey, relay);
    try {
      return await this.#context.provideCapability({
        path: pathString,
        live: true,
        ...(delivery && { delivery }),
      });
    } catch (e) {
      // The DO refused the mount (STREAM_PAUSED / STREAM_BREAKER_OPEN / a validation throw): the
      // relay just parked would otherwise linger for the whole session — retained stub, pager
      // socket, and a DO transport that serves nothing. Tear it down and let the refusal propagate.
      this.#parking.dispose(parkingKey);
      throw e;
    }
  }

  /** Reach a FETCH-shaped capability through the session itself (the fork's
   *  Upgrade-Response-over-RPC carries the Response — including a 101 — back over capnweb, so
   *  capnweb clients need no separate /cap door). */
  fetchCap(cap: ItxExpression, request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set(CAPABILITY_FETCH_HEADER, encodeCapabilityFetchHeader(cap));
    return this.#context.fetch(new Request(request, { headers }));
  }

  /** Pop a mount off the shadow stack (what it shadowed is restored) — by capability path (the
   *  newest winner at that exact path) or by identity (`{ providedAtOffset }`). Revoking a LIVE
   *  mount also tears its transport down (DO-side) and disposes the local Parking relay — on BOTH
   *  spellings: the DO returns the revoked live rows' paths and each relay is disposed here (the
   *  by-offset door — the pipelined provide+revoke spelling — must not leave a dead relay parked
   *  until session end). */
  async revoke(input: string | string[] | { providedAtOffset: number }): Promise<void> {
    const { revokedLivePaths } = await this.#context.revokeCapability(
      typeof input === "string" || Array.isArray(input)
        ? {
            path: parseCapabilityPath(typeof input === "string" ? input : input.join(".")).join(
              ".",
            ),
          }
        : input,
    );
    for (const path of revokedLivePaths) this.#parking.dispose(this.#parkingKey(path));
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
   *    • a LIVE CALLBACK (any capnweb function/RpcTarget): parked AT `itx.subscribers.<name>`
   *      itself (the path is the stub's identity), then delivered ONE-DIRECTIONALLY — the stream
   *      fire-and-forgets each committed batch as `(events, range)` over the paged-in stub, no
   *      acks, no server cursor. The CLIENT owns its offset: check the ranges chain, heal any gap
   *      with read(afterOffset). Re-subscribing the SAME name REPLACES the transport (the old
   *      callback's parked stub gets the replaced-close; there is a brief commit window where the
   *      old row delivers to the new callback — one-directional lane, the ranges chain covers it).
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
    this.#parking.dispose(this.#parkingKey(path));
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
 *  lane. It is the SAME genuine `IterateContext` RpcTarget the capnweb client gets from `session.get()`
 *  (`IterateContext extends RpcTarget from "capnweb"`, which IS the native `cloudflare:workers` RpcTarget on
 *  workerd), so a loaded worker holds a real, pipelinable scope and writes exactly what a capnweb
 *  client writes: `const itx = await env.ITX.get(); itx.demo.timer.callLater(cb)`. No capnweb relays
 *  — a loaded worker's callbacks ride as Workers-RPC stubs through the call args, not the pager. */
export function itxFor(
  context: IterateContextStub,
  waitUntil: (p: Promise<unknown>) => void,
): IterateContext {
  // A FRESH Parking per call (this lane parks nothing session-long), so its keys can never collide
  // across contexts — the context-path half of the composite key is a constant here.
  return new IterateContext(context, "/", new Parking(), waitUntil);
}
