// context/fetch-upgrade.ts — WORKAROUND: a lent rpc stub's fetch that answers with a WebSocket
// upgrade. This whole file exists because of two platform facts, and both are expected to go:
//   • workerd's Workers RPC cannot serialize a webSocket-bearing Response (DataCloneError): only
//     the FETCH CHANNEL (WorkerEntrypoint.fetch / DurableObject.fetch / service-binding fetch)
//     tunnels sockets, so anything that might carry a socket travels a real `.fetch()` hop, end to
//     end;
//   • capnweb could not carry sockets across a session either, so we FORKED it
//     (@iterate-com/capnweb: webSocket-in-Response rides the session as a stream pair).
//
// It serves fetch calls on LENT RPC STUBS (rpc-stubs.ts, doctrine point 3) — capabilities backed
// by a running client reached over an RPC leg (a capnweb client via the /api relay, or a dynamic
// worker via env.ITX) rather than by loadable code. The mechanism:
//
//   DO side (RpcStubFetchServer.serve): mint an upgradeId, call the borrowed stub's
//   `fetch(upgradeId, itxExpressionSteps, request)` — that call EXECUTES in the lender's own
//   request context, the one place the provider's answer is legally touchable.
//
//   Transport side (dialRpcStubFetch): dial the provider's real fetch. A socketless
//   Response returns over the RPC leg as-is (it serializes fine). A socket-bearing one CANNOT —
//   so the socket is accepted right there, ONE dedicated "upgrade leg" WebSocket is opened back
//   into the DO (a fetch upgrade carrying `x-itx-fetch-upgrade` → acceptFetchUpgradeLeg, correlated
//   with the eyeball by the upgradeId tag alone — an unguessable UUID; nothing else gates it),
//   frames are wired provider⇄leg, and a plain marker returns instead.
//
//   DO side again: on the marker, mint the eyeball's WebSocketPair natively (the DO ↔ eyeball
//   hop is a real fetch — socket-legal) and forward frames eyeball⇄leg by tag. Both DO-side
//   sockets are hibernatable, so an open upgrade survives eviction and costs nothing idle.
//
//   A PROJECT HOST'S upgrade is RESUMABLE (the lend's recovery [F], rpc-stubs.ts): the edge holds
//   the visitor's socket and the relay the provider's, and the two DO-side sockets carry the
//   splice's wire (fetch-upgrade-splice.ts), so a DO reset — every deploy — or a dropped socket is
//   re-dialed and resumed, never seen by the visitor (`spliceEyeballAnswer` on the edge,
//   `dialRpcStubFetch` on the relay, a re-dialed side replacing the older socket in
//   `acceptFetchUpgradeLeg`).
//
// DELETE-DAY CHECKLIST (all deletions, nothing rewritten): the day workerd and capnweb serialize
// WebSockets over plain RPC methods, delete this file, then its call sites —
//   • the terminal-fetch branch in RpcStubDirectory.invokeRpcStub, the directory's `rpcStubFetch`
//     dep + `#rpcStubFetch` field, the `RpcStubFetchTransport &` half of BorrowedRpcStub, and the
//     two `FETCH_UPGRADE_*` entries in `stampCallerHeaders` (rpc-stubs.ts);
//   • LentRpcStub's `fetch` method (rpc-stub-relay.ts);
//   • the context DO's `#rpcStubFetch` field, its acceptFetchUpgradeLeg handler, and the
//     handleWebSocketMessage/Close forwarding (iterate-context-durable-object.ts);
//   • the edge's `spliceEyeballAnswer` and its resumable ask (worker.ts) — unless a socket over RPC
//     still dies with the DO's reset, in which case the splice moves onto whatever replaces this.
// Terminal-fetch calls then ride the plain invoke() walk like any other call, their Responses —
// sockets included — crossing the RPC legs.

import { z } from "zod";
import type { ItxExpression } from "iterate/expression";
import {
  contextAbortedOffsetOf,
  FETCH_UPGRADE_CONTEXT_ABORTED_OFFSET_HEADER,
  FETCH_UPGRADE_DEPLOY_ID_HEADER,
  FetchUpgradeSpliceEnd,
  reportFetchUpgradeSpliceEvent,
  type SpliceSocket,
  visitorEndOfSplice,
} from "./fetch-upgrade-splice.ts";
import { relayedCloseCode, truncateCloseReason } from "./websocket-close.ts";

