import { EvlogHandlerPlugin } from "@iterate-com/shared/apps/logging/orpc-plugin";
import {
  createOpenApiReferencePluginForApp,
  prettyJsonInterceptor,
} from "@iterate-com/shared/apps/orpc";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import manifest from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { appRouter } from "~/orpc/root.ts";

const plugins = [new EvlogHandlerPlugin<AppContext>()];

export const orpcOpenApiHandler = new OpenAPIHandler(appRouter, {
  adapterInterceptors: [prettyJsonInterceptor],
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
