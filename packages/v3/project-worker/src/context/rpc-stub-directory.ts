// context/rpc-stub-directory.ts — THE RPC STUBS, DO side: the `itx.rpcStubs` built-in's backing
// table — physical, never event-sourced. Two layers, in the order the tutorial builds them:
//
//   LAYER 1 — THE BORROWED RPC STUBS. Anyone with a Workers-RPC route to this DO can LEND a stub
//   under an OPAQUE key (`lendRpcStub`); the DO keeps it BORROWED — every call on that key rides
//   it — and RETURNS it at its idle quiesce (`returnBorrowedRpcStubs`), because a DO holding a stub
//   is pinned awake and this DO must hibernate with any number of clients attached. A lender with no
//   pager (below) is one-shot: after the return the key is offline until someone lends again.
//
//   LAYER 2 — THE RPC-STUB PAGERS. A hibernatable WebSocket per key, opened by the stateless edge
//   relay (context/rpc-stub-relay.ts), carrying `{ transportId, rpcStubKey }` in its attachment and
//   nothing else. It is a standing offer: "I can lend this key back on demand". When a call finds
//   the key not borrowed, the DO sends `{type:"page"}` down the pager, the edge answers with
//   `lendRpcStub`, and layer 1 takes over. Between pages the DO holds only hibernatable sockets.
//
// `invokeRpcStub` IS the two layers as two `if`s: have we got it? call it · else is there a pager
// for it? page it · else RPC_STUB_OFFLINE.
//
// WHAT A STUB IS HERE: its KEY — an opaque string the lender picks (the edge's `provide` sugar uses
// the canonical rewrite match so a reconnect re-lends under the same key; the registry never parses
// it; connection metadata may attach to a pager record later). A TRANSPORT ID is per pager socket,
// so a NEW pager under an existing key can attach before the old one drops (the reconnect swap;
// the newest pager wins). PRESENCE (`listRpcStubKeys`) is the keys borrowed or pager-backed right now.
//
// Two-phase pager attach: `attachRpcStubPager` mints the transportId FIRST, then the relay opens the
// pager WebSocket carrying it; an unknown id 409s so a relay that outlived a DO restart re-attaches.

import type {
  RpcStubFetchServer,
  RpcStubFetchTransport,
  WebSocketHooks,
} from "../fetch/rpc-stub-fetch.ts";
import { codedError } from "../lib/errors.ts";
import type { ItxExpression } from "./expression.ts";

// ── the wire: what the relay (context/rpc-stub-relay.ts) speaks to this side ──

export const RPC_STUB_PAGER_WEBSOCKET_HEADER = "x-itx-rpc-stub-pager";
const RPC_STUB_PAGER_WEBSOCKET_TAG = "itx-rpc-stub-pager-websocket";
/** The pager keepalive pair — one shared definition for the edge sender and the DO's
 *  setWebSocketAutoResponse. DELIBERATELY distinctive literals: the auto-response is DO-WIDE
 *  (it also covers fetch-upgrade eyeball sockets), so a plain "ping" would silently hijack any
 *  client frame equal to it. */
export const RPC_STUB_PAGER_KEEPALIVE_REQUEST = "itx-pager-keepalive";
export const RPC_STUB_PAGER_KEEPALIVE_RESPONSE = "itx-pager-keepalive-ack";
/** How long a paged relay has to lend before this side calls it dead. The relay answers a page
 *  immediately, so 10 s is a dead relay, not a slow one. */
const RPC_STUB_PAGE_TIMEOUT_MS = 10_000;

/** WHAT THIS SIDE BORROWS: the Workers-RPC stub a lender hands over — TWO doors: `invoke(steps)`
 *  walks the itx-expression steps on the lender's live value (a DIRECT dotted dispatch — never
 *  `.apply`), and `fetch(upgradeId, steps, request)` is the rpc-stub fetch dial
 *  (fetch/rpc-stub-fetch.ts — dies with that module's WORKAROUND fence). */
export type BorrowedRpcStub = RpcStubFetchTransport & {
  invoke(itxExpressionSteps: ItxExpression): Promise<unknown>;
  dup?(): BorrowedRpcStub;
};

/** One pager socket's durable record — its attachment (survives hibernation). */
type RpcStubPagerRecord = { transportId: string; rpcStubKey: string };

/** THE one disposer for any RPC-ish stub (borrowed Workers-RPC legs here, the session's own capnweb
 *  stubs in rpc-stub-relay.ts): a no-op for anything that is not disposable. */
export function disposeRpcStub(x: unknown): void {
  (x as Partial<Disposable> | null)?.[Symbol.dispose]?.();
}

