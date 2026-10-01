// context/rpc-stubs.ts — THE RPC STUBS: `itx.rpcStubs`, a client's live object lent to a context
// Durable Object without pinning it awake. Three modules:
//   rpc-stubs.ts       — the DO side: the borrowed table and the pagers (`RpcStubDirectory`), and
//                        how a fetch-shaped call is spelled and stamped (the fetch section below)
//   rpc-stub-relay.ts  — the edge side: the pager, its re-dial, and the page's answer
//                        (`lendRpcStubOverPager`)
//   fetch-upgrade.ts   — WORKAROUND: the transport under a lent stub's fetch that upgrades
//
// THE LEND'S STATE MACHINE. A lent stub's state lives in three places, one per hop, and each
// recovery ([A]–[F], below the diagrams) answers the one failure its own hop can see.
//
// 1. THE LEND, in the relay (`lendRpcStubOverPager`): one per provide or subscribe of a live stub,
//    for the life of the client's session.
//
//      dial ──refused or thrown──▶ nothing lent (the caller gets the refusal's code)
//        │ 101
//        ▼
//      SERVING ──page──▶ lendRpcStub, lent again if the platform cut it [A] ──▶ SERVING
//        │  │  │
//        │  │  └─ close ≠ 1000, or 3 keepalives unanswered [B] ──▶ REDIALING ──101──▶ SERVING
//        │  │                                                          │ refused, or 60 s
//        │  └─ close 1000 (the DO replaced the pager), dispose,        ▼
//        └──── the client's session broke ─────────────────────────▶ ENDED ──▶ lendEnded() [E]
//
// 2. THE KEY, in the context DO (`RpcStubDirectory`), in memory:
//
//      ABSENT ──pager attach (appends what names the key)──▶ OFFERED ──call──▶ PAGING
//      PAGING ──the relay lends──▶ BORROWED        PAGING ──10 s──▶ OFFERED (its calls fail)
//      PAGING ──the pager replaced──▶ PAGING (the page sent again down the new pager)
//      BORROWED ──a call the transport broke; the pins' release; the pager replaced──▶ OFFERED
//      OFFERED ──the DO hibernates and wakes──▶ OFFERED (a pager's attachment rides the eviction)
//      any ──the key's last pager closes──▶ ABSENT (`detached`: what named the key is un-set)
//      any ──the DO resets (no close handler runs)──▶ ABSENT, what named the key still set [D]
//
// 3. A LENT CALL, in the relay (`whileClientAnswers`): unanswered for 10 s ──▶ a liveness probe
//    [C]; the probe unanswered 10 s more ──▶ RPC_STUB_OFFLINE, and the lend stays.
//
// THE RECOVERIES. Each is the only answer to its failure; none covers another's.
//   [A] relend      A page's `lendRpcStub` cut in flight: a burst of lends drops the relay's RPC
//                   connection to the DO while the pager stays up, so no re-dial runs. Lent again
//                   on RELAY_BURST, inside the DO's 10 s page timeout (rpc-stub-relay.ts
//                   `answerPage`).
//   [B] re-dial     The pager dropped (a DO reset, every deploy; a fault on the hop) or went
//                   silent with its close held back (the keepalive). Re-dialed for 60 s
//                   (redial.ts); the attach re-appends what names the key, so the lend outlives
//                   the drop.
//   [C] probe       The client's network vanished without a close: its calls fail in ~20 s, not
//                   when the edge's TCP gives up.
//   [D] census      A DO reset took the key's last pager with no close handler run, or a pause
//                   refused the un-set: the `woken` or `resumed` commit un-sets what names a key no
//                   pager or borrowed stub holds (iterate-context-durable-object.ts); a live
//                   lender's re-dial [B] sets it again.
//   [E] lend again  The lend ended under a live session (the re-dial gave up; the DO closed the
//                   pager): `lendEnded()` says why, and `iterate tunnel` provides again
//                   (core/lib/src/cli/tunnel.ts).
//   [F] splice      A WebSocket upgrade through a lent stub's fetch outlives the DO's sockets
//                   (fetch-upgrade-splice.ts).

import { failureKind } from "iterate/platform-retry";
import { codedError, errorCode, ITERATE_CAUSE_HEADER } from "iterate/lib";
import { ITERATE_ROUTING_SLUG_HEADER } from "iterate/project-ingress";
import { ITX_PRINCIPAL_HEADER } from "iterate/principal";
import type { StreamEventInput } from "iterate/stream/processor";
import { parse, type ItxExpression } from "iterate/expression";
import { causeHeader } from "../cause.ts";
import {
  ITX_APP_HEADER,
  ITX_CALLER_PATH_HEADER,
  ITX_GRANT_HEADER,
  type Caller,
} from "../caller.ts";
import {
  FETCH_UPGRADE_EYEBALL_HEADER,
  FETCH_UPGRADE_SOCKET_HEADER,
  type RpcStubFetchServer,
  type RpcStubFetchTransport,
} from "./fetch-upgrade.ts";

