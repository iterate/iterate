import * as path from "path";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { serveStatic } from "@hono/node-server/serve-static";
import { trpcRouter } from "./trpc/router.ts";
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

app.all("/api/trpc/*", (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: trpcRouter,
    allowMethodOverride: true,
    onError: ({ error, path }) => {
      const procedurePath = path ?? "unknown";
      const status = getHTTPStatusCodeFromError(error);
      if (status >= 500) {
        console.error(`tRPC Error ${status} in ${procedurePath}: ${error.message}`);
      } else {
        console.warn(`tRPC Error ${status} in ${procedurePath}:\n${error.stack}`);
      }
    },
  });
});

app.route("/api/pty", ptyRouter);
app.route("/api/integrations/slack", slackRouter);

const distDir = path.join(import.meta.dirname, "../dist");
app.use("/*", serveStatic({ root: distDir }));
app.get("*", serveStatic({ root: distDir, path: "index.html" }));

export default app;
