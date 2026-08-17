// core/itx-surface.ts — the client-facing capnweb surface + the stateless RELAY. This is the ONE place capnweb
// terminates (the `/api` worker); it reaches the ItxDurableObject only over Workers RPC (the hard rule).
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
import { openPager, parsePage } from "./hibernatable-pager.ts";
import { canonicalName } from "./names.ts";
import type { ItxDurableObject } from "../itx-durable-object.ts";

type ItxHostStub = DurableObjectStub<ItxDurableObject>;

// `Symbol.dispose` isn't in the current lib target; reference it defensively to free a capnweb stub.
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
function disposeStub(stub: unknown): void {
  const fn = DISPOSE ? (stub as Record<symbol, unknown>)[DISPOSE] : undefined;
  if (typeof fn === "function") (fn as () => void).call(stub);
}

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

/** The short Workers-RPC leg the DO calls during a burst: forwards `invoke(capPath, args)` onto the retained
 *  capnweb provider (a DIRECT dotted dispatch, like a facet call — never `.apply`), so it reaches the client. */
class Invoker extends WorkersRpcTarget {
  #provider: ProviderStub;
  constructor(provider: ProviderStub) {
    super();
    this.#provider = provider;
  }
  async invoke(capPath: string[], args: unknown[]): Promise<unknown> {
    let recv = this.#provider as unknown as Record<string, unknown>;
    for (let i = 0; i < capPath.length - 1; i++) recv = recv[capPath[i]] as Record<string, unknown>;
    return await (recv[capPath[capPath.length - 1]] as (...a: unknown[]) => unknown)(...args);
  }
}

/** One retained provider + its Pager. Answers "wake" Pages with a fresh Invoker leg into the DO. */
interface Relay {
  socketId: string;
  dispose(): void;
}

/** Start a relay: dup the provider, open a Pager to the DO, and wire "wake" → hand the DO a short Invoker. */
async function startRelay(
  host: ItxHostStub,
  provider: ProviderStub,
  socketId: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Relay> {
  const retained = provider.dup();
  const pager = await openPager(host, socketId);
  const disposeRetained = () => disposeStub(retained);
  pager.addEventListener("message", (event: MessageEvent) => {
    const page = parsePage(event.data);
    if (page?.type !== "wake") return; // "idle" → the DO dropped its leg; keep the provider for the next wake
    waitUntil(
      host.activateStub({ socketId, invoker: new Invoker(retained) }).catch(() => undefined), // a stale wake (nobody waiting) returns undefined; offline throws — ignore
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
  readonly #relays = new Set<Relay>(); // held for the session so the retained providers + Pagers aren't GC'd
  readonly #waitUntil: (p: Promise<unknown>) => void;

  constructor(
    hostNamespace: DurableObjectNamespace<ItxDurableObject>,
    projectId: string,
    ctx: ExecutionContext,
  ) {
    super();
    this.#host = hostNamespace.getByName(canonicalName(projectId));
    this.#waitUntil = (p) => ctx.waitUntil(p);
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
      const relay = await startRelay(this.#host, opts.capabilities, socketId, this.#waitUntil);
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
  readonly #relays: Set<Relay>;
  readonly #waitUntil: (p: Promise<unknown>) => void;

  constructor(host: ItxHostStub, relays: Set<Relay>, waitUntil: (p: Promise<unknown>) => void) {
    super();
    this.#host = host;
    this.#relays = relays;
    this.#waitUntil = waitUntil;
  }

  whoami(): Promise<unknown> {
    return this.#host.invokeCapability("itx.whoami", []);
  }

  /** The universal dispatch door (built-ins + provided capabilities). `itx.a.b(x)` is client-side sugar for
   *  `invokeCapability({ path: ["a", "b"], args: [x] })`. */
  invokeCapability(input: { path: string[]; args?: unknown[] }): Promise<unknown> {
    return this.#host.invokeCapability(`itx.${input.path.join(".")}`, input.args ?? []);
  }

  /** The client roster + fan-out door. */
  get clients(): ClientCollection {
    return new ClientCollection(this.#host);
  }

  /** Provide an ADDITIONAL live capability (beyond the ones a client provides by connecting). */
  async provideCapability(input: ProvideLiveInput): Promise<CapabilityProvision> {
    if (input.type !== "live")
      throw new Error("itx.provideCapability here only mounts live capabilities");
    const socketId = crypto.randomUUID();
    const capPath = `itx.${input.path.join(".")}`;
    const relay = await startRelay(this.#host, input.capability, socketId, this.#waitUntil);
    this.#relays.add(relay);
    await this.#host.parkCapability({ socketId, capPath, description: input.instructions });
    return new CapabilityProvision(this.#host, capPath, relay, this.#relays);
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
    return this.#host.clientsList() as Promise<unknown[]>;
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
    return this.#host.clientConnections(this.#path) as Promise<unknown[]>;
  }
  /** FAN OUT over every open connection at this path (Promise.all; `[]` if none). */
  invokeCapability(input: { path: string[]; args?: unknown[] }): Promise<unknown[]> {
    return this.#host.invokeClientCapabilities(this.#path, input.path, input.args ?? []);
  }
  getConnection(connectionKey: string): ClientConnection {
    return new ClientConnection(this.#host, connectionKey);
  }
}

/** `itx.clients.get(path).getConnection(key)` — single-target. */
export class ClientConnection extends RpcTarget {
  readonly #host: ItxHostStub;
  readonly #connectionKey: string;
  constructor(host: ItxHostStub, connectionKey: string) {
    super();
    this.#host = host;
    this.#connectionKey = connectionKey;
  }
  invokeCapability(input: { path: string[]; args?: unknown[] }): Promise<unknown> {
    return this.#host.invokeClientCapability(this.#connectionKey, input.path, input.args ?? []);
  }
  close(): Promise<unknown> {
    return this.#host.closeClientConnection(this.#connectionKey) as Promise<unknown>;
  }
}

/** Ownership handle for one `itx.provideCapability()`. `__leaseActive()` is relay-local — it NEVER wakes the DO
 *  (a watchdog can poll it without defeating hibernation). */
export class CapabilityProvision extends RpcTarget {
  readonly #host: ItxHostStub;
  readonly #capPath: string;
  readonly #relay: Relay;
  readonly #relays: Set<Relay>;
  #active = true;
  constructor(host: ItxHostStub, capPath: string, relay: Relay, relays: Set<Relay>) {
    super();
    this.#host = host;
    this.#capPath = capPath;
    this.#relay = relay;
    this.#relays = relays;
  }
  __leaseActive(): boolean {
    return this.#active;
  }
  async revoke(): Promise<void> {
    this.#active = false;
    this.#relays.delete(this.#relay);
    await this.#host.dropCapability({ capPath: this.#capPath });
    this.#relay.dispose();
  }
}
