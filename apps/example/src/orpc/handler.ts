import { createOpenApiReferencePluginForApp } from "@iterate-com/shared/apps/orpc";
import { EvlogHandlerPlugin } from "@iterate-com/shared/apps/logging/orpc-plugin";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { experimental_RPCHandler as WebSocketRPCHandler } from "@orpc/server/crossws";
import { CORSPlugin } from "@orpc/server/plugins";
import manifest from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { appRouter } from "~/orpc/root.ts";

export const orpcOpenApiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new CORSPlugin({ origin: "*" }),
    new EvlogHandlerPlugin<AppContext>(),
    createOpenApiReferencePluginForApp(manifest, ["debug", "test", "things"], {
      defaultOpenFirstTag: true,
    }),
  ],
});

export const orpcWebSocketHandler = new WebSocketRPCHandler(appRouter, {
  plugins: [new EvlogHandlerPlugin<AppContext>()],
});