// ── rpc stub directory ── THE RPC STUBS, DO side: the `itx.rpcStubs` built-in's backing
// table — physical, never event-sourced. Two layers:
//
//   LAYER 1 — THE BORROWED RPC STUBS. Anyone with a Workers-RPC route to this DO can LEND a stub
//   under an OPAQUE key (`lendRpcStub`); the DO keeps it BORROWED — every call on that key rides
//   it — and RETURNS it at the pins' release (`returnBorrowedRpcStubs`), because a DO holding a stub
//   is pinned awake and this DO must hibernate with any number of clients attached. A lender with no
//   pager (below) is one-shot: after the return the key is offline until someone lends again.
//
//   LAYER 2 — THE RPC-STUB PAGERS. A hibernatable WebSocket per key, opened by the stateless edge
//   relay (rpc-stub-relay.ts), carrying `{ rpcStubKey }` in its attachment and nothing
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

// ── the wire: what the relay (rpc-stub-relay.ts) speaks to this side ──

export const RPC_STUB_PAGER_WEBSOCKET_HEADER = "x-itx-rpc-stub-pager";
/** What the pager upgrade's header carries: the key, and the events that NAME it — appended by the DO
 *  in the turn it accepts the pager (empty for a bare pager, the workers-project tests' probes). */
type RpcStubPagerAttachRequest = { rpcStubKey: string; appendEvents: StreamEventInput[] };
/** The header value: URI-encoded JSON — a header is a ByteString, a key or an event is not. */
export const encodeRpcStubPagerAttachRequest = (request: RpcStubPagerAttachRequest): string =>
  encodeURIComponent(JSON.stringify(request));
/** The inverse — throws on anything that is not a well-formed attach request. */
function decodeRpcStubPagerAttachRequest(header: string): RpcStubPagerAttachRequest {
  const decoded = JSON.parse(decodeURIComponent(header)) as Partial<RpcStubPagerAttachRequest>;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of JSON.parse output; the `Partial<...>` cast is a claim, not a guarantee
  if (typeof decoded?.rpcStubKey !== "string" || !Array.isArray(decoded.appendEvents))
    throw new Error("expected { rpcStubKey: string, appendEvents: [] }");
  return { rpcStubKey: decoded.rpcStubKey, appendEvents: decoded.appendEvents };
}
const RPC_STUB_PAGER_WEBSOCKET_TAG = "itx-rpc-stub-pager-websocket";
/** The pager keepalive pair — one shared definition for the edge sender and the DO's
 *  setWebSocketAutoResponse. DELIBERATELY distinctive literals: the auto-response is DO-WIDE
 *  (it also covers fetch-upgrade eyeball sockets), so a plain "ping" would silently hijack any
 *  client frame equal to it. */
export const RPC_STUB_PAGER_KEEPALIVE_REQUEST = "itx-pager-keepalive";
export const RPC_STUB_PAGER_KEEPALIVE_RESPONSE = "itx-pager-keepalive-ack";
/** How long a paged relay has to lend before this side calls it dead. The relay answers a page
 *  immediately, so 10 s is a dead relay, not a slow one. The relay's repeats of a lend the platform
 *  failed ([A], rpc-stub-relay.ts `answerPage`: `RELAY_BURST`) land well inside it. */
const RPC_STUB_PAGE_TIMEOUT_MS = 10_000;

/** WHAT THIS SIDE BORROWS: the Workers-RPC stub a lender hands over — TWO methods: `invoke(steps)`
 *  walks the itx-expression steps on the client's rpc stub (a DIRECT dotted dispatch — never
 *  `.apply`), and `fetch(upgradeId, steps, request)` is the rpc-stub fetch dial
 *  (fetch-upgrade.ts — dies with that WORKAROUND). */
export type BorrowedRpcStub = RpcStubFetchTransport & {
  invoke(itxExpressionSteps: ItxExpression): Promise<unknown>;
  dup?(): BorrowedRpcStub;
};

/** One pager socket's durable record — its attachment (survives hibernation). The key alone: the
 *  socket is its own identity. */
type RpcStubPagerRecord = { rpcStubKey: string };

