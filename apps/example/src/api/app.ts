import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { z } from "zod";
import { defineApp } from "@iterate-com/shared/define-app";
import { proxyPosthogRequest } from "@iterate-com/shared/jonasland";
import manifest from "../manifest.ts";
import type { ExampleDeps, ExampleInitialOrpcContext } from "./context.ts";
import { router } from "./router.ts";

export const exampleApp = defineApp<ExampleDeps, ExampleInitialOrpcContext>({
  manifest,
  createRequestContext({ request, deps }) {
    return {
      manifest,
      req: {
        headers: new Headers(request.headers),
        url: request.url,
      },
      env: deps.env,
      db: deps.db,
    };
  },
  async register({ app, upgradeWebSocket, getRequestContext }) {
    const openApiHandler = new OpenAPIHandler(router, {
      plugins: [
        new OpenAPIReferencePlugin({
          docsProvider: "scalar",
          docsPath: "/docs",
          specPath: "/openapi.json",
          schemaConverters: [new ZodToJsonSchemaConverter()],
          specGenerateOptions: {
            info: {
              title: manifest.packageName,
              version: manifest.version,
            },
            servers: [{ url: "/api" }],
          },
        }),
      ],
    });

    app.get("/api/health", (c) =>
      c.json({ ok: true, service: getRequestContext(c.req.raw).manifest.slug }),
    );

    // Shared app code owns the websocket paths themselves; runtimes only supply
    // the concrete upgrade helper that makes these routes work on Node or Workers.
    app.get(
      "/api/ping/ws",
      upgradeWebSocket(() => ({
        onMessage(_event, ws) {
          setTimeout(() => {
            ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          }, 1000);
        },
      })),
    );
    app.get(
      "/api/confetti/ws",
      upgradeWebSocket((c) => {
        const { env } = getRequestContext(c.req.raw);
        // Keep timer state inside the factory so each websocket connection gets its
        // own interval/timeouts and cleanup can stay purely connection-scoped.
        let interval: ReturnType<typeof setInterval> | null = null;
        const timeouts = new Set<ReturnType<typeof setTimeout>>();

        function ensureInterval(send: (value: string) => void) {
          if (interval) return;
          interval = setInterval(() => {
            send(
              JSON.stringify({
                type: "boom",
                x: Math.random(),
                y: Math.random() * 0.6 + 0.1,
              }),
            );
          }, env.CONFETTI_DELAY_MS);
        }

        function clearTimers() {
          if (interval) clearInterval(interval);
          interval = null;
          for (const timeout of timeouts) {
            clearTimeout(timeout);
          }
          timeouts.clear();
        }

        return {
          onMessage(event, ws) {
            ensureInterval((value) => ws.send(value));
            if (typeof event.data !== "string") {
              ws.send(JSON.stringify({ type: "error", message: "Invalid confetti payload" }));
              return;
            }

            try {
              const payload = z
                .object({
                  type: z.literal("launch"),
                  x: z.number().min(0).max(1),
                  y: z.number().min(0).max(1),
                })
                .parse(JSON.parse(event.data));
              const timeout = setTimeout(() => {
                timeouts.delete(timeout);
                ws.send(JSON.stringify({ type: "boom", x: payload.x, y: payload.y }));
              }, env.CONFETTI_DELAY_MS);
              timeouts.add(timeout);
            } catch {
              ws.send(JSON.stringify({ type: "error", message: "Invalid confetti payload" }));
            }
          },
          onClose() {
            clearTimers();
          },
          onError() {
            clearTimers();
          },
        };
      }),
    );

    app.all("/api/integrations/posthog/proxy/*", (c) =>
      proxyPosthogRequest({
        request: c.req.raw,
        proxyPrefix: "/api/integrations/posthog/proxy",
      }),
    );

    // The example app's typed oRPC clients use the OpenAPI-backed HTTP surface.
    // The websocket routes above are standalone demos rather than a second RPC transport.
    app.all("/api/*", async (c) => {
      const { matched, response } = await openApiHandler.handle(c.req.raw, {
        prefix: "/api",
        context: getRequestContext(c.req.raw),
      });
      if (!matched || !response) return c.json({ error: "not_found" }, 404);
      return c.newResponse(response.body, response);
    });
  },
});
