import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { experimental_RPCHandler as RPCHandler } from "@orpc/server/crossws";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { Hooks } from "crossws";
import { defineApp } from "@iterate-com/shared/jonasland";
import type { ExampleRuntimeEnv } from "../env.ts";
import { appManifest } from "../manifest.ts";
import { createPingPongHooks } from "./ws/ping-pong.ts";
import { createConfettiSocketHooks } from "./ws/confetti.ts";
import type { ExampleInitialOrpcContext } from "./context.ts";
import { router } from "./router.ts";

const POSTHOG_API_HOST = "eu.i.posthog.com";
const POSTHOG_ASSET_HOST = "eu-assets.i.posthog.com";

export const exampleApp = defineApp<ExampleInitialOrpcContext, ExampleRuntimeEnv>({
  manifest: appManifest,
  async attachRuntime({ honoApp, crosswsAdapter, createRuntimeOrpcContext }) {
    const app = honoApp;

    const createInitialOrpcContext = (req: Request): ExampleInitialOrpcContext => ({
      manifest: appManifest,
      req,
      ...createRuntimeOrpcContext(),
    });

    const orpcHandler = new RPCHandler(router, {
      interceptors: [onError((error) => console.error(error))],
    });

    const openApiHandler = new OpenAPIHandler(router, {
      plugins: [
        new OpenAPIReferencePlugin({
          docsProvider: "scalar",
          docsPath: "/docs",
          specPath: "/openapi.json",
          schemaConverters: [new ZodToJsonSchemaConverter()],
          specGenerateOptions: {
            info: {
              title: appManifest.packageName,
              version: appManifest.version,
            },
            servers: [{ url: "/api" }],
          },
        }),
      ],
      interceptors: [onError((error) => console.error(error))],
    });

    const crossws = crosswsAdapter({
      async resolve(request: Request) {
        const pathname = new URL(request.url, "http://localhost").pathname;

        if (pathname === "/api/orpc/ws") {
          return {
            upgrade(request) {
              const protocols = request.headers
                .get("sec-websocket-protocol")
                ?.split(",")
                .map((v) => v.trim())
                .filter(Boolean);
              if (!protocols?.includes("orpc")) {
                return new Response("Expected Sec-WebSocket-Protocol: oRPC", { status: 400 });
              }
              return { headers: { "Sec-WebSocket-Protocol": "orpc" } };
            },
            async message(peer, message) {
              try {
                await orpcHandler.message(peer, message, {
                  context: createInitialOrpcContext(request),
                });
              } catch (error) {
                console.error(error);
                peer.close(1011, "oRPC websocket error");
              }
            },
            close(peer) {
              orpcHandler.close(peer);
            },
            error(peer, error) {
              console.error(error);
              orpcHandler.close(peer);
            },
          } satisfies Partial<Hooks>;
        }

        if (pathname === "/api/ping/ws") {
          return createPingPongHooks();
        }

        if (pathname === "/api/confetti/ws") {
          return createConfettiSocketHooks(createInitialOrpcContext(request).env.CONFETTI_DELAY_MS);
        }

        return {};
      },
    });

    app.get("/api/health", (c) =>
      c.json({ ok: true, service: createInitialOrpcContext(c.req.raw).manifest.slug }),
    );

    app.all("/api/integrations/posthog/proxy/*", async (c) => {
      const url = new URL(c.req.url);
      const posthogPath = url.pathname.replace(/^\/api\/integrations\/posthog\/proxy/, "");
      const targetHost = posthogPath.startsWith("/static/") ? POSTHOG_ASSET_HOST : POSTHOG_API_HOST;
      const posthogUrl = `https://${targetHost}${posthogPath}${url.search}`;
      const headers = new Headers(c.req.raw.headers);
      headers.set("Host", targetHost);
      headers.set("X-Forwarded-Host", url.hostname);
      headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
      headers.delete("cookie");
      headers.delete("connection");

      const upstreamResponse = await fetch(posthogUrl, {
        method: c.req.method,
        headers,
        body:
          c.req.method !== "GET" && c.req.method !== "HEAD"
            ? await c.req.raw.arrayBuffer()
            : undefined,
      });

      const responseHeaders = new Headers(upstreamResponse.headers);
      if (responseHeaders.has("content-encoding")) {
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
      }

      return new Response(await upstreamResponse.arrayBuffer(), {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    });

    app.all("/api/*", async (c) => {
      const { matched, response } = await openApiHandler.handle(c.req.raw, {
        prefix: "/api",
        context: createInitialOrpcContext(c.req.raw),
      });
      if (!matched || !response) return c.json({ error: "not_found" }, 404);
      return c.newResponse(response.body, response);
    });

    return { honoApp: app, crossws };
  },
});
