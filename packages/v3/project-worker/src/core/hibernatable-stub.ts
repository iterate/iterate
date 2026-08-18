// core/hibernatable-stub.ts — a hibernatable outbound RPC stub.
//
// A HibernatableStub is a reference to a provider that lives in a stateless relay, held by a Durable Object
// ACROSS hibernation. workerd has no native hibernatable outbound stub — retaining a real one pins the DO, which
// is the whole problem — so we emulate one: the DO keeps only a Hibernatable Pager (a socket) plus a small
// record in its attachment, NO stub, and materializes a real, short-lived RPC leg (an Invoker) on demand,
// dropping it the moment the call drains. Between calls the DO holds nothing but hibernatable sockets, so it
// hibernates while any number of providers stay connected.
//
// `HibernatableStubs` is the DO-side set of them, and it is provider-AGNOSTIC: a stub is just `{ socketId }` plus
// opaque meta the caller stamps (a capability path, a client connection, …). The caller reads that meta back via
// `all()` and decides what to invoke. The only durable state is the socket attachment, which survives
// hibernation — so a fresh DO incarnation reads its stubs straight back from the sockets, nothing to reconcile.

import {
  acceptPager,
  pagerAttachment,
  pagerSocketFor,
  pagerSockets,
  sendPage,
  stampPager,
} from "./hibernatable-pager.ts";

/** The short Workers-RPC leg the relay hands the DO on "wake": it forwards one invocation burst to the provider. */
export type Invoker = {
  invoke(path: string[], args: unknown[]): Promise<unknown>;
  dup?(): Invoker;
};

/** One parked stub: its `socketId` plus whatever meta the caller stamped (opaque to this module). */
export type Stub = { socketId: string; [meta: string]: unknown };

type Hooks = {
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  getWebSockets(tag: string): WebSocket[];
};

// `Symbol.dispose` isn't in the current lib target; reference it defensively to free a (Workers-RPC) leg.
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
function dispose(x: unknown): void {
  const f = DISPOSE ? (x as Record<symbol, unknown>)[DISPOSE] : undefined;
  if (typeof f === "function") (f as () => void).call(x);
}

const ATTACH_TIMEOUT_MS = 10_000; // a woken relay has this long to hand back its short leg before we give up

export class HibernatableStubs {
  readonly #hooks: Hooks;
  // In-memory, mid-call ONLY: a live leg exists during a burst; a wake is pending until the relay attaches. Both
  // empty ⇒ the DO holds no stub ⇒ it hibernates (the surviving Pager sockets carry every parked stub).
  #legs = new Map<string, { invoker: Invoker; inFlight: number }>();
  // One entry per socket awaiting its wake; CONCURRENT cold invokes share it (`arrived`) —
  // a second borrower must never replace the first's resolver (it would hang forever).
  #pending = new Map<
    string,
    {
      resolve(): void;
      reject(e: Error): void;
      timer: ReturnType<typeof setTimeout>;
      arrived: Promise<void>;
    }
  >();

  constructor(hooks: Hooks) {
    this.#hooks = hooks;
  }

  /** DO `fetch`: the relay's Pager upgrade. */
  accept(request: Request): Response {
    return acceptPager(request, this.#hooks);
  }

  /** Park a stub: stamp its meta onto the (already-open) Pager socket, so it survives hibernation. */
  park(socketId: string, meta: Record<string, unknown>): void {
    const ws = pagerSocketFor(socketId, this.#hooks);
    if (ws === undefined) throw new Error("hibernatable stub has no pager socket");
    stampPager(ws, { socketId, ...meta });
  }

  /** Every parked stub — DERIVED from the surviving Pager sockets, so there's nothing to reconcile after a wake. */
  all(): Stub[] {
    return pagerSockets(this.#hooks)
      .map((ws) => pagerAttachment(ws) as Stub | undefined)
      .filter((s): s is Stub => s !== undefined && Object.keys(s).length > 1);
  }

  /** Invoke a parked stub on demand: wake it, borrow a short leg for the burst, silently drop it at quiescence
   *  (the relay keeps its retained provider for the next wake — no page needed). */
  async invoke(socketId: string, path: string[], args: unknown[]): Promise<unknown> {
    const leg = await this.#borrow(socketId);
    try {
      return await leg.invoker.invoke(path, args);
    } finally {
      if (--leg.inFlight === 0 && this.#legs.get(socketId) === leg) {
        this.#legs.delete(socketId);
        dispose(leg.invoker);
      }
    }
  }

  /** The relay's answer to a "wake": it hands us its short leg. Returns undefined for a stale wake (none pending). */
  activate(input: { socketId: string; invoker: Invoker }): { ok: true } | undefined {
    const pending = this.#pending.get(input.socketId);
    if (pending === undefined) return undefined;
    const prev = this.#legs.get(input.socketId);
    this.#legs.set(input.socketId, {
      invoker: input.invoker.dup?.() ?? input.invoker,
      inFlight: 0,
    });
    if (prev) dispose(prev.invoker);
    clearTimeout(pending.timer);
    this.#pending.delete(input.socketId);
    pending.resolve();
    return { ok: true };
  }

  /** Close a stub's Pager (revoke / kick / replace) and forget it. */
  drop(socketId: string, reason: string): void {
    const ws = pagerSocketFor(socketId, this.#hooks);
    if (ws)
      try {
        ws.close(1000, reason);
      } catch {
        /* already closing */
      }
    this.#forget(socketId);
  }

  /** A Pager socket closed — the stub is gone with it; just clean up any in-memory leg. */
  closed(ws: WebSocket): void {
    const s = pagerAttachment(ws);
    if (s) this.#forget(s.socketId);
  }

  /** Observability: `dormant` ⇒ no leg held (the DO can hibernate while stubs stay parked). */
  state(): Record<string, unknown> {
    return {
      stubs: this.all().length,
      active: this.#legs.size,
      pending: this.#pending.size,
      dormant: this.#legs.size === 0 && this.#pending.size === 0,
    };
  }

  async #borrow(socketId: string): Promise<{ invoker: Invoker; inFlight: number }> {
    let leg = this.#legs.get(socketId);
    if (leg === undefined) {
      const ws = pagerSocketFor(socketId, this.#hooks);
      if (ws === undefined) throw new Error("hibernatable stub offline (no pager)");
      let pending = this.#pending.get(socketId);
      if (pending === undefined) {
        let resolve!: () => void;
        let reject!: (e: Error) => void;
        const arrived = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
        const timer = setTimeout(() => {
          if (this.#pending.delete(socketId)) reject(new Error("provider attach timed out"));
        }, ATTACH_TIMEOUT_MS);
        pending = { resolve, reject, timer, arrived };
        this.#pending.set(socketId, pending);
        sendPage(ws, { type: "wake" });
      }
      await pending.arrived;
      leg = this.#legs.get(socketId);
      if (leg === undefined) throw new Error("provider attach completed empty");
    }
    leg.inFlight += 1;
    return leg;
  }

  #forget(socketId: string): void {
    const leg = this.#legs.get(socketId);
    if (leg) {
      this.#legs.delete(socketId);
      dispose(leg.invoker);
    }
    const p = this.#pending.get(socketId);
    if (p) {
      clearTimeout(p.timer);
      this.#pending.delete(socketId);
      p.reject(new Error("provider went offline"));
    }
  }
}
