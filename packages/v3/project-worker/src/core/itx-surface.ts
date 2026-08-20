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

import { validateRpc } from "capnweb-validate";
import { RpcTarget, type RpcStub } from "capnweb";
import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import type { DeliveryPolicy } from "./events.ts";
import type { Expression } from "./expression.ts";
import { disposeStub, openStubPagerWebSocket } from "./hibernatable-rpc-stub.ts";
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

/** What `get()`/`connect()` hand back over the wire. The itx surface is an OPEN capability
 *  namespace — declared methods (invoke / provide / subscribe / …) coexisting with arbitrary
 *  dotted capability paths — so it crosses as an UNKNOWN-SURFACE STUB (capnweb `RpcStub<unknown>`):
 *  capnweb-validate leaves it un-allow-listed (its `isUnknownSurfaceStub`), which is the ONLY way
 *  the prototype-hop dotted fallback can dispatch (an enumerated `stubOf` allow-list refuses every
 *  undeclared method BEFORE the hop is reached). `Itx`'s OWN declared methods are still
 *  arg-validated in place by its `@validateRpc()` — that wrapping is independent of the return
 *  shape — so this trades ONLY the boundary allow-list, not method validation. See
 *  core/dotted-path-proxy.ts. */
type ItxStub = RpcStub<unknown>;

/** A `.connect` input: which context to attach to (default the root), the client-chosen
 *  connectionKey (reconnects under the same key share an ItxConnectionSession), and the live
 *  `capabilities` callback the connection offers. */
interface ConnectOpts {
  context?: string;
  connectionKey?: string;
  description?: string;
  capabilities?: ProviderStub;
}
interface ProvideLiveInput {
  type: "live";
  path: string[];
  capability: ProviderStub;
  instructions?: string;
}

/** The per-burst borrowed Workers-RPC leg: wraps the RETAINED CAPNWEB CALLBACK STUB and forwards
 *  `invoke(capPath, args)` onto it (a DIRECT dotted dispatch — never `.apply`), so a call from the
 *  stream reaches the client's actual function over the capnweb WebSocket. */
class RetainedCallbackInvoker extends WorkersRpcTarget {
  #provider: RetainedProviderStub;
  constructor(provider: RetainedProviderStub) {
    super();
    this.#provider = provider;
  }
  async invoke(capPath: string[], args: unknown[]): Promise<unknown> {
    // Empty path = the provider IS the callable (a bare callback parked as a capability).
    if (capPath.length === 0)
      return await (this.#provider as unknown as (...a: unknown[]) => unknown)(...args);
    let recv = this.#provider as unknown as Record<string, unknown>;
    for (let i = 0; i < capPath.length - 1; i++) recv = recv[capPath[i]] as Record<string, unknown>;
    return await (recv[capPath[capPath.length - 1]] as (...a: unknown[]) => unknown)(...args);
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
  // immediately — without this the currently-connected list lies until a page times out (10s).
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
@validateRpc()
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

  /** Pure addressing → the root context's itx (an open-surface stub — see ItxStub). */
  get(): ItxStub {
    return new Itx(this.#root, this.#relays, this.#waitUntil) as unknown as ItxStub;
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
   *  through the context's `connections` view (`itx.connections.get(connectionKey)`,
   *  `.each(...)` fan-out). Without, this is pure addressing into the named context. */
  async connect(opts: ConnectOpts = {}): Promise<ItxStub> {
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
    return new Itx(host, this.#relays, this.#waitUntil) as unknown as ItxStub;
  }
}

/** The iterate context (`itx`). Dotted capability calls + the built-in collections forward to the DO over
 *  Workers RPC. capnweb terminates upstream in `/api`, so a client stub `itx.a.b(x)` never touches the DO's
 *  transport — it lands here and becomes `DO.invokeCapability("itx.a.b", [x])`. */
@validateRpc()
class Itx extends RpcTarget {
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

  /** Enable a facet-hosted processor on this context's stream (the facet spine). With a `ref`
   *  the processor is USERSPACE code loaded through the Worker Loader (duck-typed contract:
   *  configure / deliver / snapshot). */
  enableProcessor(
    slug: string,
    ref?: { source: string | Expression; export: string },
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
    return { connectionId, relay, target: `itx.connections.get('${connectionId}')` };
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
    if (input.type !== "live")
      throw new Error("itx.provideCapability here only mounts live capabilities");
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
// is exactly the door the path proxy calls. Must run AFTER the class + its @validateRpc() decorator
// (which is why it lives here, not inside the body). See core/dotted-path-proxy.ts for the workerd
// brand-check reason this is a prototype hop and not a Proxy AROUND the instance.
installPrototypeInvokeCapabilityFallback(Itx);

/** Ownership handle for one `itx.provideCapability()`. */
@validateRpc()
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