/** The transport's upgrade-leg dial: its value is the upgradeId. */
export const FETCH_UPGRADE_SOCKET_HEADER = "x-itx-fetch-upgrade";
/** The edge's re-dial of a resumable upgrade's EYEBALL side after a drop (fetch-upgrade-splice.ts):
 *  its value is the upgradeId. */
export const FETCH_UPGRADE_EYEBALL_HEADER = "x-itx-fetch-upgrade-eyeball";
/** THE EDGE ASKS FOR A RESUMABLE UPGRADE (a project host's upgrade, worker.ts): the edge holds the
 *  visitor's socket and speaks the splice's wire on the eyeball side (fetch-upgrade-splice.ts). Rides
 *  the Request through the config worker to the serving context; the transport strips it before the
 *  provider sees the Request. */
export const FETCH_UPGRADE_RESUMABLE_HEADER = "x-itx-fetch-upgrade-resumable";
/** THE ANSWER THAT IT IS: on the eyeball's 101, JSON `FetchUpgradeResume` — what the edge re-dials
 *  (the upgradeId, the context that serves it) and the deploy that answered. */
const FETCH_UPGRADE_RESUME_HEADER = "x-itx-fetch-upgrade-resume";
const FetchUpgradeResume = z.object({
  upgradeId: z.string().min(1),
  path: z.string().startsWith("/"),
  deployId: z.string(),
});
type FetchUpgradeResume = z.infer<typeof FetchUpgradeResume>;

/** One upgrade socket's attachment (survives hibernation — so the upgrade does too): which
 *  upgrade it belongs to and which SIDE it is (`eyeball` = the caller's pair half, `leg` = the
 *  transport's dedicated socket). The peer is the same upgradeId on the other side. `replaced`: a
 *  re-dial of the same side took over, so this socket is neither a peer nor closes one. */
type FetchUpgradeAttachment = {
  fetchUpgrade: { upgradeId: string; side: "eyeball" | "leg"; replaced?: true };
};
const upgradeTag = (side: "eyeball" | "leg", upgradeId: string) =>
  `itx-fetch-upgrade-${side}:${upgradeId}`;

/** The transport's answer when the provider upgraded: the socket already rides the dedicated
 *  leg, so only this marker crosses the RPC hop — with the provider's 101 headers the eyeball's 101
 *  must repeat (`FETCH_UPGRADE_RESPONSE_HEADERS`). */
type FetchUpgradeMarker = {
  webSocketUpgrade: true;
  headers: [name: string, value: string][];
};

/** The provider's 101 response headers the eyeball's 101 carries: the subprotocol it chose. A browser
 *  that asked for one (Vite's HMR client asks for `vite-hmr`) fails the handshake on a 101 that names
 *  none. Not `Sec-WebSocket-Extensions`: the eyeball socket is the runtime's own, which negotiates its
 *  extensions itself; nor `Sec-WebSocket-Accept`, the runtime's too. */
const FETCH_UPGRADE_RESPONSE_HEADERS = ["sec-websocket-protocol"];