/** THE one disposer for any RPC-ish stub (borrowed Workers-RPC legs here, the session's own capnweb
 *  stubs in the relay): a no-op for anything that is not disposable. */
export function disposeRpcStub(x: unknown): void {
  (x as Partial<Disposable> | null)?.[Symbol.dispose]?.();
}

export class RpcStubDirectory {
  readonly #ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
  /** PRESENCE as it changes: a key gained its (only) pager, or lost its last one. The DO turns these
   *  into the two ephemeral `itx/rpc-stub-attached` / `itx/rpc-stub-detached` events — live watchers see
   *  presence move; the log never claims a socket is open. A REPLACED pager (same key, new socket)
   *  is neither: the key never lost presence. */
  readonly #onPresence: (kind: "attached" | "detached", rpcStubKey: string) => void;
  /** The DO's rpc-stub fetch subsystem (fetch-upgrade.ts) — `invokeRpcStub` routes a
   *  terminal-fetch call into its serve(). */
  readonly #rpcStubFetch: RpcStubFetchServer;

  // LAYER 1 — the borrowed rpc stubs, in memory ONLY; returned at the pins' release
  // (context/residency.ts) — never per call, never on a timer (a pending timer would itself pin
  // the DO out of hibernation).
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

  /** The DO's append, SYNCHRONOUS (Stream.append is): what a pager attach carries is committed
   *  through it in the turn the pager is accepted; a refusal throws the coded error. */
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

  /** THE one call path behind `itx.rpcStubs.get(rpcStubKey)` — resolved calls and the delivery loop's
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
      // The terminal-fetch branch dies with fetch-upgrade.ts. Either way a lender that dies
      // mid-call is re-coded to RPC_STUB_OFFLINE at the relay, where the break is LOCAL
      // (rpc-stub-relay.ts).
      const terminalFetch = terminalFetchOf(itxExpressionSteps, []);
      if (terminalFetch)
        return await this.#rpcStubFetch.serve(borrowed, terminalFetch.steps, terminalFetch.request);
      return await borrowed.invoke(itxExpressionSteps);
    } catch (error) {
      // A BROKEN STUB IS DROPPED, NEVER KEPT: every later call on it would fail the same
      // way until the pins' release, while its pager may already lend a live one — so the NEXT call
      // pages again. Only the stub THIS call rode: a re-lend that landed meanwhile is the live one.
      // The failed call is not retried.
      // A lost connection is the lender's worker gone mid-call ("Network connection lost." when
      // the edge closed a dead client's socket): the stub is offline, coded so (a 502), never an
      // uncoded 500.
      const kind = failureKind(error);
      if (kind !== "disconnected" && kind !== "deploy-reset") throw error;
      if (this.#borrowedRpcStubs.get(rpcStubKey) === borrowed) {
        this.#borrowedRpcStubs.delete(rpcStubKey);
        disposeRpcStub(borrowed);
      }
      throw codedError(
        "RPC_STUB_OFFLINE",
        `rpc stub ${JSON.stringify(rpcStubKey)} went offline mid-call (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  /** Any stub borrowed right now (O(1)) — what makes the release timer worth starting. */
  hasBorrowedRpcStubs(): boolean {
    return this.#borrowedRpcStubs.size > 0;
  }

