// connectItx: hold an itx handle from outside the platform (Node programs,
// e2e tests, your laptop daemon). This is "tier 3" hardware we don't load —
// it gets project egress explicitly via itx.fetch(), and anything it
// provide()s is live: session-bound, gone when this connection drops, back
// when the provider reconnects and provides again.
//
// Node-only by import: passes a `ws` WebSocket into capnweb. Browser code
// uses the same /api/itx endpoint with the admin-cookie bridge instead
// (browsers cannot set WebSocket Authorization headers).

import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import type { Itx } from "./handle.ts";

export type ConnectItxInput = {
  /** OS base url, e.g. https://os.iterate-preview-3.com */
  baseUrl: string;
  /** Admin API secret (simplified access model: admin = all projects). */
  token: string;
  /** "global" (default) or a project id/slug. */
  context?: string;
};

export type ItxClient = RpcStub<Itx>;

export function connectItx(input: ConnectItxInput): ItxClient {
  const url = new URL(
    input.context && input.context !== "global"
      ? `/api/itx/${encodeURIComponent(input.context)}`
      : "/api/itx",
    input.baseUrl,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const socket = new WebSocket(url.toString(), {
    headers: { authorization: `Bearer ${input.token}` },
  });
  return newWebSocketRpcSession<Itx>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}
