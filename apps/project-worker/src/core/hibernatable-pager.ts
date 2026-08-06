// core/hibernatable-pager.ts — the don't-pin transport (mirrors dont-pin-capability-host's Hibernatable Pager).
//
// A live capability's provider lives in a STATELESS relay (the /api worker, where capnweb terminates), NEVER in
// the DO. The relay opens ONE WebSocket to the DO — the Hibernatable Pager — accepted through the DO's
// hibernation API; the DO stores only its `{ socketId }` attachment, NO live stub, so it can hibernate. Over the
// Pager the DO sends one-way PAGES ("wake" / "idle"): on "wake" the relay hands the DO a short Workers-RPC leg
// (an Invoker) for one invocation burst, which the DO drops at quiescence. So the DO holds a live reference only
// while a call is in flight, and hibernates in between (the 1000-idle-devices property).

export const PAGER_HEADER = "x-itx-pager";
const PAGER_TAG = "itx-pager";

/** A one-way DO→relay message over a Pager. Best-effort prompt; the record on the socket is the source of truth. */
export type Page = { type: "wake" } | { type: "idle" };

/** The socket's serialized attachment — the ONLY per-lease durable state, and it SURVIVES hibernation. The caller
 *  stamps its own record here (e.g. a lease); a fresh DO incarnation reads it straight back from the socket, so
 *  there is nothing else to reconcile. `socketId` is always present. */
export type PagerRecord = { socketId: string; [k: string]: unknown };

export function parsePage(data: unknown): Page | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const p = JSON.parse(data) as Page;
    return p?.type === "wake" || p?.type === "idle" ? p : undefined;
  } catch {
    return undefined;
  }
}

/** DO side: accept the relay's Pager upgrade through the DO's `fetch()`, stamping the socket's `{ socketId }`. */
export function acceptPager(
  request: Request,
  hooks: { acceptWebSocket(ws: WebSocket, tags: string[]): void },
): Response {
  const socketId = request.headers.get(PAGER_HEADER);
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket" || !socketId)
    return new Response(`pager: expected a websocket upgrade with ${PAGER_HEADER}\n`, {
      status: 400,
    });
  const pair = new WebSocketPair();
  hooks.acceptWebSocket(pair[1], [PAGER_TAG]);
  pair[1].serializeAttachment({ socketId } satisfies PagerRecord);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** DO side: every open Pager socket (the runtime-owned set that survives hibernation). */
export function pagerSockets(hooks: { getWebSockets(tag: string): WebSocket[] }): WebSocket[] {
  return hooks.getWebSockets(PAGER_TAG).filter((ws) => ws.readyState === WebSocket.OPEN);
}

/** DO side: the open Pager socket for `socketId` (matched by attachment), or undefined. */
export function pagerSocketFor(
  socketId: string,
  hooks: { getWebSockets(tag: string): WebSocket[] },
): WebSocket | undefined {
  return pagerSockets(hooks).find((ws) => pagerAttachment(ws)?.socketId === socketId);
}

/** DO side: read a Pager socket's record (the caller-stamped attachment), or undefined. */
export function pagerAttachment(ws: WebSocket): PagerRecord | undefined {
  try {
    const a = ws.deserializeAttachment() as PagerRecord | null;
    return a && typeof a.socketId === "string" ? a : undefined;
  } catch {
    return undefined;
  }
}

/** DO side: (re)stamp a Pager socket's record — the caller's per-lease durable state, carried through hibernation. */
export function stampPager(ws: WebSocket, record: PagerRecord): void {
  ws.serializeAttachment(record);
}

/** DO side: send one Page; on failure close the socket so it can't stay healthy-looking and stale. */
export function sendPage(ws: WebSocket, page: Page): void {
  try {
    ws.send(JSON.stringify(page));
  } catch {
    try {
      ws.close(1011, "page failed");
    } catch {
      /* already closing */
    }
  }
}

/** Relay side: open a Pager to a DO (via its stub's `fetch`) and accept the returned socket. */
export async function openPager(
  stub: { fetch(url: string, init?: RequestInit): Promise<Response> },
  socketId: string,
): Promise<WebSocket> {
  const r = await stub.fetch("https://pager.internal/", {
    headers: { Upgrade: "websocket", [PAGER_HEADER]: socketId },
  });
  if (!r.webSocket) throw new Error(`pager upgrade returned ${r.status} without a WebSocket`);
  r.webSocket.accept();
  return r.webSocket;
}
