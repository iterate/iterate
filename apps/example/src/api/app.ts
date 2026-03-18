import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { defineApp } from "@iterate-com/shared/apps/define-app";
import { proxyPosthogRequest } from "@iterate-com/shared/posthog";
import manifest from "../manifest.ts";
import type { ExampleDeps, ExampleInitialOrpcContext } from "./context.ts";
import { router } from "./router.ts";

export const exampleApp = defineApp<ExampleDeps, ExampleInitialOrpcContext>({
  manifest,
  createRequestContext({ request, manifest, deps }) {
    return {
      manifest,
      req: {
        headers: new Headers(request.headers),
        url: request.url,
        raw: request,
      },
      ...deps,
    };
  },
  async register({ app, upgradeWebSocket, getDeps, getRequestContext }) {
    // The OpenAPI handler is the single typed HTTP surface for the example app.
    // The frontend client talks to `/api`, while the websocket routes below are
    // standalone demos rather than a second RPC transport.
    //
    // The paths themselves come from the contract package. In particular, the
    // shared `iterate.*` contract defines the `/__iterate/*` OpenAPI routes, and
    // this handler simply serves that contract under the `/api` prefix.
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

    // `/api/*` is the typed HTTP surface for the app. Matching RPC procedures go
    // through the OpenAPI handler, and unmatched `/api/*` requests stop here with
    // a JSON 404 instead of falling through to later Hono routes.
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
