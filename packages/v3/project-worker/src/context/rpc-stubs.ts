// context/rpc-stubs.ts — THE RPC STUBS: `itx.rpcStubs`, a lent live object and the plumbing that keeps
// it lendable while nothing stays pinned. Three concepts, one file:
//   rpc stub directory — DO side: the borrowed table and the pagers (`RpcStubDirectory`)
//   rpc stub relay     — edge side: the don't-pin pager relay (`lendRpcStubOverPager`)
//   rpc stub fetch     — the fetch-shaped transport under both (`dialRpcStubFetch`, `RpcStubFetchServer`)

import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import { codedError, errorCode } from "../lib.ts";
import type { StreamEventInput } from "../stream/processor.ts";
import type { IterateContextDurableObject } from "../iterate-context-durable-object.ts";
import { type ItxExpression, walkStepsOnRpcStub } from "./expression.ts";

// ── rpc stub directory ── THE RPC STUBS, DO side: the `itx.rpcStubs` built-in's backing
// table — physical, never event-sourced. Two layers, in the order the tutorial builds them:
//
//   LAYER 1 — THE BORROWED RPC STUBS. Anyone with a Workers-RPC route to this DO can LEND a stub
//   under an OPAQUE key (`lendRpcStub`); the DO keeps it BORROWED — every call on that key rides
//   it — and RETURNS it at its idle quiesce (`returnBorrowedRpcStubs`), because a DO holding a stub
//   is pinned awake and this DO must hibernate with any number of clients attached. A lender with no
//   pager (below) is one-shot: after the return the key is offline until someone lends again.
//
//   LAYER 2 — THE RPC-STUB PAGERS. A hibernatable WebSocket per key, opened by the stateless edge
//   relay (the relay section below), carrying `{ rpcStubKey }` in its attachment and nothing
//   else. It is a standing offer: "I can lend this key back on demand". When a call finds
//   the key not borrowed, the DO sends `{type:"page"}` down the pager, the edge answers with
//   `lendRpcStub`, and layer 1 takes over. Between pages the DO holds only hibernatable sockets.
//
// WHAT A STUB IS HERE: its KEY — an opaque string the lender picks; the registry never parses it. A
// PAGER IS ITS SOCKET: a NEW pager under an existing key attaches beside the old one, then wins (the
// reconnect swap).
//
// ONE-SHOT pager attach: the pager upgrade's `x-itx-rpc-stub-pager` header carries the KEY and the
// EVENTS THAT NAME IT (a rewrite rule, a subscription row); this side accepts the socket and appends
// those events in the SAME synchronous turn — the SET half of "the DO owns both ends of a lent
// stub's rule" (the un-set half is the key's last pager close, `onPresence`). A refused append (a
// paused stream) un-accepts: the socket closes silently, nothing was named, and the refusal — its
// CODE — is the upgrade's answer. So a `provide(stub)` costs the edge ONE round trip to this DO.

// ── the wire: what the relay (below) speaks to this side ──

export const RPC_STUB_PAGER_WEBSOCKET_HEADER = "x-itx-rpc-stub-pager";
/** What the pager upgrade's header carries: the key, and the events that NAME it — appended by the DO
 *  in the turn it accepts the pager (empty for a bare pager, the workers-lane probes). */
type RpcStubPagerAttachRequest = { rpcStubKey: string; appendEvents: StreamEventInput[] };
/** The header value: URI-encoded JSON — a header is a ByteString, a key or an event is not. */
export const encodeRpcStubPagerAttachRequest = (request: RpcStubPagerAttachRequest): string =>
  encodeURIComponent(JSON.stringify(request));
/** The inverse — throws on anything that is not a well-formed attach request. */
function decodeRpcStubPagerAttachRequest(header: string): RpcStubPagerAttachRequest {
  const decoded = JSON.parse(decodeURIComponent(header)) as Partial<RpcStubPagerAttachRequest>;
  if (typeof decoded?.rpcStubKey !== "string" || !Array.isArray(decoded.appendEvents))
    throw new Error("expected { rpcStubKey: string, appendEvents: [] }");
  return { rpcStubKey: decoded.rpcStubKey, appendEvents: decoded.appendEvents };
}
/** A refused attach, as the upgrade's answer: the error's CODE (lib.ts) and message as JSON,
 *  so the relay re-throws the same coded error to the caller. 409 = the DO refused (a coded refusal
 *  such as STREAM_PAUSED); 500 = something uncoded. */
const rpcStubPagerRefusalResponse = (error: unknown): Response =>
  Response.json(
    {
      code: errorCode(error) ?? null,
      message: error instanceof Error ? error.message : String(error),
    },
    { status: errorCode(error) ? 409 : 500 },
  );
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
 *  walks the itx-expression steps on the client's rpc stub (a DIRECT dotted dispatch — never
 *  `.apply`), and `fetch(upgradeId, steps, request)` is the rpc-stub fetch dial
 *  (the fetch section below — dies with its WORKAROUND fence). */
export type BorrowedRpcStub = RpcStubFetchTransport & {
  invoke(itxExpressionSteps: ItxExpression): Promise<unknown>;
  dup?(): BorrowedRpcStub;
};

/** One pager socket's durable record — its attachment (survives hibernation). The key alone: the
 *  socket is its own identity. */
type RpcStubPagerRecord = { rpcStubKey: string };

