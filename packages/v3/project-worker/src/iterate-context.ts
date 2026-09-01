// iterate-context.ts — the client-facing capnweb surface + the stateless RELAY. This is the ONE place capnweb
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
// HOW A CLIENT REACHES ONE: `/api` → `UnauthenticatedSession.authenticate()` → `Session.projects.get(id)`
// → that project's ROOT `IterateContext` (session.ts). Contexts within a project are reached from a
// context with `cd(path)` (absolute by convention, relative resolves).
//
// AXIOMS AND SUGAR, kept apart on the class body below. The axioms are the doors that need the edge
// (a session-held stub, a live Request, the fold): `cd`, `invokeCapability`, `append`, `read`,
// `waitForEvent`, `fetch`, `rpcStubs`. Everything else is SUGAR — one-line compositions of those
// that append no event shape of their own:
//   • `provide(path, target)` — an itx EXPRESSION mounts (`capability-provided { path, target }`); a
//     LIVE capnweb value (function/RpcTarget) is parked in `itx.rpcStubs` under the path (retained
//     HERE — the physical half), then the ordinary mount `path ⇒ itx.rpcStubs.get('<path>')` is
//     appended (the pure-data half). Re-providing re-parks (reconnect) and appends nothing.
//   • `subscribe({ name?, target, consumes? })` — the subscriptions layer's ONE event
//     (`subscription-configured`); a live target parks under `itx.subscriptions.<name>` first.
//   • `enableProcessor(name, { source, className })` — a subscription whose target is a facet's
//     `processEventBatch`; `disableProcessor` removes it and deletes the facet.
//
// DON'T-PIN: the retained capnweb callback stub lives HERE, in this stateless worker (the relay). The relay
// opens a STUB PAGER WebSocket to the DO (context/hibernatable-rpc-stub.ts); the DO records only the stub's
// transport id on it. When the DO wants the client — event-batch delivery, state changes, request/response
// calls, all the same lane — it PAGES this worker, which answers over Workers RPC with a fresh
// RetainedCallbackInvoker stub. The DO keeps that stub warm while traffic flows and disposes it at its idle
// quiesce (a page gets it back). So the DO holds no stub while idle and hibernates with any number of clients.