/** What `serve` needs from the borrowed rpc stub: the fetch dial. */
export type RpcStubFetchTransport = {
  fetch(upgradeId: string, itxExpressionSteps: ItxExpression, request: Request): Promise<unknown>;
};

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
 *  dies on its own RPC leg, pinned in fetch.e2e.test.ts — a future dial-back fix must
 *  deliver the upgradeId to the provider WITHOUT riding the Request headers verbatim, because a
 *  provider that forwards its received Request would smuggle the header back into our own
 *  upgrade-leg handler). Dials the provider's real fetch and branches ONLY on the answer:
 *    • socketless Response → returned as-is (crosses the RPC leg fine);
 *    • socket-bearing Response → accept the socket HERE, open the dedicated upgrade leg into the
 *      DO, wire the frames, and return the marker instead. A Request that asked for a resumable
 *      upgrade (`FETCH_UPGRADE_RESUMABLE_HEADER`, the edge's) gets the leg side of the splice
 *      (fetch-upgrade-splice.ts): the leg re-dials after a drop, and nothing the provider sent is
 *      lost. */
export async function dialRpcStubFetch(
  providerFetch: (request: Request) => Promise<unknown>,
  request: Request,
  upgradeId: string,
  durableObjectStub: () => { fetch(url: string, init?: RequestInit): Promise<Response> },
): Promise<Response | FetchUpgradeMarker> {
  const resumable = request.headers.has(FETCH_UPGRADE_RESUMABLE_HEADER);
  if (resumable) {
    // the platform's own protocol: never the provider's to see
    const headers = new Headers(request.headers);
    headers.delete(FETCH_UPGRADE_RESUMABLE_HEADER);
    request = new Request(request, { headers });
  }
  // The provider's fetch answers over capnweb or Workers RPC, typed unknown: only a Response's
  // status, headers and webSocket are read here, each as optional.
  const response = (await providerFetch(request)) as {
    status?: number;
    headers?: Headers;
    webSocket?: ClientWebSocket | null;
  };
  const providerSocket = response?.webSocket;
  if (!providerSocket) return response as unknown as Response; // the provider's own answer, untouched
  // Leg first, listeners second, accept LAST — accepting before the awaited leg round-trip would
  // drop any frame the provider sends immediately after upgrading (a server hello). The leg is a
  // plain fetch upgrade into the DO, opened mid-dial: the DO is awaiting the dial RPC and serves
  // this upgrade concurrently (no deadlock, probed); frames ride it RAW, or on the splice's wire.
  const dialLeg = () =>
    durableObjectStub().fetch("https://fetch-upgrade.internal/", {
      headers: { Upgrade: "websocket", [FETCH_UPGRADE_SOCKET_HEADER]: upgradeId },
    });
  const legResponse = await dialLeg();
  const leg = legResponse.webSocket;
  if (!leg) throw new Error(`fetch-upgrade leg returned ${legResponse.status} without a WebSocket`);
  leg.accept();
  if (resumable) {
    new FetchUpgradeSpliceEnd({
      side: "leg",
      upgradeId,
      // capnweb's TunneledWebSocket dispatches the runtime's own events (MessageEvent, CloseEvent)
      local: providerSocket as unknown as SpliceSocket,
      // the provider's socket closes without a status when the tunnel's session ends
      localGoneReason: "tunnel disconnected",
      socket: leg,
      deployId: legResponse.headers.get(FETCH_UPGRADE_DEPLOY_ID_HEADER),
      contextAbortedOffset: contextAbortedOffsetOf(legResponse),
      dial: dialLeg,
      report: reportFetchUpgradeSpliceEvent,
    });
  } else {
    const wire = (from: ClientWebSocket, to: ClientWebSocket) => {
      from.addEventListener("message", (ev) => {
        try {
          to.send(ev.data as string | ArrayBuffer); // a WebSocket message is text or binary
        } catch {
          /* peer closing — its close event tears the pair down */
        }
      });
      from.addEventListener("close", (ev) => {
        try {
          to.close(relayedCloseCode(ev.code), truncateCloseReason(ev.reason || ""));
        } catch {
          /* already closing */
        }
      });
    };
    // The leg is workerd's own WebSocket, which has every member ClientWebSocket names.
    wire(providerSocket, leg as unknown as ClientWebSocket);
    wire(leg as unknown as ClientWebSocket, providerSocket);
  }
  providerSocket.accept?.();
  const headers: [string, string][] = [];
  for (const name of FETCH_UPGRADE_RESPONSE_HEADERS) {
    const value = response.headers?.get(name);
    if (value) headers.push([name, value]);
  }
  return { webSocketUpgrade: true, headers };
}

/** EDGE SIDE of a resumable upgrade: a project host's 101 that says it is resumable
 *  (`FETCH_UPGRADE_RESUME_HEADER`) is answered with the edge's own pair, and the DO's socket becomes
 *  the eyeball side of the splice (fetch-upgrade-splice.ts), which re-dials the serving context —
 *  `contextOf(path)`, a context of the project the edge admitted — after a drop. Any other answer
 *  is returned as it is. The splice's headers never reach the visitor. */
export function spliceEyeballAnswer(
  answer: Response,
  contextOf: (path: string) => { fetch(url: string, init?: RequestInit): Promise<Response> },
): Response {
  const header = answer.headers.get(FETCH_UPGRADE_RESUME_HEADER);
  const eyeball = answer.webSocket;
  if (answer.status !== 101 || !eyeball || !header) return answer;
  // checked: it crossed the project's config worker on its way here
  const resume = FetchUpgradeResume.parse(JSON.parse(header));
  const headers = new Headers(answer.headers);
  headers.delete(FETCH_UPGRADE_RESUME_HEADER);
  headers.delete(FETCH_UPGRADE_CONTEXT_ABORTED_OFFSET_HEADER);
  const visitor = visitorEndOfSplice((local) => {
    eyeball.accept();
    new FetchUpgradeSpliceEnd({
      side: "eyeball",
      upgradeId: resume.upgradeId,
      local,
      localGoneReason: "visitor disconnected",
      socket: eyeball,
      deployId: resume.deployId,
      contextAbortedOffset: contextAbortedOffsetOf(answer),
      dial: () =>
        contextOf(resume.path).fetch("https://fetch-upgrade.internal/", {
          headers: { Upgrade: "websocket", [FETCH_UPGRADE_EYEBALL_HEADER]: resume.upgradeId },
        }),
      report: reportFetchUpgradeSpliceEvent,
    });
  });
  return new Response(null, { status: 101, webSocket: visitor, headers });
}

/** DO SIDE of an rpc-stub fetch: the upgrade leg, the eyeball pair, and the frame/close forwarding
 *  between them. One instance per DO, wired into its fetch / webSocketMessage / webSocketClose
 *  alongside the other handlers. */
export class RpcStubFetchServer {
  readonly #ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
  /** This DO's deploy and path: what a resumable upgrade's 101 says (`FetchUpgradeResume`). */
  readonly #deployId: string;
  readonly #path: string;
  /** The `itx/aborted` whose reset began this incarnation, or null: what every 101 names
   *  (`FETCH_UPGRADE_CONTEXT_ABORTED_OFFSET_HEADER`). Read per answer: the wake record lands after
   *  construction. */
  readonly #contextAbortedOffset: () => number | null;

  constructor(
    ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">,
    context: { deployId: string; path: string; contextAbortedOffset: () => number | null },
  ) {
    this.#ctx = ctx;
    this.#deployId = context.deployId;
    this.#path = context.path;
    this.#contextAbortedOffset = context.contextAbortedOffset;
  }

  /** Serve one fetch-shaped call on a lent rpc stub: dial through the transport; pass a plain
   *  Response straight through; on the upgrade marker, mint the eyeball's pair (the leg arrived
   *  during the dial — the dial awaits its 101) — a real 101 only after the provider actually
   *  upgraded, saying it is resumable when the Request asked (the leg then speaks the splice's
   *  wire). Provider failures throw through with their own words (the itx-expression fetch answers
   *  non-101). */
  async serve(
    transport: RpcStubFetchTransport,
    itxExpressionSteps: ItxExpression,
    request: Request,
  ): Promise<unknown> {
    const upgradeId = crypto.randomUUID();
    const result = await transport.fetch(upgradeId, itxExpressionSteps, request);
    // The transport answers the provider's own value or dialRpcStubFetch's marker; only
    // `webSocketUpgrade: true` makes it the marker.
    const marker = result as Partial<FetchUpgradeMarker> | null;
    if (marker?.webSocketUpgrade !== true) return result;
    const headers = [...(marker.headers || [])];
    if (request.headers.has(FETCH_UPGRADE_RESUMABLE_HEADER))
      headers.push([
        FETCH_UPGRADE_RESUME_HEADER,
        JSON.stringify({
          upgradeId,
          path: this.#path,
          deployId: this.#deployId,
        } satisfies FetchUpgradeResume),
      ]);
    return this.#acceptUpgradeSocket("eyeball", upgradeId, headers);
  }

  /** Mint + hibernatably accept ONE side of an upgrade (tagged and attached for peer routing),
   *  answering a real 101 carrying the other half of the pair and `headers` (the eyeball's: the
   *  provider's subprotocol; a dialed side's: this DO's deploy). */
  #acceptUpgradeSocket(
    side: "eyeball" | "leg",
    upgradeId: string,
    headers: [string, string][],
  ): Response {
    const pair = new WebSocketPair();
    this.#ctx.acceptWebSocket(pair[1], [upgradeTag(side, upgradeId)]);
    pair[1].serializeAttachment({
      fetchUpgrade: { upgradeId, side },
    } satisfies FetchUpgradeAttachment);
    const contextAbortedOffset = this.#contextAbortedOffset();
    const answerHeaders: [string, string][] =
      contextAbortedOffset === null
        ? headers
        : [...headers, [FETCH_UPGRADE_CONTEXT_ABORTED_OFFSET_HEADER, String(contextAbortedOffset)]];
    return new Response(null, { status: 101, webSocket: pair[0], headers: answerHeaders });
  }

  /** PARTIAL FETCH: accept the transport's dedicated upgrade leg (opened mid-dial, carrying the
   *  dial's upgradeId — the tag is the correlation), or a resumable upgrade's side dialed again
   *  after a drop (the leg by the transport, the eyeball by the edge). The newest socket of a side
   *  wins: an older one still open is replaced, closed without closing its peer. */
  acceptFetchUpgradeLeg(request: Request): Response | null {
    const legUpgradeId = request.headers.get(FETCH_UPGRADE_SOCKET_HEADER);
    const eyeballUpgradeId = request.headers.get(FETCH_UPGRADE_EYEBALL_HEADER);
    if (!legUpgradeId && !eyeballUpgradeId) return null;
    const [side, upgradeId] = legUpgradeId
      ? ["leg" as const, legUpgradeId]
      : ["eyeball" as const, eyeballUpgradeId!];
    for (const older of this.#ctx.getWebSockets(upgradeTag(side, upgradeId))) {
      // every socket under an upgrade tag was stamped with this attachment as it was accepted
      const attachment = older.deserializeAttachment() as FetchUpgradeAttachment;
      older.serializeAttachment({
        fetchUpgrade: { ...attachment.fetchUpgrade, replaced: true },
      } satisfies FetchUpgradeAttachment);
      try {
        older.close(1000, "replaced");
      } catch {
        /* already closing */
      }
    }
    return this.#acceptUpgradeSocket(side, upgradeId, [
      [FETCH_UPGRADE_DEPLOY_ID_HEADER, this.#deployId],
    ]);
  }

  /** Route one WebSocket message: TRUE = an upgrade frame, forwarded RAW to its peer socket
   *  (eyeball ⇄ leg by upgradeId tag). FALSE = not this subsystem's socket. */
  handleWebSocketMessage(ws: WebSocket, data: string | ArrayBuffer): boolean {
    const peer = this.#peerOf(ws);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- #peerOf returns a real three-way: undefined = not ours, null = ours-but-peer-gone, WebSocket = live
    if (peer === undefined) return false;
    if (!peer) return true; // peer already gone — drop the frame; close handles teardown
    try {
      peer.send(data);
    } catch {
      /* peer closing — its close event tears the pair down */
    }
    return true;
  }

  /** Route one WebSocket close: TRUE = an upgrade socket — its peer is closed with it (each
   *  upgrade dies with its own socket pair; a dying transport closes its legs, which closes the
   *  eyeballs here, automatically, per socket; a resumable upgrade's ends take the close as a drop
   *  and re-dial). FALSE = not ours. A replaced socket closes alone. */
  handleWebSocketClose(ws: WebSocket, code = 1000, reason = ""): boolean {
    const peer = this.#peerOf(ws);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- #peerOf three-way: undefined = not ours (bail); null = ours-but-peer-gone (fall through to still close ws below)
    if (peer === undefined) return false;
    try {
      peer?.close(relayedCloseCode(code), truncateCloseReason(reason));
    } catch {
      /* already closing */
    }
    // Also complete the handshake on the socket that closed: workerd's hibernatable API does NOT
    // auto-echo a peer-initiated close, so without this the initiator (an eyeball, or the relay's
    // leg) never sees its own close confirmed and hangs until its timeout.
    try {
      ws.close(relayedCloseCode(code), truncateCloseReason(reason));
    } catch {
      /* already closing */
    }
    return true;
  }

  /** The OTHER side of an upgrade socket, or undefined (not ours) / null (peer gone, or this socket
   *  was replaced: it has no peer). */
  #peerOf(ws: WebSocket): WebSocket | null | undefined {
    // Any of the DO's sockets comes here, so the attachment may be another subsystem's, or none; a
    // socket under an upgrade tag was stamped with FetchUpgradeAttachment as it was accepted.
    const upgrade = (ws.deserializeAttachment() as Partial<FetchUpgradeAttachment> | null)
      ?.fetchUpgrade;
    if (!upgrade) return undefined;
    if (upgrade.replaced) return null;
    const peerSide = upgrade.side === "eyeball" ? "leg" : "eyeball";
    // the peer's sockets are found by their upgrade tag, so each carries FetchUpgradeAttachment
    return (
      this.#ctx
        .getWebSockets(upgradeTag(peerSide, upgrade.upgradeId))
        .find(
          (socket) =>
            !(socket.deserializeAttachment() as FetchUpgradeAttachment).fetchUpgrade.replaced,
        ) ?? null
    );
  }
}
