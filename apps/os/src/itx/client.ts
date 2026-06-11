// withItx: hold an itx handle from outside the platform (Node programs,
// e2e tests, your laptop daemon). This is "tier 3" hardware we don't load —
// it gets project egress explicitly via itx.fetch(), and any live target it
// provideCapability()s is session-bound: gone when this connection drops,
// back when the provider reconnects and provides it again.
//
// Node-only by import: passes a `ws` WebSocket into capnweb. Browser code
// uses the same /api/itx endpoint with the admin-cookie bridge instead
// (browsers cannot set WebSocket Authorization headers).

import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import type { ItxHandle } from "./handle.ts";

export type WithItxInput = {
  /** OS base url, e.g. https://os.iterate-preview-3.com */
  baseUrl: string;
  /** Admin API secret (simplified access model: admin = all projects). */
  token: string;
  /** "global" (default) or a project id/slug. */
  context?: string;
  /**
   * WebSocket handshake timeout (ms). Without this a dead/unreachable server
   * makes the underlying socket — and every pending RPC on it — hang forever
   * instead of failing fast. Default 15s.
   */
  handshakeTimeoutMs?: number;
};

export type ItxClient = RpcStub<ItxHandle>;

export function withItx(input: WithItxInput): ItxClient {
  const url = new URL(
    input.context && input.context !== "global"
      ? `/api/itx/${encodeURIComponent(input.context)}`
      : "/api/itx",
    input.baseUrl,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const socket = new WebSocket(url.toString(), {
    handshakeTimeout: input.handshakeTimeoutMs ?? 15_000,
    headers: { authorization: `Bearer ${input.token}` },
  });
  return newWebSocketRpcSession<ItxHandle>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}
