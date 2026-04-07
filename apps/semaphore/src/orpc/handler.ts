import { createOpenApiReferencePluginForApp } from "@iterate-com/shared/apps/orpc";
import { EvlogHandlerPlugin } from "@iterate-com/shared/apps/logging/orpc-plugin";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { CORSPlugin } from "@orpc/server/plugins";
import manifest from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { appRouter } from "~/orpc/root.ts";

const plugins = [new CORSPlugin({ origin: "*" }), new EvlogHandlerPlugin<AppContext>()];

export const orpcOpenApiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    ...plugins,
    createOpenApiReferencePluginForApp(manifest, ["/resources"], {
      defaultOpenFirstTag: true,
    }),
  ],
});

export const orpcRpcHandler = new RPCHandler(appRouter, {
  plugins,
});
