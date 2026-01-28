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
import { emailRouter } from "./routers/email.ts";
import { agentsRouter } from "./routers/agents.ts";
import { opencodeRouter, piRouter, claudeRouter, codexRouter } from "./routers/agents/index.ts";

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

app.route("/api/agents", agentsRouter);
app.route("/api/opencode", opencodeRouter);
app.route("/api/pi", piRouter);
app.route("/api/claude", claudeRouter);
app.route("/api/codex", codexRouter);

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
app.route("/api/integrations/email", emailRouter);

const distDir = path.join(import.meta.dirname, "../dist");
app.use("/*", serveStatic({ root: distDir }));
app.get("*", serveStatic({ root: distDir, path: "index.html" }));

export default app;
