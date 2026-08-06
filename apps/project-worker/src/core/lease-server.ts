// core/lease-server.ts — the DON'T-PIN lease server (mirrors dont-pin-capability-host's LiveCapabilityLeaseServer).
//
// A live capability's provider lives in a stateless relay; the DO reaches it only over a Hibernatable Pager. This
// owns that mechanism so the ItxDurableObject stays a thin dispatcher. Two invariants make it hibernation-safe:
//   • the ONLY per-lease durable state is the Pager socket's ATTACHMENT (a LeaseRecord). It survives hibernation,
//     so leases are simply DERIVED from the surviving sockets — there is no in-memory table to reconcile.
//   • the DO holds a live Invoker leg ONLY during an in-flight burst (`#activeLegs`); between bursts it holds
//     nothing but hibernatable sockets, so 1000 idle clients cost ~nothing and the DO hibernates.

import {
  acceptPager,
  pagerAttachment,
  pagerSocketFor,
  pagerSockets,
  sendPage,
  stampPager,
  type PagerRecord,
} from "./hibernatable-pager.ts";

/** A short Workers-RPC leg the relay hands the DO on "wake": wraps the retained provider and forwards one burst. */
export type Invoker = {
  invoke(capPath: string[], args: unknown[]): Promise<unknown>;
  dup?(): Invoker;
};

// `Symbol.dispose` isn't in the current lib target; reference it defensively to free a (Workers-RPC) leg.
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
function disposeStub(stub: unknown): void {
  const fn = DISPOSE ? (stub as Record<symbol, unknown>)[DISPOSE] : undefined;
  if (typeof fn === "function") (fn as () => void).call(stub);
}

const ATTACH_TIMEOUT_MS = 10_000; // a woken relay has this long to hand back its short leg before we give up

/** A live-capability lease, carried in its Pager socket's attachment (so it survives hibernation). `kind`:
 *   • "capability" — an `itx.provideCapability({type:"live"})` mount at the dotted `capPath`.
 *   • "client"     — a `.connect` client connection at `path` (fanned out via `itx.clients`). */
export interface LeaseRecord extends PagerRecord {
  kind: "capability" | "client";
  capPath?: string;
  path?: string;
  connectionKey?: string;
  description?: string;
  openedAt: string;
}

type Hooks = {
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  getWebSockets(tag: string): WebSocket[];
};

export class LeaseServer {
  readonly #hooks: Hooks;
  // In-memory, mid-call ONLY: a live leg exists during a burst; a wake handshake is pending until the relay
  // attaches. Both empty ⇒ the DO holds no stub ⇒ it can hibernate (the surviving Pager sockets carry the leases).
  #activeLegs = new Map<string, { invoker: Invoker; inFlight: number }>();
  #pending = new Map<
    string,
    { resolve(): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(hooks: Hooks) {
    this.#hooks = hooks;
  }

  /** DO `fetch`: the relay's Pager upgrade. */
  acceptUpgrade(request: Request): Response {
    return acceptPager(request, this.#hooks);
  }

  // ── records (stamped into the surviving Pager attachment) ──

  recordCapability(input: { socketId: string; capPath: string; description?: string }): {
    ok: true;
  } {
    this.#stamp(input.socketId, {
      kind: "capability",
      capPath: input.capPath,
      description: input.description,
    });
    return { ok: true };
  }

