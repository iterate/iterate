// core/itx-surface.ts — the client-facing capnweb surface + the stateless RELAY. This is the ONE place capnweb
// terminates (the `/api` worker); it reaches the StreamDurableObject only over Workers RPC (the hard rule).
//
// A client dials `/api` and gets a `ProjectSession`:
//   • `get()`     → the project `Itx` (the iterate-context stub). Pure addressing.
//   • `connect({ path, description, capabilities?, connectionKey? })` → the `Itx`, PLUS presence: the client is
//     registered at `path`, and its live `capabilities` are provided (fanned out via `itx.clients`). "get +
//     presence." Every connected client provides capabilities by connecting; `itx.provideCapability` adds more.
//
// DON'T-PIN: the client's `capabilities` stub is retained HERE, in this stateless worker (the relay). The relay
// opens a Hibernatable Pager to the DO and records only `{ socketId }`. On a "wake" Page it hands the DO a short
// Invoker leg for one burst; the DO drops it at quiescence. So the DO holds no stub and hibernates while idle.

import { RpcTarget } from "capnweb";
import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import type { DeliveryPolicy } from "./events.ts";
import type { Expression } from "./expression.ts";
import { openDeliveryWebSocket, parseDeliveryMessage } from "./delivery-websocket.ts";
import { disposeStub } from "./itx-connection-registry.ts";
import { canonicalName } from "./names.ts";
import type { StreamDurableObject } from "../stream-durable-object.ts";

type ItxHostStub = DurableObjectStub<StreamDurableObject>;

/** A retained provider stub (capnweb) from the client. `.dup()` keeps it past the connect/provide call; other
 *  keys are its (remote) methods, resolving back on the client. */
type ProviderStub = { dup(): ProviderStub; [k: string]: unknown };

/** A live `.connect` / `provideCapability` input (the capnweb `capabilities`/`capability` half). */
export interface ConnectOpts {
  path: string;
  description?: string;
  capabilities?: ProviderStub;
  connectionKey?: string;
}
export interface ProvideLiveInput {
  type: "live";
  path: string[];
  capability: ProviderStub;
  instructions?: string;
}

/** The per-burst borrowed Workers-RPC leg: wraps the RETAINED CAPNWEB CALLBACK STUB and forwards
 *  `invoke(capPath, args)` onto it (a DIRECT dotted dispatch — never `.apply`), so a call from the
 *  stream reaches the client's actual function over the capnweb WebSocket. */
