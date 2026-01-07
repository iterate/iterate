import { DurableObject } from "cloudflare:workers";
import type { CloudflareEnv } from "../../env.ts";
import { getDb } from "../db/client.ts";
import { getAuth, type AuthSession } from "../auth/auth.ts";
import { organizationUserMembership } from "../db/schema.ts";
import { eq } from "drizzle-orm";

export class TanstackQueryInvalidator extends DurableObject {
  declare env: CloudflareEnv;

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
    const db = getDb();
    const auth = getAuth(db);

    let session: AuthSession | null = null;
    try {
      session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) {
        return new Response("Unauthorized", { status: 401 });
      }
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const organizationId = url.searchParams.get("organizationId");
    if (!organizationId) {
      return new Response("Missing organizationId", { status: 400 });
    }

    const membership = await db.query.organizationUserMembership.findFirst({
      where: eq(organizationUserMembership.userId, session.user.id),
    });

    if (!membership) {
      return new Response("Forbidden", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "CONNECTED" }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    if (message === "ping") {
      ws.send("pong");
    }
  }

  private async handleInvalidate(): Promise<Response> {
    const message = JSON.stringify({ type: "INVALIDATE_ALL" });

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        ws.close();
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