  /** THE IDLE RETURN (the pins' release in context/residency.ts, on its timer): give every
   *  borrowed stub back so the DO can hibernate. Losing them costs exactly one page on the next
   *  call — that is the deal. */
  returnBorrowedRpcStubs(): void {
    for (const rpcStubKey of this.#borrowedRpcStubs.keys()) this.#returnBorrowedRpcStub(rpcStubKey);
  }

  // ── LAYER 2: the pager upgrade (attach + the events that name the key) → pages → close ──

  /** PARTIAL FETCH (compose first in the DO's fetch): the pager upgrade (the header, above); `null` =
   *  not a pager upgrade. Accept, append, stamp in ONE synchronous turn, so a refused append
   *  leaves no socket, no presence and no row. */
  acceptRpcStubPagerWebSocket(request: Request): Response | null {
    const header = request.headers.get(RPC_STUB_PAGER_WEBSOCKET_HEADER);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an ABSENT header (null) means "not this request"; a present-but-empty one is malformed input that must fall through to the parse/tag below and be refused, never quietly treated as absent (the same present-vs-absent distinction the DO's `fetch` keeps)
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
      // The refusal IS the upgrade's answer — the error's code + message as JSON, so the relay
      // re-throws the same coded error to the caller. 409 = the DO refused (a coded refusal such as
      // STREAM_PAUSED); 500 = something uncoded.
      const code = errorCode(error);
      return Response.json(
        { code: code || null, message: error instanceof Error ? error.message : String(error) },
        { status: code ? 409 : 500 },
      );
    }
    // ONE pager per key, enforced when a pager becomes VISIBLE (a CONCURRENT provide at the same key
    // may still be opening its own, invisible to any earlier scan): drop every OTHER same-key socket
    // now — the newest wins. "replaced" is a swap, not a real close: a page in flight is the KEY's,
    // so it survives and is sent again down this pager (its timeout stays the backstop).
    for (const ws of this.#rpcStubPagerSockets())
      if (ws !== pair[1] && this.#rpcStubPagerRecord(ws).rpcStubKey === rpcStubKey)
        this.#dropReplacedRpcStubPager(ws);
    if (this.#rpcStubPagesInFlight.has(rpcStubKey)) pair[1].send(JSON.stringify({ type: "page" }));
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

  /** Close the replaced pager of a reconnect swap and give back the stub its relay lent. */
  #dropReplacedRpcStubPager(ws: WebSocket): void {
    this.#closedRpcStubPagerSockets.add(ws); // its late close event must not touch the key again
    try {
      ws.close(1000, "replaced");
    } catch {
      /* already closing */
    }
    this.#returnBorrowedRpcStub(this.#rpcStubPagerRecord(ws).rpcStubKey);
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
    if (!page) {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const arrived = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const timer = setTimeout(() => {
        if (!this.#rpcStubPagesInFlight.delete(rpcStubKey)) return;
        // Every call waiting on this page fails, and a push it carried is LOST: a live client's
        // delivery treats RPC_STUB_OFFLINE as heal-by-read (stream/subscription-delivery.ts), so
        // this line is the only trace of it (33 of 200 pushes, during a Cloudflare traffic move
        // on 2026-09-24).
        console.warn({
          event: "rpc-stub-page-timed-out",
          namespace: "rpc-stubs",
          message:
            "a paged relay did not lend within the page timeout: the calls waiting on it fail",
          rpcStubKey,
          waitedMs: RPC_STUB_PAGE_TIMEOUT_MS,
        });
        reject(
          codedError("RPC_STUB_OFFLINE", `rpc stub ${JSON.stringify(rpcStubKey)}: page timed out`),
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
    if (!borrowed)
      throw codedError(
        "RPC_STUB_OFFLINE",
        `rpc stub ${JSON.stringify(rpcStubKey)}: page answered empty`,
      );
    return borrowed;
  }

  /** Give back the stub borrowed under `rpcStubKey`, if one is. */
  #returnBorrowedRpcStub(rpcStubKey: string): void {
    const borrowed = this.#borrowedRpcStubs.get(rpcStubKey);
    if (!borrowed) return;
    this.#borrowedRpcStubs.delete(rpcStubKey);
    disposeRpcStub(borrowed);
  }

  /** A key's last pager is gone: return the stub it lent (its session died with it) and fail its
   *  page. */
  #returnRpcStubAndFailItsPage(rpcStubKey: string): void {
    this.#returnBorrowedRpcStub(rpcStubKey);
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

// ── rpc stub fetch ── how a FETCH-SHAPED capability is called, and the headers the context DO's
// `fetch` trusts.
//
// THE DOCTRINE:
//
//   1. Some capabilities are FETCH-SHAPED: `(request: Request) => Promise<Response>`. They are
//      ALWAYS called through a terminal `fetch` — `itx.site.fetch(request)`, never a method of
//      any other name. `itxExpressionEndingInFetch` (below) is the one normalizer that enforces the
//      spelling for an `x-itx-expression` fetch; `terminalFetchOf` is the one reader of the shape a LIVE call
//      carries.
//
//   2. Some fetch-shaped capabilities answer with a WEBSOCKET UPGRADE (a 101 Response carrying
//      `webSocket`). Whether a given fetch upgrades is the PROVIDER'S decision, expressed in its
//      answer — nothing here ever inspects the request to guess.
//
//   3. Fetch-shaped calls enter TWO ways, both landing here: over HTTP via an itx-expression fetch
//      (`x-itx-expression`, below), and over the dotted surface — any terminal
//      `.fetch(request)` on a lent rpc stub (`itx.<match>.fetch(...)` through a rewrite rule) is
//      recognized by the terminal-fetch branch of `RpcStubDirectory.invokeRpcStub` and routed into
//      `RpcStubFetchServer.serve`.
//
//   4. A lent rpc stub's fetch that answers a WebSocket upgrade cannot cross Workers RPC or a
//      capnweb session as a Response, so it travels a real `.fetch()` hop end to end:
//      fetch-upgrade.ts, a WORKAROUND whose delete-day checklist is its header. That day a lent
//      rpc stub's terminal fetch rides the plain invoke() walk like every other call.

// ── THE ITX-EXPRESSION FETCH (the `x-itx-expression` header) ──
// A fetch-shaped capability is reached over HTTP by naming an itx expression in this header — a
// session's terminal fetch, a located hop and a loaded worker's `env.ITX.fetch` set it. The DO rewrites the expression through its
// rules and the provider's Response — 101s included — flows back out natively.

export const ITX_EXPRESSION_FETCH_HEADER = "x-itx-expression";

/** The platform origin the caller reached the platform on (`Caller.platformOrigin` on the wire),
 *  set beside `ITX_EXPRESSION_FETCH_HEADER` by the edge (worker.ts) and a session's terminal fetch,
 *  and read and stripped by the context DO's `fetch`. Inbound `x-itx-*` headers never survive the
 *  edge, and `ItxEntrypoint.fetch` strips it from a loaded worker's Request, so an outsider's is gone
 *  before this is set. */
export const ITX_PLATFORM_ORIGIN_HEADER = "x-itx-platform-origin";

/** THE HOP'S CALLER STAMP: every header the DO's fetch trusts as the platform's — the caller's
 *  (principal, grant, caller path, app, platform origin, cause), the protocol's (the pager attach,
 *  which appends past every table, and the fetch-upgrade leg) and the expression a fetch names —
 *  replaced on `headers` by `caller`'s (`null`: none, and no routing slug either, for a Request
 *  leaving the platform). Every hop that forwards a Request stamps through here, so a Request's own
 *  copy of any of them never survives. An explicit list, not an `x-itx-*` sweep like the edge's
 *  (worker.ts). */
export function stampCallerHeaders(headers: Headers, caller: Caller | null): void {
  for (const name of [
    ITX_PRINCIPAL_HEADER,
    ITX_GRANT_HEADER,
    ITX_CALLER_PATH_HEADER,
    ITX_APP_HEADER,
    ITX_PLATFORM_ORIGIN_HEADER,
    RPC_STUB_PAGER_WEBSOCKET_HEADER,
    FETCH_UPGRADE_SOCKET_HEADER,
    FETCH_UPGRADE_EYEBALL_HEADER,
    ITERATE_CAUSE_HEADER,
    ITX_EXPRESSION_FETCH_HEADER,
  ])
    headers.delete(name);
  if (!caller) {
    headers.delete(ITERATE_ROUTING_SLUG_HEADER);
    return;
  }
  if (caller.cause) headers.set(ITERATE_CAUSE_HEADER, causeHeader(caller.cause));
  if (caller.principal) headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(caller.principal));
  if (caller.grant) headers.set(ITX_GRANT_HEADER, caller.grant);
  if (caller.path) headers.set(ITX_CALLER_PATH_HEADER, caller.path);
  if (caller.app) headers.set(ITX_APP_HEADER, "1");
  if (caller.platformOrigin) headers.set(ITX_PLATFORM_ORIGIN_HEADER, caller.platformOrigin);
}

/** THE ONE READER of an `x-itx-expression` header — untrusted: JSON (`encodeFetchExpression`) or
 *  dotted text (loaded code's own `env.ITX.fetch`), shape-checked by the resolver and walled before
 *  anything runs. One that does not parse is the caller's: INVALID_INPUT, answered 400. */
export function parseFetchExpression(header: string): ItxExpression {
  try {
    return header.trimStart().startsWith("[")
      ? (JSON.parse(header) as ItxExpression)
      : parse(header);
  } catch (error) {
    throw codedError(
      "INVALID_INPUT",
      `x-itx-expression ${JSON.stringify(header.slice(0, 200))} is no itx expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** JSON in an HTTP header must be ASCII: inline worker source may contain any Unicode text.
 * Keep ordinary JSON on the wire so existing expression readers can parse it unchanged. */
export function encodeFetchExpression(expression: ItxExpression): string {
  return JSON.stringify(expression).replace(
    /[\u0080-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

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
 *  carrying expression args is a LOUD error: the author meant something a fetch cannot do. */
export function itxExpressionEndingInFetch(expr: ItxExpression): ItxExpression {
  const terminal = splitTerminalFetch(expr);
  if (terminal && terminal.fetchArgs.length > 0)
    throw new Error(
      `fetch takes no expression args — the live Request rides in as the runtime arg (got ${JSON.stringify(terminal.fetchArgs)})`,
    );
  return [...(terminal?.steps || expr), "fetch"];
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
