import {
  createOpenApiReferencePluginForApp,
  prettyJsonInterceptor,
} from "@iterate-com/shared/apps/orpc";
import { EvlogHandlerPlugin } from "@iterate-com/shared/apps/logging/orpc-plugin";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { experimental_RPCHandler as WebSocketRPCHandler } from "@orpc/server/crossws";
import { RPCHandler } from "@orpc/server/fetch";
import manifest from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { appRouter } from "~/orpc/root.ts";

const plugins = [new EvlogHandlerPlugin<AppContext>()];

export const orpcOpenApiHandler = new OpenAPIHandler(appRouter, {
  adapterInterceptors: [prettyJsonInterceptor],
  plugins: [
    ...plugins,
    createOpenApiReferencePluginForApp(manifest, ["/streams", "/secrets"], {
      defaultOpenFirstTag: true,
    }),
  ],
});

export const orpcRpcHandler = new RPCHandler(appRouter, {
  plugins,
});

export const orpcWebSocketHandler = new WebSocketRPCHandler(appRouter, {
  plugins: [new EvlogHandlerPlugin<AppContext>()],
});