export class RpcStubDirectory {
  readonly #hooks: WebSocketHooks;
  /** PRESENCE as it changes: a key gained its (only) pager, or lost its last one. The DO turns these
   *  into the two ephemeral `rpc-stub/attached` / `rpc-stub/detached` events — live watchers see
   *  presence move; the log never claims a socket is open. A REPLACED pager (same key, new socket)
   *  is neither: the key never lost presence. */
  readonly #onPresence: (kind: "attached" | "detached", rpcStubKey: string) => void;
  /** The DO's rpc-stub fetch subsystem (fetch/rpc-stub-fetch.ts) — `invokeRpcStub` routes a
   *  terminal-fetch call into its serve(). */
  readonly #rpcStubFetch: RpcStubFetchServer;

  // LAYER 1 — the borrowed rpc stubs, by key, in memory ONLY and kept WARM: steady traffic pays ONE
  // page, then every delivery is a plain RPC call. Returned at the DO's idle quiesce — never per
  // call, never on a timer (a pending timer would itself pin the DO out of hibernation).
  readonly #borrowedRpcStubs = new Map<string, { stub: BorrowedRpcStub; inFlight: number }>();

  // LAYER 2 — the pagers. transportId → the reservation whose pager WebSocket hasn't arrived yet
  // (in memory on purpose: if the DO dies in between, the upgrade 409s and the relay re-attaches);
  // and, per key, the page awaiting its lend — CONCURRENT cold invokes share it (`arrived`), a
  // second caller must never replace the first's resolver (it would hang forever).
  readonly #pendingRpcStubPagerAttachments = new Map<string, { rpcStubKey: string }>();
  readonly #rpcStubPagesInFlight = new Map<
    string,
    {
      resolve(): void;
      reject(e: Error): void;
      timer: ReturnType<typeof setTimeout>;
      arrived: Promise<void>;
    }
  >();
  // Once per socket: workerd may deliver BOTH webSocketError and webSocketClose for one drop, and
  // the second must not report the pager (and its presence) as lost twice.
  readonly #closedRpcStubPagerSockets = new WeakSet<WebSocket>();

  constructor(deps: {
    hooks: WebSocketHooks;
    onPresence: (kind: "attached" | "detached", rpcStubKey: string) => void;
    rpcStubFetch: RpcStubFetchServer;
  }) {
    this.#hooks = deps.hooks;
    this.#onPresence = deps.onPresence;
    this.#rpcStubFetch = deps.rpcStubFetch;
  }

  // ── LAYER 1: lend · call · return ──

