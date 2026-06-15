// client-lib.ts — the entire client side. Just a one-line socket opener.
//
// There is deliberately NO path proxy and no consumer-side library here: a naked
// capnweb stub already turns `stub.slack.chat.postMessage(args)` into a single
// pipelined message (the stub accumulates the property path locally, zero round
// trips, and sends it on the terminal call). The server-side dynamic proxy
// (server.ts) is what collapses that path into one invoke(path, args). The
// client writes nothing.
import WebSocket from "ws";
import { newWebSocketRpcSession } from "capnweb";

// capnweb's newWebSocketRpcSession wants a browser-style WebSocket. The `ws`
// package is close enough; capnweb attaches via .addEventListener("message"/...).
export function connect<T>(url: string, headers?: Record<string, string>): T {
  // `ws` (unlike a browser WebSocket) can set request headers on the upgrade —
  // that's how a Node client sends its `Authorization: Bearer …` token (Step 08).
  const ws = new WebSocket(
    url,
    headers ? { headers } : undefined,
  ) as unknown as globalThis.WebSocket;
  return newWebSocketRpcSession<T>(ws);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
