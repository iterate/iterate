import { Hono, type Context } from "hono";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { wsTest2ServiceManifest } from "../manifest.ts";
import { serviceName, type WsTest2Context } from "./context.ts";
import { router } from "./router.ts";

const openAPIHandler = new OpenAPIHandler(router, {
  plugins: [
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: { title: "ws-test-2 API", version: wsTest2ServiceManifest.version },
        servers: [{ url: "/api" }],
      },
    }),
  ],
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

export function applySharedHttpRoutes(
  app: Hono<any>,
  params: { createOrpcContext: (c: Context) => WsTest2Context },
) {
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      service: serviceName,
    }),
  );

  app.all("/api/*", async (c) => {
    const { matched, response } = await openAPIHandler.handle(c.req.raw, {
      prefix: "/api",
      context: params.createOrpcContext(c),
    });

    if (!matched || !response) {
      return c.json({ error: "not_found" }, 404);
    }

    return c.newResponse(response.body, response);
  });
}