/** THE one disposer for any RPC-ish stub (borrowed Workers-RPC legs here, the session's own capnweb
 *  stubs in the relay): a no-op for anything that is not disposable. */
function disposeRpcStub(x: unknown): void {
  (x as Partial<Disposable> | null)?.[Symbol.dispose]?.();
}

/** A BROKEN STUB: the call failed at the TRANSPORT — workerd stamps `retryable: true` on every
 *  DISCONNECTED failure (jsg/util.c++: "Network connection lost.", a Durable Object reset) — and a
 *  stub whose transport is gone fails every later call the same way (Cloudflare, error handling:
 *  "avoid reusing a stub after it throws an exception … create a new one"). A coded refusal (the
 *  relay's RPC_STUB_OFFLINE) or the client's own throw says nothing about this leg. */
const isBrokenRpcStubError = (error: unknown): boolean =>
  (error as { retryable?: unknown } | null)?.retryable === true;

export class RpcStubDirectory {
  readonly #ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
  /** PRESENCE as it changes: a key gained its (only) pager, or lost its last one. The DO turns these
   *  into the two ephemeral `rpc-stub/attached` / `rpc-stub/detached` events — live watchers see
   *  presence move; the log never claims a socket is open. A REPLACED pager (same key, new socket)
   *  is neither: the key never lost presence. */
  readonly #onPresence: (kind: "attached" | "detached", rpcStubKey: string) => void;
  /** The DO's rpc-stub fetch subsystem (the fetch section below) — `invokeRpcStub` routes a
   *  terminal-fetch call into its serve(). */
  readonly #rpcStubFetch: RpcStubFetchServer;

  // LAYER 1 — the borrowed rpc stubs, in memory ONLY; returned at the DO's idle quiesce — never per
  // call, never on a timer (a pending timer would itself pin the DO out of hibernation).
  readonly #borrowedRpcStubs = new Map<string, BorrowedRpcStub>();

  // LAYER 2 — the pagers: per key, the page awaiting its lend — CONCURRENT cold invokes share it
  // (`arrived`), a second caller must never replace the first's resolver (it would hang forever).
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

  /** The DO's append door, SYNCHRONOUS (Stream.append is): what a pager attach carries lands through
   *  it in the turn the pager is accepted; a refusal throws the coded error. */
  readonly #appendEvents: (events: StreamEventInput[]) => void;

  constructor(deps: {
    ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
    onPresence: (kind: "attached" | "detached", rpcStubKey: string) => void;
    rpcStubFetch: RpcStubFetchServer;
    appendEvents: (events: StreamEventInput[]) => void;
  }) {
    this.#ctx = deps.ctx;
    this.#onPresence = deps.onPresence;
    this.#rpcStubFetch = deps.rpcStubFetch;
    this.#appendEvents = deps.appendEvents;
  }

  // ── LAYER 1: lend · call · return ──

  /** LEND a stub under `rpcStubKey` — the borrowed table takes it from here (a page answer lands
   *  here too, and resolves the waiting call). Re-lending a key REPLACES its stub. */
  lendRpcStub(input: { rpcStubKey: string; stub: BorrowedRpcStub }): void {
    const previous = this.#borrowedRpcStubs.get(input.rpcStubKey);
    this.#borrowedRpcStubs.set(input.rpcStubKey, input.stub.dup?.() ?? input.stub);
    if (previous) disposeRpcStub(previous);
    const page = this.#rpcStubPagesInFlight.get(input.rpcStubKey);
    if (page) {
      clearTimeout(page.timer);
      this.#rpcStubPagesInFlight.delete(input.rpcStubKey);
      page.resolve();
    }
  }