  /** LEND a stub under `rpcStubKey` — the borrowed table takes it from here (a page answer lands
   *  here too, and resolves the waiting call). Re-lending a key REPLACES its stub. */
  lendRpcStub(input: { rpcStubKey: string; stub: BorrowedRpcStub }): void {
    const previous = this.#borrowedRpcStubs.get(input.rpcStubKey);
    this.#borrowedRpcStubs.set(input.rpcStubKey, {
      stub: input.stub.dup?.() ?? input.stub,
      inFlight: 0,
    });
    if (previous) disposeRpcStub(previous.stub);
    const page = this.#rpcStubPagesInFlight.get(input.rpcStubKey);
    if (page) {
      clearTimeout(page.timer);
      this.#rpcStubPagesInFlight.delete(input.rpcStubKey);
      page.resolve();
    }
  }

  /** THE one call door behind `itx.rpcStubs.get(rpcStubKey)` — resolved calls (`itx.<match>.m()`
   *  through a rewrite rule naming it) and the delivery loop's push (an anonymous call step = the
   *  bare lent callable itself). The stub stays borrowed afterwards — steady traffic is pure RPC, no
   *  socket round-trips. Fire-and-forget callers just don't await. */
  async invokeRpcStub(rpcStubKey: string, itxExpressionSteps: ItxExpression): Promise<unknown> {
    let borrowed = this.#borrowedRpcStubs.get(rpcStubKey); // 1. have we got it? call it
    if (!borrowed && this.#rpcStubPagerFor(rpcStubKey))
      borrowed = await this.#pageRpcStub(rpcStubKey); // 2. can a pager lend it back?
    if (!borrowed)
      throw codedError("RPC_STUB_OFFLINE", `rpc stub ${JSON.stringify(rpcStubKey)} is offline`);
    borrowed.inFlight += 1;
    try {
      // THE TERMINAL-FETCH BRANCH (fetch/rpc-stub-fetch.ts, doctrine point 1 — dies with its
      // WORKAROUND fence): a terminal `fetch` carrying the one live Request rides the rpc-stub fetch
      // path; the borrowed stub is the transport. Everything else is a plain dotted dispatch. Either
      // way, a lender that dies mid-call is re-coded to RPC_STUB_OFFLINE at the relay, where the
      // break is LOCAL — the CODE, never a message, crosses this hop (lib/errors.ts).
      const last = itxExpressionSteps.at(-1);
      if (
        Array.isArray(last) &&
        last[0] === "fetch" &&
        last.length === 2 &&
        last[1] instanceof Request
      )
        return await this.#rpcStubFetch.serve(
          borrowed.stub,
          itxExpressionSteps.slice(0, -1),
          last[1],
        );
      return await borrowed.stub.invoke(itxExpressionSteps);
    } finally {
      borrowed.inFlight -= 1;
    }
  }

  /** Any stub borrowed right now (O(1)) — what makes the quiet clock worth arming. */
  hasBorrowedRpcStubs(): boolean {
    return this.#borrowedRpcStubs.size > 0;
  }

  /** THE IDLE RETURN (call from the DO's quiesce alarm): give every borrowed stub back so the DO
   *  can hibernate. Losing them costs exactly one page on the next call — that is the deal. */
  returnBorrowedRpcStubs(): void {
    for (const [rpcStubKey, borrowed] of this.#borrowedRpcStubs) {
      this.#borrowedRpcStubs.delete(rpcStubKey);
      disposeRpcStub(borrowed.stub);
    }
  }

  // ── LAYER 2: attach → the pager upgrade → pages → close ──

  /** Reserve a pager for `rpcStubKey` (the relay calls this BEFORE opening the pager WebSocket).
   *  Mints the fresh transportId the pager carries. */
  attachRpcStubPager(input: { rpcStubKey: string }): { transportId: string } {
    const transportId = crypto.randomUUID();
    this.#pendingRpcStubPagerAttachments.set(transportId, { rpcStubKey: input.rpcStubKey });
    return { transportId };
  }

  /** PARTIAL FETCH (compose first in the DO's fetch): the pager upgrade, gated on a pending attach.
   *  `null` = not this door's request. */
  acceptRpcStubPagerWebSocket(request: Request): Response | null {
    const transportId = request.headers.get(RPC_STUB_PAGER_WEBSOCKET_HEADER);
    if (transportId === null) return null;
    const rpcStubKey = this.#pendingRpcStubPagerAttachments.get(transportId)?.rpcStubKey;
    if (rpcStubKey === undefined)
      return new Response(`unknown rpc stub pager ${transportId} (attach first)\n`, {
        status: 409,
      });
    this.#pendingRpcStubPagerAttachments.delete(transportId);
    const hadPager = this.#rpcStubPagerFor(rpcStubKey) !== undefined;
    // Accepted and stamped in ONE synchronous turn, so every pager socket this side ever sees
    // carries its record — through hibernation too (the attachment is what survives).
    const pair = new WebSocketPair();
    this.#hooks.acceptWebSocket(pair[1], [RPC_STUB_PAGER_WEBSOCKET_TAG]);
    pair[1].serializeAttachment({ transportId, rpcStubKey } satisfies RpcStubPagerRecord);
    // ONE pager per key, enforced when a pager becomes VISIBLE: a CONCURRENT provide at the same key
    // may still be opening its own pager, invisible to any earlier scan — so when THIS pager opens,
    // drop every OTHER same-key pager now (the newest wins). "replaced" ⇒ a swap, not a real close.
    for (const record of this.#rpcStubPagerRecords())
      if (record.rpcStubKey === rpcStubKey && record.transportId !== transportId)
        this.dropRpcStubPager(record.transportId, "replaced");
    if (!hadPager) this.#onPresence("attached", rpcStubKey);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** A pager WebSocket closed (wire this to webSocketClose/webSocketError, AFTER the DO's own
   *  rpc-stub-fetch close routing): the pager is gone, and the stub it lent goes back with it. A
   *  rewrite rule naming the key is data and stays (calls answer RPC_STUB_OFFLINE). */
  rpcStubPagerClosed(ws: WebSocket): void {
    if (this.#closedRpcStubPagerSockets.has(ws)) return;
    this.#closedRpcStubPagerSockets.add(ws);
    const { rpcStubKey } = this.#rpcStubPagerRecord(ws);
    // Another pager for this key is open (a reconnect that attached before this socket dropped):
    // the "replaced" swap already returned the old stub; the borrowed one now is the new session's.
    if (this.#rpcStubPagerFor(rpcStubKey)) return;
    this.#returnRpcStubAndFailItsPage(rpcStubKey);
    this.#onPresence("detached", rpcStubKey);
  }

  /** Close a pager WebSocket (kick / replace) and forget it. */
  dropRpcStubPager(transportId: string, reason: string): void {
    const ws = this.#rpcStubPagerSocketFor(transportId);
    if (!ws) return;
    this.#closedRpcStubPagerSockets.add(ws); // its late close event must not touch the key again
    try {
      ws.close(1000, reason);
    } catch {
      /* already closing */
    }
    this.#returnRpcStubAndFailItsPage(this.#rpcStubPagerRecord(ws).rpcStubKey);
  }

  // ── the views ──

  /** PRESENCE — the keys with a borrowed stub or an open pager right now (`itx.rpcStubs.list()`).
   *  The pager attachments rehydrate free from the hibernated sockets, so this is exact after a wake. */
  listRpcStubKeys(): string[] {
    return [
      ...new Set([
        ...this.#borrowedRpcStubs.keys(),
        ...this.#rpcStubPagerRecords().map((record) => record.rpcStubKey),
      ]),
    ];
  }

  /** In-memory transport facts — the DO's `rpcStubTransportState()` verb for the hibernation probes;
   *  not event-derivable, deliberately off the itx surface. `dormant` ⇒ nothing borrowed and no page
   *  in flight (the DO can hibernate; pagers stay attached). */
  rpcStubTransportState(): {
    rpcStubPagers: number;
    borrowedRpcStubs: number;
    rpcStubPagesInFlight: number;
    dormant: boolean;
  } {
    return {
      rpcStubPagers: this.#rpcStubPagerRecords().length,
      borrowedRpcStubs: this.#borrowedRpcStubs.size,
      rpcStubPagesInFlight: this.#rpcStubPagesInFlight.size,
      dormant: this.#borrowedRpcStubs.size === 0 && this.#rpcStubPagesInFlight.size === 0,
    };
  }

  // ── the pager sockets ──

  #rpcStubPagerSockets(): WebSocket[] {
    return this.#hooks
      .getWebSockets(RPC_STUB_PAGER_WEBSOCKET_TAG)
      .filter((ws) => ws.readyState === WebSocket.OPEN);
  }
  /** Every attached pager — DERIVED from the surviving sockets, so a fresh DO incarnation reads them
   *  straight back with nothing to reconcile. */
  #rpcStubPagerRecords(): RpcStubPagerRecord[] {
    return this.#rpcStubPagerSockets().map((ws) => this.#rpcStubPagerRecord(ws));
  }
  #rpcStubPagerFor(rpcStubKey: string): WebSocket | undefined {
    return this.#rpcStubPagerSockets().find(
      (ws) => this.#rpcStubPagerRecord(ws).rpcStubKey === rpcStubKey,
    );
  }
  #rpcStubPagerSocketFor(transportId: string): WebSocket | undefined {
    return this.#rpcStubPagerSockets().find(
      (ws) => this.#rpcStubPagerRecord(ws).transportId === transportId,
    );
  }
  /** The record a pager socket carries (stamped in the same synchronous turn the socket was
   *  accepted, so it is never missing). */
  #rpcStubPagerRecord(ws: WebSocket): RpcStubPagerRecord {
    return ws.deserializeAttachment() as RpcStubPagerRecord;
  }

  /** PAGE the edge for `rpcStubKey`: send `{type:"page"}` down its pager and wait for the lend. */
  async #pageRpcStub(rpcStubKey: string): Promise<{ stub: BorrowedRpcStub; inFlight: number }> {
    let page = this.#rpcStubPagesInFlight.get(rpcStubKey);
    if (page === undefined) {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const arrived = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const timer = setTimeout(() => {
        if (this.#rpcStubPagesInFlight.delete(rpcStubKey))
          reject(new Error(`rpc stub ${JSON.stringify(rpcStubKey)}: page timed out`));
      }, RPC_STUB_PAGE_TIMEOUT_MS);
      page = { resolve, reject, timer, arrived };
      this.#rpcStubPagesInFlight.set(rpcStubKey, page);
      const ws = this.#rpcStubPagerFor(rpcStubKey)!;
      try {
        // THE ONE message a pager ever carries (DO → edge): "I ought to have your rpc stub but I
        // don't — lend it." Everything else rides Workers RPC on the borrowed stub.
        ws.send(JSON.stringify({ type: "page" }));
      } catch {
        ws.close(1011, "page send failed");
      }
    }
    await page.arrived;
    const borrowed = this.#borrowedRpcStubs.get(rpcStubKey);
    if (borrowed === undefined)
      throw new Error(`rpc stub ${JSON.stringify(rpcStubKey)}: page answered empty`);
    return borrowed;
  }

  /** A key's pager is gone: return the stub it lent (its session died with it) and fail its page. */
  #returnRpcStubAndFailItsPage(rpcStubKey: string): void {
    const borrowed = this.#borrowedRpcStubs.get(rpcStubKey);
    if (borrowed) {
      this.#borrowedRpcStubs.delete(rpcStubKey);
      disposeRpcStub(borrowed.stub);
    }
    const page = this.#rpcStubPagesInFlight.get(rpcStubKey);
    if (page) {
      clearTimeout(page.timer);
      this.#rpcStubPagesInFlight.delete(rpcStubKey);
      page.reject(
        codedError("RPC_STUB_OFFLINE", `rpc stub ${JSON.stringify(rpcStubKey)} went offline`),
      );
    }
  }
}
