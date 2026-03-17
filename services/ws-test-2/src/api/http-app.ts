import { Hono } from "hono";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { serviceName, type WsTest2Context } from "./context.ts";
import { router } from "./router.ts";

export function applySharedHttpRoutes(
  app: Hono<any>,
  params: { getContext: () => WsTest2Context },
) {
  const rpcHandler = new RPCHandler(router, {
    interceptors: [
      onError((error) => {
        console.error(error);
      }),
    ],
  });

  app.all("/api/rpc/*", async (c) => {
    const { matched, response } = await rpcHandler.handle(c.req.raw, {
      prefix: "/api/rpc",
      context: params.getContext(),
    });

    if (!matched || !response) {
      return c.json({ error: "not_found" }, 404);
    }

    return c.newResponse(response.body, response);
  });

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      service: serviceName,
    }),
  );
}
