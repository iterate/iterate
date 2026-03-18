import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { defineApp } from "@iterate-com/shared/apps/define-app";
import { proxyPosthogRequest } from "@iterate-com/shared/posthog";
import manifest from "../manifest.ts";
import type { ExampleDeps } from "./context.ts";
import { router } from "./router.ts";

export const exampleApp = defineApp<ExampleDeps>({
  manifest,
  async register({ app, upgradeWebSocket, getDeps, getRequestContext }) {
    // The OpenAPI handler is the single typed HTTP surface for the example app.
    // The frontend client talks to `/api`, while the websocket routes below are
    // standalone demos rather than a second RPC transport.
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
      "/api/pty/ws",
      upgradeWebSocket((c) => getDeps().terminal.createWebSocketEvents({ request: c.req.raw })),
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
