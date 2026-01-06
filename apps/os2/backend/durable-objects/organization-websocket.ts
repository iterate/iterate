import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { APIError } from "better-auth/api";
import type { CloudflareEnv } from "../../env.ts";
import { getDb } from "../db/client.ts";
import { getAuth, type AuthSession } from "../auth/auth.ts";
import { getUserInstanceAccess } from "../trpc/trpc.ts";

// Event schemas for WebSocket communication
export const InvalidateInfo = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ALL"),
  }),
  z.object({
    type: z.literal("QUERY_KEY"),
    queryKeys: z.array(z.unknown()),
  }),
  z.object({
    type: z.literal("TRPC_QUERY"),
    paths: z.array(z.string()),
  }),
]);

export const PushControllerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("INVALIDATE"),
    invalidateInfo: InvalidateInfo,
  }),
  z.object({
    type: z.literal("NOTIFICATION"),
    notificationType: z.enum(["success", "error", "info", "warning"]),
    message: z.string(),
    extraToastArgs: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("CUSTOM"),
    payload: z.unknown(),
  }),
]);

export type PushControllerEvent = z.infer<typeof PushControllerEvent>;

export class OrganizationWebSocket extends DurableObject {
  declare env: CloudflareEnv;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    // Handle RPC methods
    if (url.pathname === "/invalidate" && request.method === "POST") {
      return this.handleInvalidate(request);
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      return this.handleBroadcast(request);
    }

    return new Response("Not found", { status: 404 });
  }

  // Public method for RPC calls
  async broadcast(message: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch (error) {
        console.error(`Failed to send to WebSocket:`, error);
        ws.close();
      }
    }
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    // Verify authentication
    const db = getDb();
    const auth = getAuth(db);
    let session: AuthSession | null = null;
    try {
      session = await auth.api.getSession({
        headers: request.headers,
      });

      if (!session?.user) {
        return new Response("Unauthorized", { status: 401 });
      }
    } catch (error) {
      if (error instanceof APIError) {
        if (error.statusCode === 401 || error.statusCode === 403) {
          return new Response(error.message, { status: error.statusCode });
        }
      }
      console.error("Error getting session:", error);
      return new Response("Unauthorized", { status: 401 });
    }

    // Extract instance and organization from URL params
    const url = new URL(request.url);
    const instanceId = url.searchParams.get("instanceId");
    const organizationId = url.searchParams.get("organizationId");

    if (!organizationId) {
      return new Response("Missing required parameters", { status: 400 });
    }

    // If instanceId provided, verify user has access to this instance
    if (instanceId) {
      const { hasAccess } = await getUserInstanceAccess(db, session.user.id, instanceId);
      if (!hasAccess) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    this.ctx.acceptWebSocket(server);

    // Send welcome message
    server.send(
      JSON.stringify({
        type: "CONNECTED",
        userId: session.user.id,
      }),
    );

    // Return the client WebSocket
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    try {
      // Handle ping/pong for keepalive
      if (message === "ping") {
        ws.send("pong");
        return;
      }

      // Parse and validate incoming messages if needed
      const data = JSON.parse(message as string);

      // Echo back for now
      ws.send(
        JSON.stringify({
          type: "ECHO",
          original: data,
          timestamp: Date.now(),
        }),
      );
    } catch (error) {
      console.error("Error handling message:", error);
      ws.send(
        JSON.stringify({
          type: "ERROR",
          message: "Invalid message format",
        }),
      );
    }
  }

  private async handleInvalidate(request: Request): Promise<Response> {
    try {
      const body = await request.json();

      // Validate the invalidation event
      const parsed = PushControllerEvent.safeParse(body);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: "Invalid payload" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Broadcast to all connected sessions
      const message = JSON.stringify(parsed.data);
      let successCount = 0;
      let errorCount = 0;

      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
          successCount++;
        } catch (error) {
          console.error(`Failed to send to session:`, error);
          errorCount++;
          ws.close();
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          delivered: successCount,
          failed: errorCount,
          totalSessions: this.ctx.getWebSockets().length,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error handling invalidate:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      const message = JSON.stringify(body);

      let successCount = 0;
      let errorCount = 0;

      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
          successCount++;
        } catch (error) {
          console.error(`Failed to send to session:`, error);
          errorCount++;
          ws.close();
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          delivered: successCount,
          failed: errorCount,
          totalSessions: this.ctx.getWebSockets().length,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error handling broadcast:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}
