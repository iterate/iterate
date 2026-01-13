import { DurableObject } from "cloudflare:workers";
import type { CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";

export class RealtimePusher extends DurableObject<CloudflareEnv> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade();
    }

    const url = new URL(request.url);
    if (url.pathname === "/invalidate" && request.method === "POST") {
      return this.handleInvalidate();
    }

    return new Response("Not found", { status: 404 });
  }

  private handleWebSocketUpgrade(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "CONNECTED" }));
    logger.info(`WebSocket connected, total connections: ${this.ctx.getWebSockets().length}`);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    if (message === "ping") {
      ws.send("pong");
    }
  }

  private handleInvalidate(): Response {
    const websockets = this.ctx.getWebSockets();
    const message = JSON.stringify({ type: "INVALIDATE_ALL" });

    logger.info(`Broadcasting invalidation to ${websockets.length} connected clients`);

    let sent = 0;
    let failed = 0;
    for (const ws of websockets) {
      try {
        ws.send(message);
        sent++;
      } catch {
        ws.close();
        failed++;
      }
    }

    return new Response(JSON.stringify({ success: true, sent, failed }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
