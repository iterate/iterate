import * as path from "path";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { RPCHandler } from "@orpc/server/fetch";
import { ORPCError, onError } from "@orpc/server";
import { serveStatic } from "@hono/node-server/serve-static";
import { orpcRouter } from "./trpc/router.ts";
import { baseApp } from "./utils/hono.ts";
import { ptyRouter } from "./routers/pty.ts";
import { slackRouter } from "./routers/slack.ts";

const app = baseApp.use(
  logger(),
  cors({
    origin: (origin) => {
      if (process.env.NODE_ENV === "development") return origin;
      return null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Type"],
    maxAge: 600,
  }),
  secureHeaders(),
);

app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// oRPC handler
const rpcHandler = new RPCHandler(orpcRouter, {
  interceptors: [
    onError((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      const status = error instanceof ORPCError ? error.status : 500;
      if (status >= 500) {
        console.error(`oRPC Error ${status}: ${err.message}`);
      } else {
        console.warn(`oRPC Error ${status}:\n${err.stack}`);
      }
    }),
  ],
});

app.all("/api/trpc/*", async (c) => {
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: "/api/trpc",
    context: {},
  });

  if (matched && response) {
    return c.newResponse(response.body, response);
  }

  return c.json({ error: "Not found" }, 404);
});

app.route("/api/pty", ptyRouter);
app.route("/api/integrations/slack", slackRouter);

const distDir = path.join(import.meta.dirname, "../dist");
app.use("/*", serveStatic({ root: distDir }));
app.get("*", serveStatic({ root: distDir, path: "index.html" }));

export default app;
