import { DurableObject } from "cloudflare:workers";
import { z } from "zod/v4";
import type { CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";

const SetStateInput = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

const DeleteStateInput = z.object({
  key: z.string().min(1),
});

export class RRuler extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const { pathname, searchParams } = url;

      if (pathname === "/ping") {
        return this.json({ ok: true, pong: Date.now() });
      }

      if (pathname === "/state") {
        if (request.method === "GET") {
          const key = searchParams.get("key");
          if (!key) return this.json({ error: "Missing ?key" }, 400);
          const value = this.ctx.storage.kv.get(key);
          return this.json({ key, value });
        }

        if (request.method === "POST") {
          const body = await request.json();
          const parsed = SetStateInput.safeParse(body);
          if (!parsed.success) return this.json({ error: "Invalid payload" }, 400);
          const { key, value } = parsed.data;
          this.ctx.storage.kv.put(key, value);
          return this.json({ ok: true });
        }

        if (request.method === "DELETE") {
          const body = (await request.json().catch(() => undefined)) as unknown;
          const keyFromBody =
            typeof body === "object" && body !== null && "key" in body
              ? (body as { key?: unknown }).key
              : undefined;
          const parsed = DeleteStateInput.safeParse({ key: keyFromBody ?? searchParams.get("key") });
          if (!parsed.success) return this.json({ error: "Missing key" }, 400);
          this.ctx.storage.kv.delete(parsed.data.key);
          return this.json({ ok: true });
        }

        return this.json({ error: "Method not allowed" }, 405);
      }

      if (pathname === "/") {
        return this.json({
          name: "RRuler",
          id: this.ctx.id.toString(),
          endpoints: {
            "GET /ping": "{ ok, pong }",
            "GET /state?key=...": "{ key, value }",
            "POST /state": "{ key, value } -> { ok }",
            "DELETE /state?key=...": "or DELETE { key } -> { ok }",
          },
        });
      }

      return this.json({ error: "Not found" }, 404);
    } catch (error) {
      logger.error("RRuler error:", error);
      return this.json({ error: "Internal server error" }, 500);
    }
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
