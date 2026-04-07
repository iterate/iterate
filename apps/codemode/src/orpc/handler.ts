import { createOpenApiReferencePluginForApp } from "@iterate-com/shared/apps/orpc";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { CORSPlugin } from "@orpc/server/plugins";
import manifest from "~/app.ts";
import { appRouter } from "~/orpc/root.ts";

export const orpcOpenApiHandler = new OpenAPIHandler(appRouter, {
  plugins: [new CORSPlugin({ origin: "*" }), createOpenApiReferencePluginForApp(manifest)],
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

export const orpcRpcHandler = new RPCHandler(appRouter, {
  plugins: [new CORSPlugin({ origin: "*" })],
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});