  /** THE one call door behind `itx.rpcStubs.get(rpcStubKey)` — resolved calls and the delivery loop's
   *  push (an anonymous call step = the bare lent callable itself): have it? call it · else page it,
   *  then call · else RPC_STUB_OFFLINE. The stub stays borrowed afterwards — steady traffic is pure
   *  RPC — unless the call broke it (below). */
  async invokeRpcStub(rpcStubKey: string, itxExpressionSteps: ItxExpression): Promise<unknown> {
    let borrowed = this.#borrowedRpcStubs.get(rpcStubKey); // 1. have we got it? call it
    if (!borrowed && this.#rpcStubPagerFor(rpcStubKey))
      borrowed = await this.#pageRpcStub(rpcStubKey); // 2. can a pager lend it back?
    if (!borrowed)
      throw codedError("RPC_STUB_OFFLINE", `rpc stub ${JSON.stringify(rpcStubKey)} is offline`);
    try {
      // The terminal-fetch branch dies with the fetch section's WORKAROUND fence. Either way a
      // lender that dies mid-call is re-coded to RPC_STUB_OFFLINE at the relay, where the break is
      // LOCAL (the relay section).
      const terminalFetch = terminalFetchOf(itxExpressionSteps, []);
      if (terminalFetch)
        return await this.#rpcStubFetch.serve(borrowed, terminalFetch.steps, terminalFetch.request);
      return await borrowed.invoke(itxExpressionSteps);
    } catch (error) {
      // A BROKEN STUB IS DROPPED, NEVER KEPT (v4 §2.7): every later call on it would fail the same
      // way until the idle return, while its pager may already lend a live one — so the NEXT call
      // pages again. Only the stub THIS call rode: a re-lend that landed meanwhile is the live one.
      // The failed call is not retried.
      if (isBrokenRpcStubError(error) && this.#borrowedRpcStubs.get(rpcStubKey) === borrowed) {
        this.#borrowedRpcStubs.delete(rpcStubKey);
        disposeRpcStub(borrowed);
      }
      throw error;
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
      disposeRpcStub(borrowed);
    }
  }

  // ── LAYER 2: the pager upgrade (attach + the events that name the key) → pages → close ──

  /** PARTIAL FETCH (compose first in the DO's fetch): the pager upgrade (the header, above); `null` =
   *  not this door's request. Accept, append, stamp in ONE synchronous turn, so a refused append
   *  leaves no socket, no presence and no row. */
  acceptRpcStubPagerWebSocket(request: Request): Response | null {
    const header = request.headers.get(RPC_STUB_PAGER_WEBSOCKET_HEADER);
    if (header === null) return null;
    let attachRequest: RpcStubPagerAttachRequest;
    try {
      attachRequest = decodeRpcStubPagerAttachRequest(header);
    } catch (error) {
      return new Response(
        `malformed ${RPC_STUB_PAGER_WEBSOCKET_HEADER} header: ${error instanceof Error ? error.message : String(error)}\n`,
        { status: 400 },
      );
    }
    const { rpcStubKey, appendEvents } = attachRequest;
    const hadPager = this.#rpcStubPagerFor(rpcStubKey) !== undefined;
    // Accepted and stamped in the same turn, so every pager socket this side ever sees carries its
    // record — through hibernation too.
    const pair = new WebSocketPair();
    this.#ctx.acceptWebSocket(pair[1], [RPC_STUB_PAGER_WEBSOCKET_TAG]);
    pair[1].serializeAttachment({ rpcStubKey } satisfies RpcStubPagerRecord);
    // THE SET HALF, with the pager already accepted — so a push the commit fans out finds the pager
    // to page. Still the same turn: the fan-out's first await is after this function returns.
    try {
      if (appendEvents.length > 0) this.#appendEvents(appendEvents);
    } catch (error) {
      this.#closedRpcStubPagerSockets.add(pair[1]); // its close must not report a presence it never had
      try {
        pair[1].close(1011, "attach refused");
      } catch {
        /* already closing */
      }
      return rpcStubPagerRefusalResponse(error);
    }
    // ONE pager per key, enforced when a pager becomes VISIBLE (a CONCURRENT provide at the same key
    // may still be opening its own, invisible to any earlier scan): drop every OTHER same-key socket
    // now — the newest wins. "replaced" is a swap, not a real close: a page in flight SURVIVES it —
    // parked out of the drop's reach, then re-sent down this pager (its timeout stays the backstop).
    const pageInFlight = this.#rpcStubPagesInFlight.get(rpcStubKey);
    if (pageInFlight) this.#rpcStubPagesInFlight.delete(rpcStubKey);
    for (const ws of this.#rpcStubPagerSockets())
      if (ws !== pair[1] && this.#rpcStubPagerRecord(ws).rpcStubKey === rpcStubKey)
        this.#dropRpcStubPager(ws, "replaced");
    if (pageInFlight) {
      this.#rpcStubPagesInFlight.set(rpcStubKey, pageInFlight);
      pair[1].send(JSON.stringify({ type: "page" }));
    }
    if (!hadPager) this.#onPresence("attached", rpcStubKey);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** A pager WebSocket closed (wire this to webSocketClose/webSocketError, AFTER the DO's own
   *  rpc-stub-fetch close routing): the pager is gone, and the stub it lent goes back with it. */
  rpcStubPagerClosed(ws: WebSocket): void {
    if (this.#closedRpcStubPagerSockets.has(ws)) return;
    this.#closedRpcStubPagerSockets.add(ws);
    const { rpcStubKey } = this.#rpcStubPagerRecord(ws);
    // another pager for this key is open (a reconnect): the swap already returned the old stub
    if (this.#rpcStubPagerFor(rpcStubKey)) return;
    this.#returnRpcStubAndFailItsPage(rpcStubKey);
    this.#onPresence("detached", rpcStubKey);
  }

  /** Close a pager WebSocket (the replaced one of a reconnect swap) and forget it. */
  #dropRpcStubPager(ws: WebSocket, reason: string): void {
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
    return this.#ctx
      .getWebSockets(RPC_STUB_PAGER_WEBSOCKET_TAG)
      .filter((ws) => ws.readyState === WebSocket.OPEN);
  }
  /** DERIVED from the surviving sockets, so a fresh DO incarnation reads them straight back. */
  #rpcStubPagerRecords(): RpcStubPagerRecord[] {
    return this.#rpcStubPagerSockets().map((ws) => this.#rpcStubPagerRecord(ws));
  }
  #rpcStubPagerFor(rpcStubKey: string): WebSocket | undefined {
    return this.#rpcStubPagerSockets().find(
      (ws) => this.#rpcStubPagerRecord(ws).rpcStubKey === rpcStubKey,
    );
  }
  #rpcStubPagerRecord(ws: WebSocket): RpcStubPagerRecord {
    return ws.deserializeAttachment() as RpcStubPagerRecord;
  }

