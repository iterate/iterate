import { createOpenApiReferencePluginForApp } from "@iterate-com/shared/apps/orpc";
import { EvlogHandlerPlugin } from "@iterate-com/shared/apps/logging/orpc-plugin";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { CORSPlugin } from "@orpc/server/plugins";
import manifest from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { appRouter } from "~/orpc/root.ts";

export const orpcOpenApiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new CORSPlugin({ origin: "*" }),
    new EvlogHandlerPlugin<AppContext>(),
    createOpenApiReferencePluginForApp(manifest, ["Resources"], {
      defaultOpenFirstTag: true,
    }),
  ],
});
