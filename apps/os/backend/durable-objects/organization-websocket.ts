import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { CloudflareEnv } from "../../env.ts";
import { getDb } from "../db/client.ts";
import { getAuth } from "../auth/auth.ts";
import { getUserEstateAccess } from "../trpc/trpc.ts";

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

interface WebSocketSession {
  websocket: WebSocket;
  userId: string;
  estateId: string;
  organizationId: string;
  connectedAt: number;
}

export class OrganizationWebSocket extends DurableObject<CloudflareEnv> {
  private sessions: Map<string, WebSocketSession> = new Map();

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);

    // Clean up any stale sessions on startup
    ctx.blockConcurrencyWhile(async () => {
      this.sessions = new Map();
    });
  }

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

    if (url.pathname === "/stats" && request.method === "GET") {
      return this.handleStats();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    // Verify authentication
    const db = getDb();
    const auth = getAuth(db);
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Extract estate and organization from URL params
    const url = new URL(request.url);
    const estateId = url.searchParams.get("estateId");
    const organizationId = url.searchParams.get("organizationId");

    if (!estateId || !organizationId) {
      return new Response("Missing required parameters", { status: 400 });
    }

    // Verify user has access to this estate using the helper function
    const { hasAccess } = await getUserEstateAccess(db, session.user.id, estateId, organizationId);

    if (!hasAccess) {
      return new Response("Forbidden", { status: 403 });
    }

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    server.accept();

    // Generate session ID
    const sessionId = crypto.randomUUID();

    // Store session
    const wsSession: WebSocketSession = {
      websocket: server,
      userId: session.user.id,
      estateId,
      organizationId,
      connectedAt: Date.now(),
    };
    this.sessions.set(sessionId, wsSession);

    // Send welcome message
    server.send(
      JSON.stringify({
        type: "CONNECTED",
        sessionId,
        userId: session.user.id,
        connectedAt: wsSession.connectedAt,
      }),
    );

    // Handle WebSocket events
    server.addEventListener("message", async (event) => {
      try {
        // Handle ping/pong for keepalive
        if (event.data === "ping") {
          server.send("pong");
          return;
        }

        // Parse and validate incoming messages if needed
        const data = JSON.parse(event.data as string);
        console.log(`Message from ${sessionId}:`, data);

        // Echo back for now (you can add more message handling here)
        server.send(
          JSON.stringify({
            type: "ECHO",
            original: data,
            timestamp: Date.now(),
          }),
        );
      } catch (error) {
        console.error("Error handling message:", error);
        server.send(
          JSON.stringify({
            type: "ERROR",
            message: "Invalid message format",
          }),
        );
      }
    });

    server.addEventListener("close", () => {
      console.log(`WebSocket closed for session ${sessionId}`);
      this.sessions.delete(sessionId);
    });

    server.addEventListener("error", (error) => {
      console.error(`WebSocket error for session ${sessionId}:`, error);
      this.sessions.delete(sessionId);
    });

    // Return the client WebSocket
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
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

      for (const [sessionId, session] of this.sessions) {
        try {
          session.websocket.send(message);
          successCount++;
        } catch (error) {
          console.error(`Failed to send to session ${sessionId}:`, error);
          errorCount++;
          // Remove dead sessions
          this.sessions.delete(sessionId);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          delivered: successCount,
          failed: errorCount,
          totalSessions: this.sessions.size,
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

      for (const [sessionId, session] of this.sessions) {
        try {
          session.websocket.send(message);
          successCount++;
        } catch (error) {
          console.error(`Failed to send to session ${sessionId}:`, error);
          errorCount++;
          // Remove dead sessions
          this.sessions.delete(sessionId);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          delivered: successCount,
          failed: errorCount,
          totalSessions: this.sessions.size,
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

  private async handleStats(): Promise<Response> {
    const stats = {
      totalSessions: this.sessions.size,
      sessions: Array.from(this.sessions.entries()).map(([id, session]) => ({
        id,
        userId: session.userId,
        estateId: session.estateId,
        connectedAt: session.connectedAt,
        duration: Date.now() - session.connectedAt,
      })),
    };

    return new Response(JSON.stringify(stats), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
