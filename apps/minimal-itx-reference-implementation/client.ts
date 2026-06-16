// client.ts — the entire client side: a one-line socket opener and `withItx`.
//
// There is deliberately NO path proxy and no consumer-side library: a naked
// Cap'n Web stub already turns `stub.slack.chat.postMessage(args)` into a single
// pipelined message (the stub accumulates the property path locally, zero round
// trips, and sends it on the terminal call). The server-side dynamic proxy
// (server.ts) collapses that path into one invokeCapability. The client writes
// nothing — it just holds the bare session stub.
//
// Node-only by import (it passes a `ws` socket into Cap'n Web). A browser would
// hit the same `/api/itx` endpoint and hold the same naked stub.

import WebSocket from "ws";
import { newWebSocketRpcSession } from "capnweb";

/** Open a Cap'n Web WebSocket session and return the naked stub. */
export function connect<T>(url: string, headers?: Record<string, string>): T {
  // `ws` (unlike a browser WebSocket) can set request headers on the upgrade —
  // that is how a Node client sends its `Authorization: Bearer …` token.
  const ws = new WebSocket(
    url,
    headers ? { headers } : undefined,
  ) as unknown as globalThis.WebSocket;
  return newWebSocketRpcSession<T>(ws);
}

export type WithItxInput = {
  /** Worker base url. Defaults to ITX_BASE or http://127.0.0.1:8788. */
  baseUrl?: string;
  /** Empty means `__global__`; otherwise a project id like "shared". */
  projectId?: string;
  /** Context path inside the project. "/" is the project root. */
  path?: string;
  /** Bearer token naming the principal (auth.ts). Required for any context. */
  token?: string;
};

/** Hold an itx context from OUTSIDE the platform (a Node program, a test, your
 *  laptop daemon). Returns the NAKED, Disposable session stub, so
 *  `using itx = withItx(...)` closes the socket at scope end — and any live
 *  capability this connection provided is gone when it drops (live caps are
 *  session-bound). Mirrors production's apps/os/src/itx/client.ts. */
export function withItx<T = any>(input: WithItxInput): T {
  const base = input.baseUrl ?? process.env.ITX_BASE ?? "http://127.0.0.1:8788";
  const wsBase = base.replace(/^http/, "ws");
  const params = new URLSearchParams({
    projectId: input.projectId ?? "",
    path: input.path ?? "/",
  });
  const url = `${wsBase}/api/itx?${params}`;
  return connect<T>(url, input.token ? { authorization: `Bearer ${input.token}` } : undefined);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
