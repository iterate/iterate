import { DurableObject } from "cloudflare:workers";
import { z } from "zod/v4";
import { APIError } from "better-auth/api";
import type { CloudflareEnv } from "../../env.ts";
import { getDb } from "../db/client.ts";
import { getAuth, type AuthSession } from "../auth/auth.ts";
import { getUserInstanceAccess } from "../trpc/trpc.ts";
import { logger } from "../tag-logger.ts";

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

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === "/invalidate" && request.method === "POST") {
      return this.handleInvalidate(request);
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      return this.handleBroadcast(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
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
      logger.error("Error getting session:", error);
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const instanceSlug = url.searchParams.get("instanceSlug");
    const organizationSlug = url.searchParams.get("organizationSlug");

    if (!instanceSlug || !organizationSlug) {
      return new Response("Missing required parameters", { status: 400 });
    }

    const { hasAccess } = await getUserInstanceAccess(
      db,
      session.user.id,
      organizationSlug,
      instanceSlug,
    );

    if (!hasAccess) {
      return new Response("Forbidden", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    server.send(
      JSON.stringify({
        type: "CONNECTED",
        userId: session.user.id,
      }),
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    try {
      if (message === "ping") {
        ws.send("pong");
        return;
      }

      const data = JSON.parse(message as string);

      ws.send(
        JSON.stringify({
          type: "ECHO",
          original: data,
          timestamp: Date.now(),
        }),
      );
    } catch (error) {
      logger.error("Error handling message:", error);
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

      const parsed = PushControllerEvent.safeParse(body);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: "Invalid payload" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const message = JSON.stringify(parsed.data);
      let successCount = 0;
      let errorCount = 0;

      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
          successCount++;
        } catch (error) {
          logger.error(`Failed to send to session ${ws}:`, error);
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
      logger.error("Error handling invalidate:", error);
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
          logger.error(`Failed to send to session ${ws}:`, error);
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
      logger.error("Error handling broadcast:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}
