import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { CORSPlugin } from "@orpc/server/plugins";
import { onError } from "@orpc/server";
import { createFileRoute } from "@tanstack/react-router";
import { appRouter } from "../../orpc/router";

const handler = new OpenAPIHandler(appRouter, {
  plugins: [
    new CORSPlugin({ origin: "*" }),
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "Things API",
          version: "1.0.0",
          description:
            "oRPC + TanStack Start on Cloudflare Workers. " +
            "CRUD, streaming, and OpenAPI — all inside a dynamic worker facet.",
        },
      },
    }),
  ],
  interceptors: [onError((error) => console.error("[OpenAPI]", error))],
});

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { matched, response } = await handler.handle(request, {
          prefix: "/api",
          context: {},
        });
        if (matched && response) return response;
        return new Response("Not Found", { status: 404 });
      },
    },
  },
});
