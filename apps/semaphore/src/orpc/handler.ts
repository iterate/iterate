import { EvlogHandlerPlugin } from "@iterate-com/shared/evlog/orpc-plugin";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { RPCHandler } from "@orpc/server/fetch";
import { CORSPlugin } from "@orpc/server/plugins";
import packageJson from "../../package.json" with { type: "json" };
import type { RequestContext } from "~/request-context.ts";
import { appRouter } from "~/orpc/root.ts";

const plugins = [new CORSPlugin({ origin: "*" }), new EvlogHandlerPlugin<RequestContext>()];

export const orpcOpenApiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    ...plugins,
    // Scalar API docs at /api/docs, spec at /api/openapi.json:
    // https://orpc.dev/docs/openapi/plugins/openapi-reference
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      docsConfig: { defaultOpenFirstTag: true },
      specGenerateOptions: {
        info: { title: "iterate semaphore app API", version: packageJson.version },
        servers: [{ url: "/api" }],
        // The shared `__internal` operator/debug namespace, served at /api/__internal/*.
        tags: ["/resources", "/__internal"].map((name) => ({ name })),
      },
    }),
  ],
});

export const orpcRpcHandler = new RPCHandler(appRouter, {
  plugins,
});
