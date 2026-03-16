import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { renderAppShell, isProductionRuntime } from "./html.ts";
import { httpRpcHandler } from "./orpc.ts";

const app = new Hono();

app.use("/rpc/*", async (c, next) => {
  const { matched, response } = await httpRpcHandler.handle(c.req.raw, {
    prefix: "/rpc",
    context: {},
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  await next();
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "ws-test",
  }),
);

if (isProductionRuntime()) {
  app.use(
    "/static/*",
    serveStatic({
      root: "./dist/client",
    }),
  );
}

app.get("*", (c) => c.html(renderAppShell()));

export default app;
