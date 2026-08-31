// core/fetch-capabilities.ts — EVERYTHING about serving FETCH-SHAPED CAPABILITIES, in one place.
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
//      `.fetch(request)` on a LIVE capability (`itx.rpcStubs.get(k).fetch(...)`) is recognized by
//      `isFetchShapedCall` and routed into `LiveCapabilityFetchServer.serve`.
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
//      fence — and a live capability's terminal fetch simply rides the plain invoke() walk like
//      every other call, its Response flowing back over the RPC legs.
//
// THE COMPOSITION PATTERN — the "partial fetch": `(request) => Response | null`, where null means
// "not my door, try the next one". The stream DO's fetch is an ordered walk over partial fetches
// (its own doors plus the ones exported here) ending in the egress terminal — middleware without
// a framework.

import { errorCode } from "./errors.ts";
import { parse, type Expression } from "./expression.ts";

/** A composable door: answer the request, or `null` for "not mine — try the next door". */
export type PartialFetch = (request: Request) => Response | null | Promise<Response | null>;

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

/** The ENCODE side of the lane (exact mirror of `serveCapabilityFetchLane`'s parse): a dotted
 *  string rides verbatim, an Expression rides as JSON. Callers stamping the header use this so
 *  the two rules can never drift apart. */
export function encodeCapabilityFetchHeader(cap: string | Expression): string {
  return typeof cap === "string" ? cap : JSON.stringify(cap);
}

/** Normalize any spelling to the canonical terminal-fetch call (doctrine point 1): strip a
 *  trailing `fetch` step (property or call) and append the one `fetch` PROPERTY step — the live
 *  Request always rides as the runtime arg, never as expression data. A `fetch(...)` call
 *  carrying expression args is a LOUD error: the author meant something the lane cannot do. */
export function expressionEndingInFetch(expr: Expression): Expression {
  const last = expr.at(-1);
  if (Array.isArray(last) && last[0] === "fetch" && last.length > 1)
    throw new Error(
      `fetch takes no expression args — the live Request rides in as the runtime arg (got ${JSON.stringify(last.slice(1))})`,
    );
  const endsInFetch = last === "fetch" || (Array.isArray(last) && last[0] === "fetch");
  return [...(endsInFetch ? expr.slice(0, -1) : expr), "fetch"];
}

/** PARTIAL FETCH: the capability fetch lane. Parses the header (JSON Expression or dotted
 *  string), hands it to `resolveFetch` (the capability table's routed evaluation), and maps
 *  errors to honest statuses — classification by CODE, never message text. */