  /** Reconnect under the same path+connectionKey replaces the dead predecessor (the 0..1 shape a device wants). */
  recordClient(input: {
    socketId: string;
    path: string;
    connectionKey: string;
    description?: string;
  }): { ok: true; connectionKey: string } {
    for (const r of this.#records())
      if (
        r.kind === "client" &&
        r.path === input.path &&
        r.connectionKey === input.connectionKey &&
        r.socketId !== input.socketId
      )
        this.#closePager(r.socketId, 1000, "replaced");
    this.#stamp(input.socketId, {
      kind: "client",
      path: input.path,
      connectionKey: input.connectionKey,
      description: input.description,
    });
    return { ok: true, connectionKey: input.connectionKey };
  }

  // ── reads (DERIVED from the surviving Pager sockets — nothing to reconcile after hibernation) ──

  #records(): LeaseRecord[] {
    return pagerSockets(this.#hooks)
      .map((ws) => pagerAttachment(ws))
      .filter((a): a is LeaseRecord => a !== undefined && (a as LeaseRecord).kind !== undefined);
  }

  /** Longest dotted-prefix live CAPABILITY lease; the remaining segment(s) name the provider method. */
  liveLeaseFor(callPath: string): { socketId: string; method: string[] } | null {
    const parts = callPath.split(".");
    for (let i = parts.length - 1; i >= 2; i--) {
      const prefix = parts.slice(0, i).join(".");
      for (const r of this.#records())
        if (r.kind === "capability" && r.capPath === prefix)
          return { socketId: r.socketId, method: parts.slice(i) };
    }
    return null;
  }

  clientsList(): unknown[] {
    const byPath = new Map<string, LeaseRecord[]>();
    for (const r of this.#records())
      if (r.kind === "client" && r.path !== undefined) {
        const list = byPath.get(r.path) ?? [];
        list.push(r);
        byPath.set(r.path, list);
      }
    return [...byPath.entries()].map(([path, list]) => ({
      path,
      description: list[list.length - 1]?.description ?? null,
      connections: list.length,
      hasCapabilities: true,
    }));
  }

  clientConnections(path: string): unknown[] {
    return this.#records()
      .filter((r) => r.kind === "client" && r.path === path)
      .map((r) => ({
        connectionKey: r.connectionKey,
        description: r.description,
        openedAt: r.openedAt,
        hasCapabilities: true,
      }));
  }

  // ── invoke via an on-demand short leg (the don't-pin core) ──

  /** Wake handshake: the woken relay hands us its short leg. Returns undefined for a STALE wake (none pending). */
  activate(input: { socketId: string; invoker: Invoker }): { ok: true } | undefined {
    const pending = this.#pending.get(input.socketId);
    if (pending === undefined) return undefined;
    const prev = this.#activeLegs.get(input.socketId);
    const invoker = input.invoker.dup?.() ?? input.invoker; // retain past this call; disposed at quiescence
    this.#activeLegs.set(input.socketId, { invoker, inFlight: 0 });
    if (prev) disposeStub(prev.invoker);
    clearTimeout(pending.timer);
    this.#pending.delete(input.socketId);
    pending.resolve();
    return { ok: true };
  }

  /** Invoke through an on-demand leg (wake if needed), release it at quiescence ("idle" so the relay drops it). */
  async invokeVia(socketId: string, capPath: string[], args: unknown[]): Promise<unknown> {
    const leg = await this.#acquire(socketId);
    try {
      return await leg.invoker.invoke(capPath, args);
    } finally {
      leg.inFlight -= 1;
      if (leg.inFlight === 0 && this.#activeLegs.get(socketId) === leg) {
        this.#activeLegs.delete(socketId);
        disposeStub(leg.invoker);
        const ws = pagerSocketFor(socketId, this.#hooks);
        if (ws) sendPage(ws, { type: "idle" });
      }
    }
  }

  /** FAN OUT over every open connection at a client `path` (Promise.all; `[]` if none). */
  invokeClientCapabilities(path: string, capPath: string[], args: unknown[]): Promise<unknown[]> {
    return Promise.all(
      this.#records()
        .filter((r) => r.kind === "client" && r.path === path)
        .map((r) => this.invokeVia(r.socketId, capPath, args)),
    );
  }

  invokeClientCapability(
    connectionKey: string,
    capPath: string[],
    args: unknown[],
  ): Promise<unknown> {
    const r = this.#records().find((x) => x.kind === "client" && x.connectionKey === connectionKey);
    if (r === undefined) throw new Error(`no client connection "${connectionKey}"`);
    return this.invokeVia(r.socketId, capPath, args);
  }

  // ── lifecycle ──

  revokeCapability(capPath: string): { ok: true } {
    for (const r of this.#records())
      if (r.kind === "capability" && r.capPath === capPath)
        this.#closePager(r.socketId, 1000, "revoked");
    return { ok: true };
  }

  closeClientConnection(connectionKey: string): { ok: true } {
    const r = this.#records().find((x) => x.kind === "client" && x.connectionKey === connectionKey);
    if (r) this.#closePager(r.socketId, 1000, "kicked");
    return { ok: true };
  }

  /** A Pager dropped (socket close/error) — the lease vanishes with the socket; just clean up in-memory legs. */
  pagerClosed(ws: WebSocket): void {
    const att = pagerAttachment(ws);
    if (att) this.#drop(att.socketId);
  }

  /** Observability: `dormant` ⇒ the DO holds no live leg (it can hibernate while clients stay connected). */
  state(): Record<string, unknown> {
    return {
      pagers: pagerSockets(this.#hooks).length,
      leases: this.#records().length,
      activeLegs: this.#activeLegs.size,
      pending: this.#pending.size,
      dormant: this.#activeLegs.size === 0 && this.#pending.size === 0,
    };
  }

  // ── internals ──

  async #acquire(socketId: string): Promise<{ invoker: Invoker; inFlight: number }> {
    let leg = this.#activeLegs.get(socketId);
    if (leg === undefined) {
      const ws = pagerSocketFor(socketId, this.#hooks);
      if (ws === undefined) throw new Error("live capability offline (no pager)");
      const arrived = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.#pending.delete(socketId)) reject(new Error("provider attach timed out"));
        }, ATTACH_TIMEOUT_MS);
        this.#pending.set(socketId, { resolve, reject, timer });
      });
      sendPage(ws, { type: "wake" });
      await arrived;
      leg = this.#activeLegs.get(socketId);
      if (leg === undefined) throw new Error("provider attach completed empty");
    }
    leg.inFlight += 1;
    return leg;
  }

  #stamp(socketId: string, fields: Omit<LeaseRecord, "socketId" | "openedAt">): void {
    const ws = pagerSocketFor(socketId, this.#hooks);
    if (ws === undefined) throw new Error("lease has no pager socket");
    stampPager(ws, { socketId, openedAt: new Date(Date.now()).toISOString(), ...fields });
  }

  #closePager(socketId: string, code: number, reason: string): void {
    const ws = pagerSocketFor(socketId, this.#hooks);
    if (ws)
      try {
        ws.close(code, reason);
      } catch {
        /* already closing */
      }
    this.#drop(socketId);
  }

  #drop(socketId: string): void {
    const leg = this.#activeLegs.get(socketId);
    if (leg) {
      this.#activeLegs.delete(socketId);
      disposeStub(leg.invoker);
    }
    const p = this.#pending.get(socketId);
    if (p) {
      clearTimeout(p.timer);
      this.#pending.delete(socketId);
      p.reject(new Error("provider went offline"));
    }
  }
}