class RetainedCallbackInvoker extends WorkersRpcTarget {
  #provider: ProviderStub;
  constructor(provider: ProviderStub) {
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

/** One CAPNWEB CALLBACK RELAY: the retained capnweb callback stub + the hibernatable delivery
 *  WebSocket into one stream DO + per-burst RetainedCallbackInvoker legs on demand. One relay per
 *  (client thing, stream) pair; a client's capnweb WebSocket carries many. */
interface CapnwebCallbackRelay {
  socketId: string;
  dispose(): void;
}

/** Start a relay: dup the provider stub, open the delivery WebSocket to the stream DO, and wire
 *  "wake" messages → hand the DO a short RetainedCallbackInvoker leg. */
async function startCapnwebCallbackRelay(
  host: ItxHostStub,
  provider: ProviderStub,
  socketId: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<CapnwebCallbackRelay> {
  const retained = provider.dup();
  const pager = await openDeliveryWebSocket(host, socketId);
  const disposeRetained = () => disposeStub(retained);
  // The library's own death signal: the client's capnweb session broke → the retained provider
  // can never answer again. Close the pager NOW so the DO reaps the parked stub immediately —
  // without this the roster lies until an invoke hits the 10s attach timeout.
  (retained as { onRpcBroken?: (cb: () => void) => void }).onRpcBroken?.(() => {
    try {
      pager.close(1000, "provider session broke");
    } catch {
      /* already closing */
    }
  });
  pager.addEventListener("message", (event: MessageEvent) => {
    const page = parseDeliveryMessage(event.data);
    if (!page) return; // not a Page — a "wake" is the only page there is
    waitUntil(
      host
        .activateStub({ socketId, invoker: new RetainedCallbackInvoker(retained) })
        .catch(() => undefined), // a stale wake (nobody waiting) returns undefined; offline throws — ignore
    );
  });
  pager.addEventListener("close", disposeRetained);
  return {
    socketId,
    dispose: () => {
      try {
        pager.close(1000, "relay disposed");
      } catch {
        /* already closing */
      }
      disposeRetained();
    },
  };
}

/** `session` at `/api` (bound to one projectId). `get`/`connect` both yield the project `Itx`. */
export class ProjectSession extends RpcTarget {
  readonly #host: ItxHostStub;
  readonly #relays = new Set<CapnwebCallbackRelay>(); // held for the session so the retained providers + Pagers aren't GC'd
  readonly #waitUntil: (p: Promise<unknown>) => void;

  constructor(
    hostNamespace: DurableObjectNamespace<StreamDurableObject>,
    projectId: string,
    ctx: ExecutionContext,
  ) {
    super();
    this.#host = hostNamespace.getByName(canonicalName(projectId));
    this.#waitUntil = (p) => ctx.waitUntil(p);
  }

  /** capnweb invokes this when the client's /api session ends: tear every relay down so the
   *  DO-side parked stubs die with their session instead of lying in the roster. */
  // Symbol.dispose referenced defensively (lib target predates it) — same trick as disposeStub.
  [(Symbol as { dispose?: symbol }).dispose ?? Symbol.for("dispose")](): void {
    for (const relay of this.#relays) relay.dispose();
    this.#relays.clear();
  }

  /** THE introduction door (the `authenticate()` pattern: the only way to get an authenticated
   *  session is to be handed one by a gate that checked something). Deliberately a NO-OP today —
   *  the clean room's `?ctx=` front door is designation-without-introduction scafreducing, and
   *  this method is where the real check lands without changing any caller: clients already go
   *  `session.authenticate(credentials).get()` / `.connect(...)`. */
  authenticate(_credentials?: unknown): ProjectSession {
    return this;
  }

  /** Pure addressing → the iterate-context stub. */
  get(): Itx {
    return new Itx(this.#host, this.#relays, this.#waitUntil);
  }

  /** get + presence: register a CLIENT at `path` carrying live `capabilities`, then return the itx. */
  async connect(opts: ConnectOpts): Promise<Itx> {
    if (opts.capabilities) {
      const socketId = crypto.randomUUID();
      const connectionKey = opts.connectionKey ?? socketId;
      const relay = await startCapnwebCallbackRelay(
        this.#host,
        opts.capabilities,
        socketId,
        this.#waitUntil,
      );
      this.#relays.add(relay);
      await this.#host.parkClient({
        socketId,
        path: opts.path,
        connectionKey,
        description: opts.description,
      });
    }
    return new Itx(this.#host, this.#relays, this.#waitUntil);
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

  /** The client roster + fan-out door. */
  get clients(): ClientCollection {
    return new ClientCollection(this.#host);
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
  revoke(input: { providedAtOffset?: number; path?: string | string[] }): Promise<void> {
    return this.#host.revokeCapability(input);
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

  /** Subscribe — a PUSH subscription (stream-held cursor + retry/skip/halt): the stream calls
   *  `target`'s terminal path segment with `(events, window)` per durable batch — for consumers
   *  that cannot hold a cursor (webhooks, stateless `processEvent`-style workers). `target` may
   *  be an itx expression — or a LIVE CALLBACK (any capnweb function/RpcTarget): the sugar
   *  parks it via the ordinary live-capability machinery and targets the parked stub. Add
   *  `liveState: {key}` for state mode: no cursor, no ladder — the target receives each of the
   *  key's change payloads `{key, from, to, patch}` as it commits; the CLIENT chains revisions
   *  (seed through the producer's own door, re-read it on any gap). */
  async subscribe(
    input: DeliveryPolicy & {
      name?: string;
      target: string | Expression | ((...args: never[]) => unknown) | object;
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
        ? (await this.#parkAsTarget(rawTarget as unknown as ProviderStub, `subscriber ${name}`))
            .target
        : (rawTarget as string | Expression);
    const { providedAtOffset } = await this.#host.provideCapability({
      path: `itx.subscribers.${name}`,
      target,
      delivery,
    });
    return { name, providedAtOffset };
  }

  unsubscribe(input: { name: string }): Promise<void> {
    return this.#host.revokeCapability({ path: `itx.subscribers.${input.name}` });
  }

  /** PARK + NAME, the edge's one two-step: retain the live capnweb callback in a
   *  CapnwebCallbackRelay (its delivery WebSocket parks on the stream DO), and answer the
   *  target expression that names it. Every live thing enters the durable world through here. */
  async #parkAsTarget(
    provider: ProviderStub,
    description: string,
  ): Promise<{ socketId: string; relay: CapnwebCallbackRelay; target: string }> {
    const socketId = crypto.randomUUID();
    const relay = await startCapnwebCallbackRelay(this.#host, provider, socketId, this.#waitUntil);
    this.#relays.add(relay);
    await this.#host.parkCapability({ socketId, description });
    return { socketId, relay, target: `itx.clients.get('${socketId}')` };
  }

  /** Recovery from HALT (or an operator cursor seek). */
  resumeSubscription(input: { name: string; afterOffset?: number }): Promise<{ ok: true }> {
    return this.#host.resumeSubscription(input);
  }

  /** Provide an ADDITIONAL live capability (beyond the ones a client provides by connecting).
   *  The R13 desugar, done here in two calls: PARK the stub (transport), then MOUNT the alias
   *  `pattern ⇒ itx.clients.get(socketId)` (an ordinary routing-table row, shadowable/revocable). */
  async provideCapability(input: ProvideLiveInput): Promise<CapabilityProvision> {
    if (input.type !== "live")
      throw new Error("itx.provideCapability here only mounts live capabilities");
    const parked = await this.#parkAsTarget(input.capability, input.instructions ?? "");
    const { providedAtOffset } = await this.#host.provideCapability({
      path: ["itx", ...input.path],
      target: parked.target,
    });
    return new CapabilityProvision(
      this.#host,
      providedAtOffset,
      parked.socketId,
      parked.relay,
      this.#relays,
    );
  }
}

/** `itx.clients`. */
export class ClientCollection extends RpcTarget {
  readonly #host: ItxHostStub;
  constructor(host: ItxHostStub) {
    super();
    this.#host = host;
  }
  get(path: string): Client {
    return new Client(this.#host, path);
  }
  list(): Promise<unknown[]> {
    return this.#host.invoke(["itx", "clients", ["list"]]) as Promise<unknown[]>;
  }
}

/** `itx.clients.get(path)`. `.capabilities.a.b(x)` is client-side sugar for `invokeCapability({path,args})`. */
export class Client extends RpcTarget {
  readonly #host: ItxHostStub;
  readonly #path: string;
  constructor(host: ItxHostStub, path: string) {
    super();
    this.#host = host;
    this.#path = path;
  }
  connections(): Promise<unknown[]> {
    return this.#host.invoke(["itx", "clients", ["connections", this.#path]]) as Promise<unknown[]>;
  }
  /** FAN OUT over every open connection at this path (allSettled; `[]` if none). */
  invokeCapability(input: { path: string[]; args?: unknown[] }): Promise<unknown[]> {
    return this.#host.invoke([
      "itx",
      "clients",
      ["at", this.#path],
      ["call", input.path, input.args ?? []],
    ]) as Promise<unknown[]>;
  }
}

/** Ownership handle for one `itx.provideCapability()`. */
export class CapabilityProvision extends RpcTarget {
  readonly #host: ItxHostStub;
  readonly #providedAtOffset: number;
  readonly #socketId: string;
  readonly #relay: CapnwebCallbackRelay;
  readonly #relays: Set<CapnwebCallbackRelay>;
  constructor(
    host: ItxHostStub,
    providedAtOffset: number,
    socketId: string,
    relay: CapnwebCallbackRelay,
    relays: Set<CapnwebCallbackRelay>,
  ) {
    super();
    this.#host = host;
    this.#providedAtOffset = providedAtOffset;
    this.#socketId = socketId;
    this.#relay = relay;
    this.#relays = relays;
  }
  /** Pop exactly this mount off the shadow stack (whatever it shadowed is restored) + drop the
   *  parked stub. */
  async revoke(): Promise<void> {
    this.#relays.delete(this.#relay);
    await this.#host.revokeCapability({ providedAtOffset: this.#providedAtOffset });
    await this.#host.dropStub({ socketId: this.#socketId });
    this.#relay.dispose();
  }
}