  /** PAGE the edge for `rpcStubKey`: send `{type:"page"}` down its pager and wait for the lend. */
  async #pageRpcStub(rpcStubKey: string): Promise<BorrowedRpcStub> {
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
          reject(
            codedError(
              "RPC_STUB_OFFLINE",
              `rpc stub ${JSON.stringify(rpcStubKey)}: page timed out`,
            ),
          );
      }, RPC_STUB_PAGE_TIMEOUT_MS);
      page = { resolve, reject, timer, arrived };
      this.#rpcStubPagesInFlight.set(rpcStubKey, page);
      const ws = this.#rpcStubPagerFor(rpcStubKey)!;
      try {
        // THE ONE message a pager ever carries (DO → edge); everything else rides the borrowed stub
        ws.send(JSON.stringify({ type: "page" }));
      } catch {
        ws.close(1011, "page send failed");
      }
    }
    await page.arrived;
    const borrowed = this.#borrowedRpcStubs.get(rpcStubKey);
    if (borrowed === undefined)
      throw codedError(
        "RPC_STUB_OFFLINE",
        `rpc stub ${JSON.stringify(rpcStubKey)}: page answered empty`,
      );
    return borrowed;
  }

  /** A key's pager is gone: return the stub it lent (its session died with it) and fail its page. */
  #returnRpcStubAndFailItsPage(rpcStubKey: string): void {
    const borrowed = this.#borrowedRpcStubs.get(rpcStubKey);
    if (borrowed) {
      this.#borrowedRpcStubs.delete(rpcStubKey);
      disposeRpcStub(borrowed);
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

// ── rpc stub relay ── THE DON'T-PIN PLUMBING behind a lent rpc stub, EDGE side. When a client
// hands the project a capnweb value (`itx.provide(match, stub)`), the client's stub must live in the
// STATELESS relay worker (this side of `/api`), NEVER in the Durable Object — else the DO can't
// hibernate while any client is connected. So the edge opens an RPC-STUB PAGER WebSocket to the DO
// (a standing offer to lend the key back on demand); when the DO wants the client — a delivery, a
// request/response call — it PAGES this worker, and this worker LENDS a fresh Workers-RPC leg
// wrapping the client's capnweb stub (`lendRpcStub`). The edge OWNS the stub for the session; the DO
// only borrows it. The DO half — the pager door, the pages, the borrowed table — is
// the directory section above.
//
// The whole dance is behind ONE function, `lendRpcStubOverPager` (open the pager, hand back a
// disposable the caller registers with its `SessionTeardown`).

/** The context DO's Workers-RPC stub — what the edge proxies to and this relay pages against. */
export type IterateContextDurableObjectStub = DurableObjectStub<IterateContextDurableObject>;

/** The client's live capnweb stub, as the session holds it (`.dup()` keeps it past the call that
 *  handed it over; every other key is one of its remote members). ON THE WIRE it is a callable stub
 *  Proxy (`typeof === "function"`), so nothing structural can inspect it — typed at the use sites. */
export type ClientRpcStub = { dup(): ClientRpcStub; [k: string]: unknown };

/** WHAT THE EDGE LENDS (and the DO borrows as `BorrowedRpcStub`): a per-page Workers-RPC leg
 *  wrapping the session's capnweb stub, walking itx-expression steps on it (a DIRECT dotted dispatch
 *  — never `.apply`), so a call from the stream reaches the client's actual function over the capnweb
 *  WebSocket. Minted fresh per page and returned at the DO's idle quiesce. */
class LentRpcStub extends WorkersRpcTarget {
  #clientRpcStub: ClientRpcStub;
  /** THE ONE "the lend ended" reason, SHARED across every page of one pager (a `{ reason }` holder)
   *  and set ONCE by whatever ends the lend first — the single `onRpcBroken` registration in
   *  `lendRpcStubOverPager` or the pager's close — always BEFORE the session's dup is disposed, so a
   *  call already walking the dup re-codes below. Shared because capnweb has no `offRpcBroken`:
   *  registering per lent stub would accumulate a listener per page for the session's life. capnweb
   *  fires onRpcBroken BEFORE it rejects the in-flight import, so a caught call sees the reason set. */
  #lendEnded: { reason: string | null };
  #durableObject: IterateContextDurableObjectStub;
  constructor(
    clientRpcStub: ClientRpcStub,
    lendEnded: { reason: string | null },
    durableObject: IterateContextDurableObjectStub,
  ) {
    super();
    this.#clientRpcStub = clientRpcStub;
    this.#lendEnded = lendEnded;
    this.#durableObject = durableObject;
  }

  /** The lend ended mid-call — the client died, or the lender recalled the stub while the DO still
   *  held the rule naming it (its un-set lands one append AFTER the pager's close, and a call in that
   *  window walks the disposed dup): capnweb throws a raw, UNCODED error either way, so re-code
   *  LOCALLY to RPC_STUB_OFFLINE — the CODE crosses the Workers-RPC hop (lib.ts). A genuine
   *  app error propagates untouched. */
  #recodeIfLendEnded(e: unknown, what: string): never {
    if (this.#lendEnded.reason)
      throw codedError("RPC_STUB_OFFLINE", `the lent rpc stub ${this.#lendEnded.reason} ${what}`);
    throw e;
  }

  /** The rpc-stub fetch dial, TRANSPORT side — the whole mechanism (why it exists, the upgrade leg,
   *  the marker) lives in the fetch section below. */
  async fetch(
    upgradeId: string,
    itxExpressionSteps: ItxExpression,
    request: Request,
  ): Promise<unknown> {
    try {
      const receiver = (await walkStepsOnRpcStub(this.#clientRpcStub, itxExpressionSteps)) as {
        fetch(r: Request): Promise<unknown>;
      };
      return await dialRpcStubFetch(
        (r) => receiver.fetch(r),
        request,
        upgradeId,
        this.#durableObject,
      );
    } catch (e) {
      this.#recodeIfLendEnded(e, "mid-fetch");
    }
  }

  async invoke(itxExpressionSteps: ItxExpression): Promise<unknown> {
    try {
      return await walkStepsOnRpcStub(this.#clientRpcStub, itxExpressionSteps);
    } catch (e) {
      this.#recodeIfLendEnded(e, "mid-invoke");
    }
  }
}

/** Offer the DO a lend of `clientRpcStub` under `rpcStubKey`: dup the client's stub for the session,
 *  open the pager WebSocket — its header carries the key AND `appendEvents`, the rows naming the key,
 *  which the DO appends as it accepts the pager (the directory section above; a refusal comes back
 *  as the upgrade's answer with its code, and this function throws it with nothing lent) — and answer
 *  every page with a fresh `LentRpcStub`. The pager lives until disposed (explicitly, or at session
 *  end); its close makes the DO return the stub. */
export async function lendRpcStubOverPager(
  durableObject: IterateContextDurableObjectStub,
  clientRpcStub: ClientRpcStub,
  rpcStubKey: string,
  appendEvents: StreamEventInput[],
  waitUntil: (p: Promise<unknown>) => void,
): Promise<{ dispose(): void }> {
  const sessionRpcStub = clientRpcStub.dup(); // dup FIRST: a value that is not a stub fails here, before any socket
  // the one shared "the lend ended" reason (LentRpcStub#lendEnded says why it is shared)
  const lendEnded: { reason: string | null } = { reason: null };
  // THE PAGER WEBSOCKET, opened through the DO's fetch door: the header is the attach request.
  let response: Response;
  try {
    response = await durableObject.fetch("https://rpc-stub-pager.internal/", {
      headers: {
        Upgrade: "websocket",
        [RPC_STUB_PAGER_WEBSOCKET_HEADER]: encodeRpcStubPagerAttachRequest({
          rpcStubKey,
          appendEvents,
        }),
      },
    });
  } catch (error) {
    // the DO never answered: nothing is lent, and the session's dup must not outlive the attempt
    disposeRpcStub(sessionRpcStub);
    throw error;
  }
  const pagerWebSocket = response.webSocket;
  if (response.status !== 101 || !pagerWebSocket) {
    // The DO refused (a paused stream, a row the reduce rejects): nothing is lent, and the refusal's
    // CODE crosses to the caller as the same coded error the append door would have thrown.
    disposeRpcStub(sessionRpcStub);
    const refusal = (await response.json().catch(() => null)) as {
      code?: string | null;
      message?: string;
    } | null;
    throw Object.assign(
      new Error(
        refusal?.message ??
          `rpc stub pager upgrade returned ${response.status} without a WebSocket`,
      ),
      refusal?.code ? { code: refusal.code } : {},
    );
  }
  pagerWebSocket.accept();
  // Keep this leg warm: a 30s keepalive the DO auto-answers via setWebSocketAutoResponse WITHOUT
  // waking it — defeats the ~100s idle-close and keeps the /api isolate warm. Dies with the isolate.
  const keepalive = setInterval(() => {
    try {
      pagerWebSocket.send(RPC_STUB_PAGER_KEEPALIVE_REQUEST);
    } catch {
      clearInterval(keepalive);
    }
  }, 30_000);
  pagerWebSocket.addEventListener("close", () => clearInterval(keepalive));
  // The page answer: a fresh Workers-RPC leg around the session's capnweb stub, lent to the DO. The
  // keepalive ack rides this same socket, so anything that is not a page is ignored.
  pagerWebSocket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let page: unknown;
    try {
      page = JSON.parse(event.data);
    } catch {
      return;
    }
    if ((page as { type?: string } | null)?.type !== "page") return;
    waitUntil(
      durableObject
        .lendRpcStub({
          rpcStubKey,
          stub: new LentRpcStub(sessionRpcStub, lendEnded, durableObject),
        })
        .catch(() => undefined), // offline throws — ignore; the DO's page times out on its own
    );
  });
  // THE ONE PLACE the session's dup is disposed, the reason set FIRST (the first reason wins) so a
  // call already walking the dup re-codes (LentRpcStub#recodeIfLendEnded).
  const disposeSessionRpcStub = (reason: string) => {
    lendEnded.reason ??= reason;
    disposeRpcStub(sessionRpcStub);
  };
  // capnweb's own death signal, registered ONCE: set the shared reason AND close the pager NOW so the
  // DO returns the stub immediately — without this the presence list lies until a page times out.
  (sessionRpcStub as { onRpcBroken?: (cb: () => void) => void }).onRpcBroken?.(() => {
    lendEnded.reason = "went offline (its client session broke)";
    try {
      pagerWebSocket.close(1000, "client session broke");
    } catch {
      /* already closing */
    }
  });
  pagerWebSocket.addEventListener("close", () =>
    disposeSessionRpcStub("was returned (its pager closed)"),
  );
  return {
    dispose: () => {
      try {
        pagerWebSocket.close(1000, "pager disposed");
      } catch {
        /* already closing */
      }
      disposeSessionRpcStub("was recalled by its lender");
    },
  };
}

// ── rpc stub fetch ── EVERYTHING about serving FETCH-SHAPED capabilities, in one place.
//
// THE DOCTRINE (read this and you can skip the rest of the file):
//
//   1. Some capabilities are FETCH-SHAPED: `(request: Request) => Promise<Response>`. They are
//      ALWAYS called through a terminal `fetch` — `itx.site.fetch(request)`, never a method of
//      any other name. `itxExpressionEndingInFetch` (below) is the one normalizer that enforces the
//      spelling at the fetch lane; `terminalFetchOf` is the one reader of the shape a LIVE call
//      carries.
//
//   2. Some fetch-shaped capabilities answer with a WEBSOCKET UPGRADE (a 101 Response carrying
//      `webSocket`). Whether a given fetch upgrades is the PROVIDER'S decision, expressed in its
//      answer — nothing here ever inspects the request to guess.
//
//   3. Fetch-shaped calls enter through TWO doors, both landing here: over HTTP via the
//      itx-expression fetch lane (`x-itx-expression`, below), and over the dotted door — any terminal
//      `.fetch(request)` on a lent rpc stub (`itx.<match>.fetch(...)` through a rewrite rule) is
//      recognized by the terminal-fetch branch of `RpcStubDirectory.invokeRpcStub` and routed into
//      `RpcStubFetchServer.serve`.
//
//   4. Two platform facts force everything unusual in this file, and BOTH are workarounds we
//      expect to delete one day:
//        • workerd's Workers RPC cannot serialize a webSocket-bearing Response (DataCloneError) —
//          only the FETCH CHANNEL (WorkerEntrypoint.fetch / DurableObject.fetch / service-binding
//          fetch) tunnels sockets. So anything that might carry a socket MUST travel a real
//          `.fetch()` hop, end to end.
//        • capnweb likewise could not carry sockets across a session, so we FORKED it
//          (@iterate-com/capnweb: webSocket-in-Response rides the session as a stream pair).
//      THE DAY workerd + capnweb serialize WebSockets over plain RPC methods, everything fenced
//      "WORKAROUND" below is DELETED — plus its (pure-deletion) call sites, enumerated at the
//      fence — and a lent rpc stub's terminal fetch simply rides the plain invoke() walk like
//      every other call, its Response flowing back over the RPC legs.
//

// ── THE ITX-EXPRESSION FETCH LANE (the `x-itx-expression` door) ──
// A fetch-shaped capability is reached over HTTP by naming an itx expression in this header (the
// edge worker copies `/expression?itx=` into it). The DO rewrites the expression through its rules
// and the provider's Response — 101s included — flows back out natively.

export const ITX_EXPRESSION_FETCH_HEADER = "x-itx-expression";

/** THE one reader of the terminal-fetch shape: the steps before a terminal `fetch` step and that
 *  step's expression args (`[]` for the property spelling `[..., "fetch"]`), or null when the
 *  expression does not end in `fetch`. */
function splitTerminalFetch(
  expression: ItxExpression,
): { steps: ItxExpression; fetchArgs: unknown[] } | null {
  const last = expression.at(-1);
  if (last === "fetch") return { steps: expression.slice(0, -1), fetchArgs: [] };
  if (Array.isArray(last) && last[0] === "fetch")
    return { steps: expression.slice(0, -1), fetchArgs: last.slice(1) };
  return null;
}

/** Normalize any spelling to the canonical terminal-fetch call (doctrine point 1): strip a
 *  trailing `fetch` step (property or call) and append the one `fetch` PROPERTY step — the live
 *  Request always rides as the runtime arg, never as expression data. A `fetch(...)` call
 *  carrying expression args is a LOUD error: the author meant something the lane cannot do. */
export function itxExpressionEndingInFetch(expr: ItxExpression): ItxExpression {
  const terminal = splitTerminalFetch(expr);
  if (terminal && terminal.fetchArgs.length > 0)
    throw new Error(
      `fetch takes no expression args — the live Request rides in as the runtime arg (got ${JSON.stringify(terminal.fetchArgs)})`,
    );
  return [...(terminal?.steps ?? expr), "fetch"];
}

/** A LIVE call that is the terminal fetch carrying the one Request — `[..., ["fetch", request]]`, or
 *  `[..., "fetch"]` with the Request as the one runtime arg (`invoke("itx.laptop.fetch", request)`)
 *  — split into the steps before `fetch` and the Request; null for any other call. Its readers (the
 *  edge, the directory) route it down a real fetch hop: doctrine point 4. */
export function terminalFetchOf(
  expression: ItxExpression,
  args: unknown[],
): { steps: ItxExpression; request: Request } | null {
  const terminal = splitTerminalFetch(expression);
  if (!terminal) return null;
  const [request, ...rest] = [...terminal.fetchArgs, ...args];
  return rest.length === 0 && request instanceof Request
    ? { steps: terminal.steps, request }
    : null;
}

// ═══════════════════════════════════ WORKAROUND ══════════════════════════════════════
// Everything below exists ONLY because of doctrine point 4 (workerd RPC cannot carry sockets;
// see the header). It serves fetch calls on LENT RPC STUBS — capabilities backed by a running
// client reached over an RPC leg (a capnweb client via the /api relay, or a dynamic worker via
// env.ITX) rather than by loadable code. The mechanism:
//
//   DO side (RpcStubFetchServer.serve): mint an upgradeId, call the borrowed stub's
//   `fetch(upgradeId, itxExpressionSteps, request)` — that call EXECUTES in the lender's own
//   request context, the one place the provider's answer is legally touchable.
//
//   Transport side (dialRpcStubFetch): dial the provider's real fetch. A socketless
//   Response returns over the RPC leg as-is (it serializes fine). A socket-bearing one CANNOT —
//   so the socket is accepted right there, ONE dedicated "upgrade leg" WebSocket is opened back
//   into the DO (a fetch upgrade carrying `x-itx-fetch-upgrade` → acceptFetchUpgradeLeg, correlated
//   with the eyeball by the upgradeId tag alone — an unguessable UUID; nothing gates the door),
//   frames are wired provider⇄leg, and a plain marker returns instead.
//
//   DO side again: on the marker, mint the eyeball's WebSocketPair natively (the DO ↔ eyeball
//   hop is a real fetch — socket-legal) and forward frames eyeball⇄leg by tag. Both DO-side
//   sockets are hibernatable, so an open upgrade survives eviction and costs nothing idle.
//
// DELETE-DAY CHECKLIST (all deletions, nothing rewritten): remove this whole fenced section,
// then delete its call sites —
//   • the terminal-fetch branch in RpcStubDirectory.invokeRpcStub, the directory's `rpcStubFetch`
//     dep + `#rpcStubFetch` field, and the `RpcStubFetchTransport &` half of BorrowedRpcStub
//     (the directory section);
//   • LentRpcStub's `fetch` method (the relay section);
//   • the context DO's `#rpcStubFetch` field, its acceptFetchUpgradeLeg door, and the
//     handleWebSocketMessage/Close forwarding (iterate-context-durable-object.ts).
// Terminal-fetch calls then ride the plain invoke() walk like any other call, their Responses —
// sockets included — crossing the RPC legs.
// ═════════════════════════════════════════════════════════════════════════════════════

const FETCH_UPGRADE_SOCKET_HEADER = "x-itx-fetch-upgrade";

/** One upgrade socket's attachment (survives hibernation — so the upgrade does too): which
 *  upgrade it belongs to and which SIDE it is (`eyeball` = the caller's pair half, `leg` = the
 *  transport's dedicated socket). The peer is the same upgradeId on the other side. */
type FetchUpgradeAttachment = { fetchUpgrade: { upgradeId: string; side: "eyeball" | "leg" } };
const upgradeTag = (side: "eyeball" | "leg", upgradeId: string) =>
  `itx-fetch-upgrade-${side}:${upgradeId}`;

/** The transport's answer when the provider upgraded: the socket already rides the dedicated
 *  leg, so only this marker crosses the RPC hop. */
type FetchUpgradeMarker = { webSocketUpgrade: true };

/** What `serve` needs from the borrowed rpc stub: the fetch dial. */
export type RpcStubFetchTransport = {
  fetch(upgradeId: string, itxExpressionSteps: ItxExpression, request: Request): Promise<unknown>;
};

/** workerd enforces the RFC's 123-BYTE (UTF-8) close-reason cap and THROWS over it — a UTF-16
 *  .slice(0, 123) is not enough for multibyte reasons. Truncate by encoded bytes, whole chars. */
function truncateCloseReason(reason: string): string {
  if (new TextEncoder().encode(reason).length <= 123) return reason;
  let out = reason;
  while (out.length > 0 && new TextEncoder().encode(out).length > 123) out = out.slice(0, -1);
  return out;
}

/** Close codes a handler may pass to close(): 1000 or app codes; everything reserved/invalid
 *  (1004-1006, 1015, out-of-range — e.g. an abnormal-closure 1006 being FORWARDED) clamps to 1000. */
function clampCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if (code >= 1001 && code <= 1003) return code;
  if (code >= 1007 && code <= 1014) return code;
  return 1000;
}

