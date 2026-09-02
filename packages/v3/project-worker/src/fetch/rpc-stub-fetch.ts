// fetch/rpc-stub-fetch.ts — EVERYTHING about serving FETCH-SHAPED capabilities, in one place.
//
// THE DOCTRINE (read this and you can skip the rest of the file):
//
//   1. Some capabilities are FETCH-SHAPED: `(request: Request) => Promise<Response>`. They are
//      ALWAYS called through a terminal `fetch` — `itx.site.fetch(request)`, never a method of
//      any other name. `expressionEndingInFetch` (below) is the one normalizer that enforces the
//      spelling at the fetch lane.
//
//   2. Some fetch-shaped capabilities answer with a WEBSOCKET UPGRADE (a 101 Response carrying
//      `webSocket`). Whether a given fetch upgrades is the PROVIDER'S decision, expressed in its
//      answer — nothing here ever inspects the request to guess.
//
//   3. Fetch-shaped calls enter through TWO doors, both landing here: over HTTP via the
//      capability fetch lane (`x-itx-cap`, below), and over the dotted door — any terminal
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
import type { ItxExpression } from "../context/expression.ts";

/** The two hibernation-API hooks the DO-side machinery needs (`ctx.acceptWebSocket` /
 *  `ctx.getWebSockets`). Timeless — the stub pager uses it too. */
export type WebSocketHooks = {
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  getWebSockets(tag: string): WebSocket[];
};

// ── THE CAPABILITY FETCH LANE (the `x-itx-cap` door) ──
// A fetch-shaped capability is reached over HTTP by naming an itx expression in this header (the
// edge worker copies `?cap=` into it). The DO resolves the expression against its capability
// table and the provider's Response — 101s included — flows back out natively.

export const CAPABILITY_FETCH_HEADER = "x-itx-cap";

/** Normalize any spelling to the canonical terminal-fetch call (doctrine point 1): strip a
 *  trailing `fetch` step (property or call) and append the one `fetch` PROPERTY step — the live
 *  Request always rides as the runtime arg, never as expression data. A `fetch(...)` call
 *  carrying expression args is a LOUD error: the author meant something the lane cannot do. */
export function expressionEndingInFetch(expr: ItxExpression): ItxExpression {
  const last = expr.at(-1);
  if (Array.isArray(last) && last[0] === "fetch" && last.length > 1)
    throw new Error(
      `fetch takes no expression args — the live Request rides in as the runtime arg (got ${JSON.stringify(last.slice(1))})`,
    );
  const endsInFetch = last === "fetch" || (Array.isArray(last) && last[0] === "fetch");
  return [...(endsInFetch ? expr.slice(0, -1) : expr), "fetch"];
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
//   into the DO (a fetch upgrade carrying `x-itx-fetch-upgrade` → acceptFetchUpgradeLeg, gated on
//   the pending upgradeId), frames are wired provider⇄leg, and a plain marker returns instead.
//
//   DO side again: on the marker, mint the eyeball's WebSocketPair natively (the DO ↔ eyeball
//   hop is a real fetch — socket-legal) and forward frames eyeball⇄leg by tag. Both DO-side
//   sockets are hibernatable, so an open upgrade survives eviction and costs nothing idle.
//
// DELETE-DAY CHECKLIST (all deletions, nothing rewritten): remove this whole fenced section,
// then delete its call sites —
//   • the terminal-fetch branch in RpcStubDirectory.invokeRpcStub, the directory's `rpcStubFetch`
//     dep + `#rpcStubFetch` field, and the `RpcStubFetchTransport &` half of BorrowedRpcStub
//     (rpc-stub-directory.ts);
//   • LentRpcStub's `fetch` method (rpc-stub-relay.ts);
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

/** The provider-side socket a dial may receive — capnweb's TunneledWebSocket satisfies it. */
type ProviderSocket = {
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
 *  dies on its own RPC leg, pinned in fetch-door-dynamic-live-ws.e2e.test.ts — a future dial-back fix must
 *  deliver the upgradeId to the provider WITHOUT riding the Request headers verbatim, because a
 *  provider that forwards its received Request would smuggle the header back into our own
 *  upgrade-leg door). Dials the provider's real fetch and branches ONLY on the answer:
 *    • socketless Response → returned as-is (crosses the RPC leg fine);
 *    • socket-bearing Response → accept the socket HERE, open the dedicated upgrade leg into the
 *      DO, wire the frames, and return the marker instead. */
export async function dialRpcStubFetch(
  providerFetch: (request: Request) => Promise<unknown>,
  request: Request,
  upgradeId: string,
  host: { fetch(url: string, init?: RequestInit): Promise<Response> },
): Promise<Response | FetchUpgradeMarker> {
  const response = (await providerFetch(request)) as {
    status?: number;
    webSocket?: ProviderSocket | null;
  };
  const providerSocket = response?.webSocket;
  if (!providerSocket) return response as unknown as Response;
  // Leg first, listeners second, accept LAST — accepting before the awaited leg round-trip would
  // drop any frame the provider sends immediately after upgrading (a server hello). The leg is a
  // plain fetch upgrade into the DO, opened mid-dial: the DO is awaiting the dial RPC and serves
  // this upgrade concurrently (no deadlock, probed); frames ride it RAW.
  const legResponse = await host.fetch("https://fetch-upgrade.internal/", {
    headers: { Upgrade: "websocket", [FETCH_UPGRADE_SOCKET_HEADER]: upgradeId },
  });
  const leg = legResponse.webSocket;
  if (!leg) throw new Error(`fetch-upgrade leg returned ${legResponse.status} without a WebSocket`);
  leg.accept();
  const wire = (from: ProviderSocket, to: ProviderSocket) => {
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
  wire(providerSocket, leg as unknown as ProviderSocket);
  wire(leg as unknown as ProviderSocket, providerSocket);
  providerSocket.accept?.();
  return { webSocketUpgrade: true };
}

/** DO SIDE of an rpc-stub fetch: the leg door, the eyeball pair, and the frame/close forwarding
 *  between them. One instance per DO, wired into its fetch / webSocketMessage / webSocketClose
 *  alongside the other doors. */
export class RpcStubFetchServer {
  readonly #hooks: WebSocketHooks;

  constructor(hooks: WebSocketHooks) {
    this.#hooks = hooks;
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
    this.#hooks.acceptWebSocket(pair[1], [upgradeTag(side, upgradeId)]);
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
    return this.#hooks.getWebSockets(upgradeTag(peerSide, upgrade.upgradeId))[0] ?? null;
  }
}

// ════════════════════════════════ END WORKAROUND ═════════════════════════════════════
