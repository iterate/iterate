// core/itx-surface.ts — the client-facing capnweb surface + the stateless RELAY. This is the ONE place capnweb
// terminates (the `/api` worker); it reaches the StreamDurableObject only over Workers RPC (the hard rule).
//
// INVARIANT (owner): THE CLIENT IS JUST CAPNWEB. Every class in this file is a SERVER-side
// RpcTarget; what a client holds is a plain capnweb proxy of it. There is no client SDK and
// none may be introduced — a client's whole dependency is the capnweb package. Anything that
// would need client-side smarts belongs HERE, behind an RpcTarget method.
//
// A client dials `/api` and gets a `ProjectSession`:
//   • `get()`     → the project `Itx` (the root context). Pure addressing.
//   • `connect({ context?, connectionKey?, capabilities?, description? })` → the `Itx` of THAT context, PLUS an
//     ItxConnection: the client's live `capabilities` callback is retained here and the connection is attached to
//     the context's stream (an ephemeral connection-opened fact names it; the session rule files the durable
//     ItxConnectionSession history). Tabs/devices are connections; a context IS the client (/clients/browser).
//
// DON'T-PIN: the retained capnweb callback stub lives HERE, in this stateless worker (the relay). The relay
// opens a STUB PAGER WebSocket to the DO (core/hibernatable-rpc-stub.ts); the DO records only the connection's
// identity on it. When the DO wants the client — event-batch delivery, state changes, request/response calls,
// all the same lane — it PAGES this worker, which answers over Workers RPC with a fresh RetainedCallbackInvoker
// stub. The DO keeps that stub warm while traffic flows and disposes it at its idle quiesce (a page gets it
// back). So the DO holds no stub while idle and hibernates with any number of clients attached.

import { RpcTarget } from "capnweb";
import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import type { DeliveryPolicy } from "./events.ts";
import { print, type Expression } from "./expression.ts";
import { disposeStub, openStubPagerWebSocket } from "./hibernatable-rpc-stub.ts";
import { codedError } from "./errors.ts";
import { installPrototypeInvokeCapabilityFallback } from "./dotted-path-proxy.ts";
import { canonicalName, DurableObjectNameCodec, normalizePath } from "./durable-object-names.ts";
import type { StreamDurableObject } from "../stream-durable-object.ts";

type ItxHostStub = DurableObjectStub<StreamDurableObject>;

/** A retained provider stub (capnweb) from the client. ON THE WIRE it is a callable stub
 *  Proxy (`typeof === "function"` — capnweb pipelines property access through it), so a
 *  structural validator can never inspect it: validated permissively BY DESIGN, typed at the
 *  use sites (`.dup()` keeps it past the connect/provide call; other keys are its remote
 *  methods, resolving back on the client). */
type ProviderStub = unknown;
type RetainedProviderStub = { dup(): RetainedProviderStub; [k: string]: unknown };

/** A `.connect` input: which context to attach to (default the root), the client-chosen
 *  connectionKey (reconnects under the same key share an ItxConnectionSession), and the live
 *  `capabilities` the connection offers. A capability is any capnweb stub — an RpcTarget with
 *  methods (reached as `itx.connections.get(key).method()`, pipelinable via core/invoke-handle.ts)
 *  OR a bare callback (root-called `itx.<mount>(args)` — the delivery/subscriber shape). */
interface ConnectOpts {
  context?: string;
  connectionKey?: string;
  description?: string;
  capabilities?: ProviderStub;
}
interface ProvideLiveInput {
  path: string[];
  capability: ProviderStub;
  instructions?: string;
}

/** A raw provider-side path MISS, as the REMOTE capnweb stub spells it: the two native shapes a
 *  segment/terminal miss takes on any JS object — a non-callable terminal ("… is not a function.")
 *  or a read through an absent segment ("Cannot read properties of undefined|null (reading …)").
 *  Deliberately narrow: a genuine application error thrown by a real provider method has NEITHER
 *  shape, so re-grammaring on this predicate can never swallow an app failure — it only re-codes a
 *  WRONG GUESS at the capability surface into the platform's one miss grammar (core/itx path-proxy
 *  isPathMissMessage). Message-sniffing is safe HERE (not across a hop) because the raw capnweb
 *  reject is caught LOCALLY at the relay, before any error crosses Workers-RPC. */
