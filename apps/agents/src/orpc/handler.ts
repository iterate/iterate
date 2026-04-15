import { EvlogHandlerPlugin } from "@iterate-com/shared/apps/logging/orpc-plugin";
import { createOpenApiReferencePluginForApp } from "@iterate-com/shared/apps/orpc";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import manifest from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { appRouter } from "~/orpc/root.ts";

const plugins = [new EvlogHandlerPlugin<AppContext>()];

export const orpcOpenApiHandler = new OpenAPIHandler(appRouter, {
  adapterInterceptors: [
    async (options) => {
      const result = await options.next();
      const type = result.response?.headers.get("content-type");
      if (!result.matched || result.response.body === null || !type?.includes("json")) {
        return result;
      }

      return {
        ...result,
        response: new Response(
          JSON.stringify(await result.response.json(), null, 2),
          result.response,
        ),
      };
    },
  ],
  plugins: [
    ...plugins,
    createOpenApiReferencePluginForApp(manifest, ["/sample"], {
      defaultOpenFirstTag: true,
    }),
  ],
});

export const orpcRpcHandler = new RPCHandler(appRouter, {
  plugins,
});