/** The WebSocket a client's fetch answered with (capnweb's TunneledWebSocket satisfies it). */
type ClientWebSocket = {
  accept?(): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    cb: (ev: { data?: unknown; code?: number; reason?: string }) => void,
  ): void;
};

/** TRANSPORT SIDE of an rpc-stub fetch (runs where the client's stub is legally touchable —
 *  today that is the capnweb session's request context; a NATIVE provider's socket answer still
 *  dies on its own RPC leg, pinned in fetch-door.e2e.test.ts — a future dial-back fix must
 *  deliver the upgradeId to the provider WITHOUT riding the Request headers verbatim, because a
 *  provider that forwards its received Request would smuggle the header back into our own
 *  upgrade-leg door). Dials the provider's real fetch and branches ONLY on the answer:
 *    • socketless Response → returned as-is (crosses the RPC leg fine);
 *    • socket-bearing Response → accept the socket HERE, open the dedicated upgrade leg into the
 *      DO, wire the frames, and return the marker instead. */
async function dialRpcStubFetch(
  providerFetch: (request: Request) => Promise<unknown>,
  request: Request,
  upgradeId: string,
  durableObject: { fetch(url: string, init?: RequestInit): Promise<Response> },
): Promise<Response | FetchUpgradeMarker> {
  const response = (await providerFetch(request)) as {
    status?: number;
    webSocket?: ClientWebSocket | null;
  };
  const providerSocket = response?.webSocket;
  if (!providerSocket) return response as unknown as Response;
  // Leg first, listeners second, accept LAST — accepting before the awaited leg round-trip would
  // drop any frame the provider sends immediately after upgrading (a server hello). The leg is a
  // plain fetch upgrade into the DO, opened mid-dial: the DO is awaiting the dial RPC and serves
  // this upgrade concurrently (no deadlock, probed); frames ride it RAW.
  const legResponse = await durableObject.fetch("https://fetch-upgrade.internal/", {
    headers: { Upgrade: "websocket", [FETCH_UPGRADE_SOCKET_HEADER]: upgradeId },
  });
  const leg = legResponse.webSocket;
  if (!leg) throw new Error(`fetch-upgrade leg returned ${legResponse.status} without a WebSocket`);
  leg.accept();
  const wire = (from: ClientWebSocket, to: ClientWebSocket) => {
    from.addEventListener("message", (ev) => {
      try {
        to.send(ev.data as string | ArrayBuffer);
      } catch {
        /* peer closing — its close event tears the pair down */
      }
    });
    from.addEventListener("close", (ev) => {
      try {
        to.close(clampCloseCode(ev.code), truncateCloseReason(ev.reason ?? ""));
      } catch {
        /* already closing */
      }
    });
  };
  wire(providerSocket, leg as unknown as ClientWebSocket);
  wire(leg as unknown as ClientWebSocket, providerSocket);
  providerSocket.accept?.();
  return { webSocketUpgrade: true };
}