function isProviderPathMiss(e: unknown): boolean {
  const message =
    typeof e === "object" && e !== null && "message" in e
      ? String((e as { message: unknown }).message)
      : String(e);
  return (
    /is not a function/.test(message) ||
    /Cannot read properties of (?:undefined|null) \(reading /.test(message)
  );
}

/** The per-burst borrowed Workers-RPC leg: wraps the RETAINED CAPNWEB CALLBACK STUB and forwards
 *  `invoke(capPath, args)` onto it (a DIRECT dotted dispatch — never `.apply`), so a call from the
 *  stream reaches the client's actual function over the capnweb WebSocket. */
class RetainedCallbackInvoker extends WorkersRpcTarget {
  #provider: RetainedProviderStub;
  /** Set the instant the provider's capnweb session breaks. capnweb fires onRpcBroken BEFORE it
   *  rejects the in-flight import, so a call caught below sees this already true — no race. */
  #broken = false;
  constructor(provider: RetainedProviderStub) {
    super();
    this.#provider = provider;
    (provider as { onRpcBroken?: (cb: (e: unknown) => void) => void }).onRpcBroken?.(() => {
      this.#broken = true;
    });
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
      if (this.#broken)
        throw codedError("CONNECTION_OFFLINE", "itx connection provider went offline mid-invoke");
      // A dotted-path MISS on a LIVE provider — a wrong guess at its capability surface (a segment
      // resolved to undefined/null, or the terminal is not a function) — rides back from the REMOTE
      // capnweb stub as a raw JS TypeError that names only the FIRST bad segment in no recognizable
      // grammar ("'chat.nosuchMethod' is not a function.", "Cannot read properties of undefined
      // (reading 'postMessage')"). Re-code it to the platform's ONE miss grammar (isPathMissMessage —
      // apps/os/src/itx/path-proxy.ts), naming the FULL attempted dotted path, so an error normalizer
      // (slack-api normalizeSlackError et al.) can answer with the surface's calling convention and
      // the caller's next attempt is shaped right. NOT_A_METHOD rides beside the message for cross-hop
      // classification (core/errors.ts). A GENUINE application error from a live provider method (any
      // other shape) propagates UNTOUCHED — isProviderPathMiss claims only the two native property-miss
      // shapes, never an app's own throw.
      if (capPath.length > 0 && isProviderPathMiss(e))
        throw codedError(
          "NOT_A_METHOD",
          `Capability path ${capPath.join(".")} did not resolve to a function.`,
        );
      throw e;
    }
  }
}

/** One CAPNWEB CALLBACK RELAY: the retained capnweb callback stub + the stub pager WebSocket
 *  into one stream DO + a fresh RetainedCallbackInvoker per page. One relay per
 *  (ItxConnection, stream) pair; a client's capnweb WebSocket carries many. */
interface CapnwebCallbackRelay {
  connectionId: string;
  dispose(): void;
}

/** Start a relay for an ALREADY-ATTACHED connection (the DO minted `connectionId` =
 *  String(connectedAtOffset) when it appended the ephemeral connection-opened fact): dup the
 *  provider stub, open the stub pager WebSocket, answer every page with a fresh stub. */
async function startCapnwebCallbackRelay(
  host: ItxHostStub,
  provider: RetainedProviderStub,
  connectionId: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<CapnwebCallbackRelay> {
  const retained = provider.dup();
  const pagerWebSocket = await openStubPagerWebSocket(host, connectionId, () => {
    // The page answer: re-mint the Workers-RPC stub around the retained capnweb callback and
    // hand it to the DO, which keeps it warm until its idle quiesce.
    waitUntil(
      host
        .activateItxConnection({ connectionId, invoker: new RetainedCallbackInvoker(retained) })
        .catch(() => undefined), // a stale page (nobody waiting) returns undefined; offline throws — ignore
    );
  });
  const disposeRetained = () => disposeStub(retained);
  // The library's own death signal: the client's capnweb session broke → the retained callback
  // can never answer again. Close the pager WebSocket NOW so the DO reaps the connection
  // immediately — without this the currently-connected list lies until a page times out (10s). The
  // close code carries no session meaning: every last-transport close ends the session (see the
  // itx-connection-directory header — a network blip is deliberately ended + started, no coalescing).
  (retained as { onRpcBroken?: (cb: () => void) => void }).onRpcBroken?.(() => {
    try {
      pagerWebSocket.close(1000, "provider session broke");
    } catch {
      /* already closing */
    }
  });
  pagerWebSocket.addEventListener("close", disposeRetained);
  return {
    connectionId,
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

/** `session` at `/api` (bound to one projectId). `get`/`connect` both yield an `Itx`. */
export class ProjectSession extends RpcTarget {
  readonly #hostNamespace: DurableObjectNamespace<StreamDurableObject>;
  readonly #projectId: string;
  readonly #root: ItxHostStub;
  readonly #relays = new Set<CapnwebCallbackRelay>(); // held for the session so the retained callbacks + pager sockets aren't GC'd
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
   *  DO-side connections die with their session instead of lying in the connected list. */
  // Symbol.dispose referenced defensively (lib target predates it) — same trick as disposeStub.
  [(Symbol as { dispose?: symbol }).dispose ?? Symbol.for("dispose")](): void {
    for (const relay of this.#relays) relay.dispose();
    this.#relays.clear();
  }

  /** THE introduction door (the `authenticate()` pattern: the only way to get an authenticated
   *  session is to be handed one by a gate that checked something). Deliberately a NO-OP today —
   *  the clean room's `?ctx=` front door is designation-without-introduction scaffolding, and
   *  this method is where the real check lands without changing any caller: clients already go
   *  `session.authenticate(credentials).get()` / `.connect(...)`. */
  authenticate(_credentials?: unknown): ProjectSession {
    return this;
  }

  /** Pure addressing → the root context's itx. */
  get(): Itx {
    return new Itx(this.#root, this.#relays, this.#waitUntil);
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

  /** Attach an ItxConnection to a context (the root by default) and return that context's itx.
   *  With `capabilities`, the callback is retained relay-side and the connection is addressable
   *  through the context's `connections` view (`itx.connections.get(connectionKey)`; fan-out is
   *  `connections.list()` + map). Without, this is pure addressing into the named context. */
  async connect(opts: ConnectOpts = {}): Promise<Itx> {
    const host = this.#contextHost(opts.context);
    if (opts.capabilities) {
      const attached = await host.attachItxConnection({
        connectionKey: opts.connectionKey,
        description: opts.description,
      });
      this.#relays.add(
        await startCapnwebCallbackRelay(
          host,
          opts.capabilities as RetainedProviderStub,
          attached.connectionId,
          this.#waitUntil,
        ),
      );
    }
    return new Itx(host, this.#relays, this.#waitUntil);
  }
}

/** The iterate context (`itx`). Dotted capability calls + the built-in collections forward to the DO over
 *  Workers RPC. capnweb terminates upstream in `/api`, so a client stub `itx.a.b(x)` never touches the DO's
 *  transport — it lands here and becomes `DO.invokeCapability("itx.a.b", [x])`. */
export class Itx extends RpcTarget {
  readonly #host: ItxHostStub;
  readonly #relays: Set<CapnwebCallbackRelay>;
  readonly #waitUntil: (p: Promise<unknown>) => void;

  constructor(
    host: ItxHostStub,
    relays: Set<CapnwebCallbackRelay>,
    waitUntil: (p: Promise<unknown>) => void,
  ) {
    super();
    this.#host = host;
    this.#relays = relays;
    this.#waitUntil = waitUntil;
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
   *  it is what the event stores). Event provenance — built-in targets are config-mount-only.
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
   *  facet + subscribe it": `ref` is the SAME `{ source, className }` shape `itx.workers.get`
   *  takes (userspace code through the Worker Loader), and enabling appends a SUBSCRIPTION mount
   *  `itx.subscribers.<slug> → itx.facets.get('<slug>')` that the commit pump drives. A processor
   *  is just a subscription to a facet. Ref-less enables a built-in processor by slug. */
  enableProcessor(
    slug: string,
    ref?: { source: string | Expression; className: string },
  ): Promise<{ ok: true }> {
    return this.#host.enableProcessor(slug, ref);
  }

  disableProcessor(slug: string): Promise<{ ok: true }> {
    return this.#host.disableProcessor(slug);
  }

  /** A facet processor's reduce — sugar over the facet ADDRESS (`itx.facets.get(slug).snapshot()`
   *  through the routing table; aliasable and shadowable like any other capability). */
  facetSnapshot(slug: string): Promise<{ offset: number; state: unknown }> {
    return this.#host.invoke(["itx", "facets", ["get", slug], ["snapshot"]]) as Promise<{
      offset: number;
      state: unknown;
    }>;
  }

  /** Subscribe — sugar for a subscription mount at `itx.subscribers.<name>`. How it is SERVED
   *  depends only on the target's shape (see DeliveryPolicy in core/events.ts):
   *    • a LIVE CALLBACK (any capnweb function/RpcTarget): parked as an anonymous ItxConnection,
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
    // SUBSCRIBING IS PROVIDING — pure edge sugar: a unique name (concurrent anonymous
    // subscribes must never shadow each other), park if the target is a live callback, then
    // ONE ordinary mount at itx.subscribers.<name> with the delivery policy riding the event.
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    const { name: _n, target: rawTarget, ...delivery } = input;
    const target =
      typeof rawTarget === "function" ||
      (typeof rawTarget === "object" && !Array.isArray(rawTarget))
        ? (await this.#parkAsTarget(rawTarget as RetainedProviderStub, `subscriber ${name}`)).target
        : (rawTarget as string | Expression);
    const { providedAtOffset } = await this.#host.provideCapability({
      path: `itx.subscribers.${name}`,
      target,
      delivery,
    });
    return { name, providedAtOffset };
  }

  async unsubscribe(input: { name: string }): Promise<void> {
    await this.#host.revokeCapability({ path: `itx.subscribers.${input.name}` });
  }

  /** PARK + NAME, the edge's one two-step: attach an ANONYMOUS ItxConnection (the DO appends the
   *  ephemeral connection-opened fact whose offset IS the connectionId), retain the live capnweb
   *  callback in a CapnwebCallbackRelay, and answer the target expression that names it. Every
   *  live thing enters the durable world through here. */
  async #parkAsTarget(
    provider: RetainedProviderStub,
    description: string,
  ): Promise<{ connectionId: string; relay: CapnwebCallbackRelay; target: string }> {
    const { connectionId } = await this.#host.attachItxConnection({ description });
    const relay = await startCapnwebCallbackRelay(
      this.#host,
      provider,
      connectionId,
      this.#waitUntil,
    );
    this.#relays.add(relay);
    // Build the target via print() of a structured expression, NOT string interpolation: print()
    // quote-escapes the id, so this stays injection-safe when a connectionId is not a plain numeric
    // offset (off-platform / future ids). Canonical form is identical for today's numeric ids.
    const target = print(["itx", "connections", ["get", connectionId]]);
    return { connectionId, relay, target };
  }

  /** Recovery from a forwarder HALT (or an operator cursor seek) — absent targets only;
   *  connected targets have no server cursor to move. */
  resumeSubscription(input: { name: string; afterOffset?: number }): Promise<{ ok: true }> {
    return this.#host.resumeSubscription(input);
  }

  /** Provide an ADDITIONAL live capability (beyond the connections view every attached client
   *  already appears in): PARK the stub as an anonymous ItxConnection (transport), then MOUNT
   *  the alias `path ⇒ itx.connections.get(connectionId)` (an ordinary capability-table row,
   *  shadowable/revocable, auto-revoked when the connection closes). */
  async provideCapability(input: ProvideLiveInput): Promise<CapabilityProvision> {
    const parked = await this.#parkAsTarget(
      input.capability as RetainedProviderStub,
      input.instructions ?? "",
    );
    const { providedAtOffset } = await this.#host.provideCapability({
      path: ["itx", ...input.path],
      target: parked.target,
    });
    return new CapabilityProvision(
      this.#host,
      providedAtOffset,
      parked.connectionId,
      parked.relay,
      this.#relays,
    );
  }
}

// THE NATURAL DOTTED SURFACE. Insert the dynamic-capability fallback into `Itx.prototype`'s chain
// so an unknown segment (`itx.slack`, `itx.kv`, `itx.connections`) becomes an accumulated
// invokeCapability dispatch, while the declared methods above (invoke / provide / subscribe / …)
// always win. The default invokerFor is the instance itself — `Itx.invokeCapability({ path, args })`
// is exactly the door the path proxy calls. Runs once at module load, after the class body. See
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
  return new Itx(host, new Set<CapnwebCallbackRelay>(), waitUntil);
}

/** Ownership handle for one `itx.provideCapability()`. */
class CapabilityProvision extends RpcTarget {
  readonly #host: ItxHostStub;
  readonly #providedAtOffset: number;
  readonly #connectionId: string;
  readonly #relay: CapnwebCallbackRelay;
  readonly #relays: Set<CapnwebCallbackRelay>;
  constructor(
    host: ItxHostStub,
    providedAtOffset: number,
    connectionId: string,
    relay: CapnwebCallbackRelay,
    relays: Set<CapnwebCallbackRelay>,
  ) {
    super();
    this.#host = host;
    this.#providedAtOffset = providedAtOffset;
    this.#connectionId = connectionId;
    this.#relay = relay;
    this.#relays = relays;
  }
  /** Pop exactly this mount off the shadow stack (whatever it shadowed is restored). The DO's
   *  reap is the SOLE authority on closing the parked connection — it keeps a connection alive
   *  if a SECOND mount still names it — so tear down the edge relay ONLY when the reap actually
   *  closed our connection (else another mount is still delivering to it). */
  async revoke(): Promise<void> {
    const { reapedConnectionId } = await this.#host.revokeCapability({
      providedAtOffset: this.#providedAtOffset,
    });
    if (reapedConnectionId === this.#connectionId) {
      this.#relays.delete(this.#relay);
      this.#relay.dispose();
    }
  }
  /** THE capnweb disposal contract: `using provision = await itx.provideCapability(...)` must
   *  revoke the mount at scope exit. Without this, disposing the handle drops only the wire stub
   *  and the mount + parked connection + relay leak until the whole session dies. */
  [(Symbol as { dispose?: symbol }).dispose ?? Symbol.for("dispose")](): void {
    void this.revoke().catch(() => undefined);
  }
}
