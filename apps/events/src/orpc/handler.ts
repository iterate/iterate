import { createOpenApiReferencePluginForApp } from "@iterate-com/shared/apps/orpc";
import { EvlogHandlerPlugin } from "@iterate-com/shared/apps/logging/orpc-plugin";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { CORSPlugin } from "@orpc/server/plugins";
import manifest from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { appRouter } from "~/orpc/root.ts";

export const orpcOpenApiHandler = new OpenAPIHandler(appRouter, {
  adapterInterceptors: [
    // We want nice pretty JSON to come back e.g. from
    // curl --json '{"type": "create", "payload": {"name": "test"}}' https://events.iterate.com/api/streams/
    // Keep prettifying at the fetch transport boundary, not in route handlers:
    // https://orpc.dev/docs/adapters/http
    // SSE uses `text/event-stream`, so leave those responses untouched:
    // https://orpc.dev/docs/event-iterator
    async (options) => {
      const result = await options.next();
      const type = result.response?.headers.get("content-type");
      if (!result.matched || result.response.body === null || !type?.includes("json"))
        return result;
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
    new CORSPlugin({ origin: "*" }),
    new EvlogHandlerPlugin<AppContext>(),
    createOpenApiReferencePluginForApp(manifest, ["Streams", "secrets"], {
      defaultOpenFirstTag: true,
    }),
  ],
});