/** DO SIDE of an rpc-stub fetch: the leg door, the eyeball pair, and the frame/close forwarding
 *  between them. One instance per DO, wired into its fetch / webSocketMessage / webSocketClose
 *  alongside the other doors. */
export class RpcStubFetchServer {
  readonly #ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;

  constructor(ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">) {
    this.#ctx = ctx;
  }

  /** Serve one fetch-shaped call on a lent rpc stub: dial through the transport; pass a plain
   *  Response straight through; on the upgrade marker, mint the eyeball's pair (the leg arrived
   *  during the dial — the dial awaits its 101) — a real 101 only after the provider actually
   *  upgraded. Provider failures throw through with their own words (the fetch lane answers non-101). */
  async serve(
    transport: RpcStubFetchTransport,
    itxExpressionSteps: ItxExpression,
    request: Request,
  ): Promise<unknown> {
    const upgradeId = crypto.randomUUID();
    const result = await transport.fetch(upgradeId, itxExpressionSteps, request);
    if ((result as Partial<FetchUpgradeMarker> | null)?.webSocketUpgrade !== true) return result;
    return this.#acceptUpgradeSocket("eyeball", upgradeId);
  }

  /** Mint + hibernatably accept ONE side of an upgrade (tagged and attached for peer routing),
   *  answering a real 101 carrying the other half of the pair. */
  #acceptUpgradeSocket(side: "eyeball" | "leg", upgradeId: string): Response {
    const pair = new WebSocketPair();
    this.#ctx.acceptWebSocket(pair[1], [upgradeTag(side, upgradeId)]);
    pair[1].serializeAttachment({
      fetchUpgrade: { upgradeId, side },
    } satisfies FetchUpgradeAttachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** PARTIAL FETCH: accept the transport's dedicated upgrade leg (opened mid-dial, carrying the
   *  dial's upgradeId — the tag is the correlation). */
  acceptFetchUpgradeLeg(request: Request): Response | null {
    const upgradeId = request.headers.get(FETCH_UPGRADE_SOCKET_HEADER);
    if (upgradeId === null) return null;
    return this.#acceptUpgradeSocket("leg", upgradeId);
  }

  /** Route one WebSocket message: TRUE = an upgrade frame, forwarded RAW to its peer socket
   *  (eyeball ⇄ leg by upgradeId tag). FALSE = not this subsystem's socket. */
  handleWebSocketMessage(ws: WebSocket, data: string | ArrayBuffer): boolean {
    const peer = this.#peerOf(ws);
    if (peer === undefined) return false;
    if (peer === null) return true; // peer already gone — drop the frame; close handles teardown
    try {
      peer.send(data);
    } catch {
      /* peer closing — its close event tears the pair down */
    }
    return true;
  }

  /** Route one WebSocket close: TRUE = an upgrade socket — its peer is closed with it (each
   *  upgrade dies with its own socket pair; a dying transport closes its legs, which closes the
   *  eyeballs here, automatically, per socket). FALSE = not ours. */
  handleWebSocketClose(ws: WebSocket, code = 1000, reason = ""): boolean {
    const peer = this.#peerOf(ws);
    if (peer === undefined) return false;
    try {
      peer?.close(clampCloseCode(code), truncateCloseReason(reason));
    } catch {
      /* already closing */
    }
    // Also complete the handshake on the socket that closed: workerd's hibernatable API does NOT
    // auto-echo a peer-initiated close, so without this the initiator (an eyeball, or the relay's
    // leg) never sees its own close confirmed and hangs until its timeout.
    try {
      ws.close(clampCloseCode(code), truncateCloseReason(reason));
    } catch {
      /* already closing */
    }
    return true;
  }

  /** The OTHER side of an upgrade socket, or undefined (not ours) / null (peer gone). */
  #peerOf(ws: WebSocket): WebSocket | null | undefined {
    const upgrade = (ws.deserializeAttachment() as Partial<FetchUpgradeAttachment> | null)
      ?.fetchUpgrade;
    if (!upgrade) return undefined;
    const peerSide = upgrade.side === "eyeball" ? "leg" : "eyeball";
    return this.#ctx.getWebSockets(upgradeTag(peerSide, upgrade.upgradeId))[0] ?? null;
  }
}

// ════════════════════════════════ END WORKAROUND ═════════════════════════════════════
