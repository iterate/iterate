import { RPCHandler } from "@orpc/server/fetch";
import { createFileRoute } from "@tanstack/react-router";
import { onError } from "@orpc/server";
import { appRouter } from "../../orpc/router";

const handler = new RPCHandler(appRouter, {
  interceptors: [onError((error) => console.error("[RPC]", error))],
});

export const Route = createFileRoute("/api/rpc/$")({
  server: {
    handlers: {
      ANY: async ({ request, context }) => {
        const { response } = await handler.handle(request, {
          prefix: "/api/rpc",
          context,
        });
        return response ?? new Response("Not Found", { status: 404 });
      },
    },
  },
});