import { RpcTarget } from "capnweb";
import type { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
import {
  CAPABILITY_FETCH_HEADER,
  encodeCapabilityFetchHeader,
} from "./fetch/fetch-capabilities.ts";
import type { StreamEvent, StreamEventInput } from "./stream/events.ts";
import type { WaitForEventFilter } from "./stream/stream.ts";
import { parseCapabilityPath, toExpression, type ItxExpression } from "./context/expression.ts";
import type { WorkerSource } from "./context/worker-loader.ts";
import { installPrototypeInvokeCapabilityFallback } from "./context/dotted-path-proxy.ts";
import { InvokeHandle } from "./context/invoke-handle.ts";
import {
  DurableObjectNameCodec,
  resolveContextPath,
  type DurableObjectAddress,
} from "./context/durable-object-names.ts";
import {
  Parking,
  startRpcStubRelay,
  type IterateContextStub,
  type ProviderStub,
  type RetainedProviderStub,
} from "./context/rpc-stub-relay.ts";

export type ContextNamespace = DurableObjectNamespace<IterateContextDurableObject>;
export type WaitUntil = (p: Promise<unknown>) => void;

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
    assertLiveValue(target, "rpcStubs.provide(target, { key })");
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
   *  trip on every lane; context/invoke-handle.ts). Offline ⇒ CONNECTION_OFFLINE at call time. */
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
   *  or a WS-serving worker; fetch/fetch-capabilities.ts doctrine, points 1 & 4). So
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
    path: string,
    target: ItxExpression | ProviderStub,
  ): Promise<{ providedAtOffset: number }> {
    if (typeof target === "string" || Array.isArray(target))
      return this.#context.provideCapability({ path, target });
    assertLiveValue(target, "provide(path, target)");
    // Park FIRST, mount SECOND (the event records a capability that can already serve). The
    // registry key IS the canonical mount path — one canonicalizer, done inside rpcStubs.provide.
    const { key } = await this.rpcStubs.provide(target, { key: path });
    try {
      return await this.#context.provideCapability({
        path: key,
        target: ["itx", "rpcStubs", ["get", key]],
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
  async revoke(input: string | { providedAtOffset: number }): Promise<void> {
    if (typeof input === "string") {
      const path = parseCapabilityPath(input).join(".");
      await this.#context.revokeCapability({ path });
      this.rpcStubs.close(path);
      return;
    }
    await this.#context.revokeCapability(input);
  }

  // ── SUBSCRIPTIONS: sugar over the subscriptions layer's one event (subscriptions.ts) ──

  /** Subscribe: have each committed batch — filtered by `consumes` — delivered to `target` as
   *  `(events, range)`. `target` is EITHER an itx EXPRESSION whose terminal is callable that way (a
   *  facet's `.processEventBatch`, a loaded entrypoint's method, a sibling context's `.append`) OR a
   *  LIVE capnweb callback, which is parked in `itx.rpcStubs` under `itx.subscriptions.<name>` and
   *  targeted as `itx.rpcStubs.get('…')`. HOW it is served is not declared here: the context looks
   *  at what the target evaluates to — a facet or a live stub owns its progress and gets a push (the
   *  client heals a gap with `read`); anything else gets an at-least-once cursor the stream keeps.
   *  Same name REPLACES; an identical subscribe appends NOTHING (a reconnect is zero events). An
   *  unnamed subscription is SESSION-scoped: it is removed when this session ends. */
  async subscribe(input: {
    name?: string;
    target: ItxExpression | ProviderStub;
    consumes?: string[];
  }): Promise<{ name: string }> {
    const anonymous = input.name === undefined;
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    let target: ItxExpression;
    if (typeof input.target === "string" || Array.isArray(input.target)) target = input.target;
    else {
      assertLiveValue(input.target, "subscribe({ target })");
      const { key } = await this.rpcStubs.provide(input.target, {
        key: `itx.subscriptions.${name}`,
      });
      target = ["itx", "rpcStubs", ["get", key]];
    }
    await this.#context.configureSubscription({
      name,
      target,
      ...(input.consumes && { consumes: input.consumes }),
    });
    if (anonymous)
      // Dies with the session: the removal rides waitUntil so the socket's close can complete.
      this.#parking.add(this.#parkingKey(`subscription:${name}`), {
        dispose: () =>
          this.#waitUntil(this.#context.removeSubscription(name).catch(() => undefined)),
      });
    return { name };
  }

  /** Remove a subscription (appends `subscription-removed`; a cursor target's cursor goes with it)
   *  and close this session's parked callback under it, if any. */
  async unsubscribe(name: string): Promise<void> {
    await this.#context.removeSubscription(name);
    this.rpcStubs.close(`itx.subscriptions.${name}`);
    this.#parking.dispose(this.#parkingKey(`subscription:${name}`));
  }

  // ── PROCESSORS: sugar over subscribe + the facet built-ins ──

  /** Enable a processor: host `className` (a `StreamProcessorDurableObject` subclass exported by
   *  the loaded `source`) as the facet named `name`, and subscribe its `processEventBatch` to every
   *  commit. Literally `subscribe({ name, target: itx.load(source).getDurableObjectClass(className)
   *  .get(name).processEventBatch, consumes })` — a processor is a named facet that is pushed the
   *  log. `consumes` is the SUBSCRIPTION's filter (what is sent; absent = every durable event); the
   *  processor's contract is the FOLD's (what it reduces) — so a processor that folds ephemerals
   *  names them here too, exactly as a live subscriber would. */
  enableProcessor(
    name: string,
    ref: { source: WorkerSource; className: string; consumes?: string[] },
  ): Promise<{ name: string }> {
    return this.subscribe({
      name,
      target: [
        "itx",
        ["load", ref.source],
        ["getDurableObjectClass", ref.className],
        ["get", name],
        "processEventBatch",
      ],
      ...(ref.consumes && { consumes: ref.consumes }),
    });
  }

  /** Disable a processor: unsubscribe it and DELETE its facet, storage included — a re-enable is a
   *  clean rebuild from the log, never a resume from orphaned state. */
  async disableProcessor(name: string): Promise<void> {
    await this.unsubscribe(name);
    await this.#context.invoke(["itx", "facets", ["delete", name]]);
  }
}

/** The one shape check for a live capnweb value: a function, an RpcTarget, or a stub (has dup). */
function assertLiveValue(target: unknown, where: string): void {
  if (
    typeof target !== "function" &&
    !(target instanceof RpcTarget) &&
    typeof (target as { dup?: unknown } | null)?.dup !== "function"
  )
    throw new TypeError(
      `${where}: target must be an itx expression (string | array) or a LIVE capnweb value (function | RpcTarget)`,
    );
}

// THE NATURAL DOTTED SURFACE. Insert the dynamic-capability fallback into `IterateContext.prototype`'s chain
// so an unknown segment (`itx.slack`, `itx.kv`) becomes an accumulated invokeCapability dispatch,
// while the declared methods/getters above (invokeCapability / provide / subscribe / …) always win.
// The receiver IS the invoker — the accumulated access folds into ONE `invokeCapability(expression)`
// call (`[...root, ...prefix, [method, ...args]]`), and `IterateContext.invokeCapability` is exactly
// the door the fold dispatches onto. Runs once at module load, after the class body. See
// context/dotted-path-proxy.ts for the workerd brand-check reason this is a prototype hop and not a
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
