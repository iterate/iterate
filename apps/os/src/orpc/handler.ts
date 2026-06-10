import { EvlogHandlerPlugin } from "@iterate-com/shared/evlog/orpc-plugin";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { experimental_RPCHandler as WebSocketRPCHandler } from "@orpc/server/crossws";
import { CORSPlugin } from "@orpc/server/plugins";
import packageJson from "../../package.json" with { type: "json" };
import type { RequestContext } from "~/request-context.ts";
import { appRouter } from "~/orpc/root.ts";
import { prettyJsonInterceptor } from "~/orpc/pretty-json-interceptor.ts";
import { prettifyStandardSchemaError } from "~/standard-schema/errors.ts";
import { looksLikeStandardSchemaFailure } from "~/standard-schema/utils.ts";

const plugins = [new CORSPlugin({ origin: "*" }), new EvlogHandlerPlugin<RequestContext>()];

export const orpcOpenApiHandler = new OpenAPIHandler(appRouter, {
  adapterInterceptors: [prettyJsonInterceptor],
  plugins: [
    ...plugins,
    // Scalar API docs at /api/docs, spec at /api/openapi.json:
    // https://orpc.dev/docs/openapi/plugins/openapi-reference
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      docsConfig: {
        defaultOpenFirstTag: true,
      },
      specGenerateOptions: {
        info: {
          title: "iterate os app API",
          version: packageJson.version,
        },
        servers: [{ url: "/api" }],
        tags: [
          "/debug",
          "/test",
          "/projects",
          "/streams",
          "/codemode",
          "/agents",
          "/repos",
          "/integrations",
          // The shared `__internal` operator/debug namespace, served at /api/__internal/*.
          "/__internal",
        ].map((name) => ({ name })),
      },
    }),
  ],
  interceptors: [
    onError((error: any) => {
      if (looksLikeStandardSchemaFailure(error.cause)) {
        console.error(`${error.code} ${error}:\n\n${prettifyStandardSchemaError(error.cause)}`);
        return;
      }
      console.error(error);
    }),
  ],
});

export const orpcRpcHandler = new RPCHandler(appRouter, {
  plugins,
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

export const orpcWebSocketHandler = new WebSocketRPCHandler(appRouter, {
  plugins: [new EvlogHandlerPlugin<RequestContext>()],
});
