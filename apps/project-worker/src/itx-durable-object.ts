// The ItxDurableObject — the capability host (target-core §4.1). One DO per {projectId, path}, addressed by
// name. For the WALKING SKELETON its job is narrow but load-bearing: prove that a WebSocket upgrade (101)
// flows through a DO-stub `fetch()` (target-core §6.0 risk #3), via `ctx.acceptWebSocket()` — the same native
// fetch that later carries the wake socket (spikes 3-4) and ingress.
//
// NOT YET here (next increments): invokeCapability/provideCapability dispatch, the mount fold, run/load in the
// DO. The point of THIS increment is the WS-through-the-stack walking skeleton, nothing more.

import { DurableObject } from "cloudflare:workers";

export class ItxDurableObject extends DurableObject {
  /** NATIVE fetch — the ONE method a WS upgrade (101) can flow through (a 101 can't cross an RPC boundary).
   *  The stateless edge calls this DIRECTLY (never via invokeCapability). Here: accept the socket
   *  (hibernatable) and echo — the ingress-WS proof and the wake-socket attach point. */
  async fetch(request: Request): Promise<Response> {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server); // hibernatable — survives eviction (spikes 3-4)
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response(`itx-do ${this.ctx.id.name ?? "?"} ok\n`, {
      headers: { "content-type": "text/plain" },
    });
  }

  /** Ingress-WS echo. Prefixing with "echo:" lets the caller assert it round-tripped the full stack. */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    ws.send(`echo:${text}`);
  }

  webSocketError(): void {
    /* no-op: keep the DO from crashing on a transport error */
  }
}
