import { DurableObject } from "cloudflare:workers";
import type { CloudflareEnv } from "../../env.ts";
import { getDbWithEnv } from "../db/client.ts";
import { getAuthWithEnv, type AuthSession } from "../auth/auth.ts";
import { organizationUserMembership } from "../db/schema.ts";
import { and, eq } from "drizzle-orm";
import { logger } from "../tag-logger.ts";

export class TanstackQueryInvalidator extends DurableObject<CloudflareEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === "/invalidate" && request.method === "POST") {
      return this.handleInvalidate();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const db = getDbWithEnv(this.env);
    const auth = getAuthWithEnv(db, this.env);

    let session: AuthSession | null = null;
    try {
      session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) {
        logger.warn("WebSocket upgrade rejected: no session");
        return new Response("Unauthorized", { status: 401 });
      }
    } catch (error) {
      logger.warn("WebSocket upgrade auth failed", error);
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const organizationId = url.searchParams.get("organizationId");
    if (!organizationId) {
      return new Response("Missing organizationId", { status: 400 });
    }

    const membership = await db.query.organizationUserMembership.findFirst({
      where: and(
        eq(organizationUserMembership.userId, session.user.id),
        eq(organizationUserMembership.organizationId, organizationId),
      ),
    });

    if (!membership) {
      logger.warn(`WebSocket upgrade rejected: user ${session.user.id} not member of org ${organizationId}`);
      return new Response("Forbidden", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "CONNECTED" }));
    logger.info(`WebSocket connected for org ${organizationId}, total connections: ${this.ctx.getWebSockets().length}`);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    if (message === "ping") {
      ws.send("pong");
    }
  }

  private async handleInvalidate(): Promise<Response> {
    const websockets = this.ctx.getWebSockets();
    const message = JSON.stringify({ type: "INVALIDATE_ALL" });
    
    logger.info(`Broadcasting invalidation to ${websockets.length} connected clients`);

    let sent = 0;
    let failed = 0;
    for (const ws of websockets) {
      try {
        ws.send(message);
        sent++;
      } catch (error) {
        logger.warn("Failed to send to WebSocket, closing", error);
        ws.close();
        failed++;
      }
    }

    return new Response(JSON.stringify({ success: true, sent, failed }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