export async function serveCapabilityFetchLane(
  request: Request,
  resolveFetch: (expr: Expression, request: Request) => Promise<unknown>,
): Promise<Response | null> {
  const capHeader = request.headers.get(CAPABILITY_FETCH_HEADER);
  if (capHeader === null) return null;
  try {
    const expr = capHeader.trimStart().startsWith("[")
      ? (JSON.parse(capHeader) as Expression)
      : parse(capHeader === "itx" || capHeader.startsWith("itx.") ? capHeader : `itx.${capHeader}`);
    const result = await resolveFetch(expr, request);
    return result instanceof Response
      ? result
      : new Response(`fetch lane: ${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const status = errorCode(error) === "NO_CAPABILITY_MATCH" ? 404 : 500;
    return new Response(`fetch lane error: ${message}\n`, { status });
  }
}

// ═══════════════════════════════════ WORKAROUND ══════════════════════════════════════
// Everything below exists ONLY because of doctrine point 4 (workerd RPC cannot carry sockets;
// see the header). It serves fetch calls on LIVE capabilities — capabilities backed by a running
// provider reached over an RPC leg (a capnweb client via the /api relay, or a dynamic worker via
// env.ITX) rather than by loadable code. The mechanism:
//
//   DO side (LiveCapabilityFetchServer.serve): mint an upgradeId, call the paged-in invoker's
//   `fetch(upgradeId, capPath, request)` — that call EXECUTES in the provider transport's own
//   request context, the one place the provider's answer is legally touchable.
//
//   Transport side (dialLiveCapabilityFetch): dial the provider's real fetch. A socketless
//   Response returns over the RPC leg as-is (it serializes fine). A socket-bearing one CANNOT —
//   so the socket is accepted right there, ONE dedicated "upgrade leg" WebSocket is opened back
//   into the DO (openFetchUpgradeLeg → acceptFetchUpgradeLeg, gated on the pending upgradeId),
//   frames are wired provider⇄leg, and a plain marker returns instead.
//
//   DO side again: on the marker, mint the eyeball's WebSocketPair natively (the DO ↔ eyeball
//   hop is a real fetch — socket-legal) and forward frames eyeball⇄leg by tag. Both DO-side
//   sockets are hibernatable, so an open upgrade survives eviction and costs nothing idle.
//
// DELETE-DAY CHECKLIST (all deletions, nothing rewritten): remove this whole fenced section,
// then delete its call sites —
//   • the isFetchShapedCall branch in HibernatableRpcStubManager.invoke, the manager's second
//     ctor param + #liveFetch field (hibernatable-rpc-stub.ts), and the
//     `LiveCapabilityFetchTransport &` half of RetainedCallbackInvoker;
//   • RetainedCallbackInvoker's `fetch` method (rpc-stub-relay.ts);
//   • the stream DO's `#liveCapabilityFetch` field, its acceptFetchUpgradeLeg door, and the
//     handleWebSocketMessage/Close forwarding (stream-durable-object.ts);
//   • the directory's `liveCapabilityFetch` dep + ctor pass-through (rpc-stub-directory.ts).
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

/** What `serve` needs from the paged-in transport stub: the live-capability fetch dial. */
export type LiveCapabilityFetchTransport = {
  fetch(upgradeId: string, capPath: string[], request: Request): Promise<unknown>;
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

/** TRANSPORT SIDE of a live-capability fetch (runs where the provider is legally touchable —
 *  today that is the capnweb session's request context; a NATIVE provider's socket answer still
 *  dies on its own RPC leg, pinned in dynamic-live-ws.e2e.test.ts — a future dial-back fix must
 *  deliver the upgradeId to the provider WITHOUT riding the Request headers verbatim, because a
 *  provider that forwards its received Request would smuggle the header back into our own
 *  upgrade-leg door). Dials the provider's real fetch and branches ONLY on the answer:
 *    • socketless Response → returned as-is (crosses the RPC leg fine);
 *    • socket-bearing Response → accept the socket HERE, open the dedicated upgrade leg into the
 *      DO, wire the frames, and return the marker instead. */
export async function dialLiveCapabilityFetch(
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
  // drop any frame the provider sends immediately after upgrading (a server hello).
  const leg = await openFetchUpgradeLeg(host, upgradeId);
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

/** Open the dedicated upgrade leg into the DO (transport side, mid-dial — the DO is awaiting the
 *  dial RPC and serves this upgrade concurrently; no deadlock, probed). Frames ride it RAW. */
async function openFetchUpgradeLeg(
  host: { fetch(url: string, init?: RequestInit): Promise<Response> },
  upgradeId: string,
): Promise<WebSocket> {
  const response = await host.fetch("https://fetch-upgrade.internal/", {
    headers: { Upgrade: "websocket", [FETCH_UPGRADE_SOCKET_HEADER]: upgradeId },
  });
  if (!response.webSocket)
    throw new Error(`fetch-upgrade leg returned ${response.status} without a WebSocket`);
  response.webSocket.accept();
  return response.webSocket;
}

/** DO SIDE of live-capability fetch: the pending-dial gate, the leg door, the eyeball pair, and
 *  the frame/close forwarding between them. One instance per DO, wired into its fetch /
 *  webSocketMessage / webSocketClose alongside the other doors. */
export class LiveCapabilityFetchServer {
  readonly #hooks: WebSocketHooks;
  /** Dials in flight — the gate `acceptFetchUpgradeLeg` checks. serve()'s finally is the ONLY
   *  cleanup needed (it always runs; no timer, no sweep — a sweep would 409 the leg of a merely
   *  SLOW dial that is still legitimately in flight). */
  #pendingDials = new Set<string>();

  constructor(hooks: WebSocketHooks) {
    this.#hooks = hooks;
  }

  /** Serve one fetch-shaped call on a live capability: dial through the transport; pass a plain
   *  Response straight through; on the upgrade marker, adopt the arrived leg and mint the
   *  eyeball's pair — a real 101 only after the provider actually upgraded. Provider failures
   *  throw through with their own words (the fetch lane answers non-101). */
  async serve(
    transport: LiveCapabilityFetchTransport,
    capPath: string[],
    request: Request,
  ): Promise<unknown> {
    const upgradeId = crypto.randomUUID();
    this.#pendingDials.add(upgradeId);
    let result: unknown;
    try {
      result = await transport.fetch(upgradeId, capPath, request);
    } finally {
      this.#pendingDials.delete(upgradeId);
    }
    if ((result as Partial<FetchUpgradeMarker> | null)?.webSocketUpgrade !== true) return result;
    if (this.#hooks.getWebSockets(upgradeTag("leg", upgradeId)).length === 0)
      throw new Error(`fetch upgrade ${upgradeId}: dial acked but no upgrade leg arrived`);
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

  /** PARTIAL FETCH: accept the transport's dedicated upgrade leg, gated on a pending dial — an
   *  unknown upgradeId 409s (a swept/crashed dial re-dials from scratch). */
  acceptFetchUpgradeLeg(request: Request): Response | null {
    const upgradeId = request.headers.get(FETCH_UPGRADE_SOCKET_HEADER);
    if (upgradeId === null) return null;
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket")
      return new Response(`fetch-upgrade leg: expected a websocket upgrade\n`, { status: 400 });
    if (!this.#pendingDials.has(upgradeId))
      return new Response(`unknown fetch upgrade ${upgradeId} (dial first)\n`, { status: 409 });
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
    return true;
  }

  /** The OTHER side of an upgrade socket, or undefined (not ours) / null (peer gone). */
  #peerOf(ws: WebSocket): WebSocket | null | undefined {
    let att: unknown;
    try {
      att = ws.deserializeAttachment() as unknown;
    } catch {
      return undefined;
    }
    const upgrade = (att as Partial<FetchUpgradeAttachment> | null)?.fetchUpgrade;
    if (!upgrade) return undefined;
    const peerSide = upgrade.side === "eyeball" ? "leg" : "eyeball";
    return this.#hooks.getWebSockets(upgradeTag(peerSide, upgrade.upgradeId))[0] ?? null;
  }
}

/** Is this call a fetch-shaped capability call (doctrine point 1: a terminal `fetch` carrying the
 *  one live Request)? The routing predicate the RPC-stub door uses to send it down `serve`. Dies
 *  with the fence: post-delete-day, terminal fetch rides the plain invoke() walk unrecognized. */
export function isFetchShapedCall(path: string[], args: unknown[]): boolean {
  return path.at(-1) === "fetch" && args.length === 1 && args[0] instanceof Request;
}

// ════════════════════════════════ END WORKAROUND ═════════════════════════════════════
