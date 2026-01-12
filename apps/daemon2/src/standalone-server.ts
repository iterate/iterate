/**
 * Standalone HTTP server for CLI auto-daemon feature.
 * This can be run directly with `npx tsx` without requiring a full Vite build.
 * It exposes the essential API endpoints (health check, tRPC) without the React frontend.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { trpcRouter } from "./integrations/trpc/router.ts";

const port = parseInt(process.env.PORT || "3000", 10);

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: "*",
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Type"],
    maxAge: 600,
  }),
);

app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/platform/ping", (c) => {
  return c.text("pong");
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

app.all("*", (c) => {
  return c.json(
    {
      error: "Not Found",
      message: "This is the standalone API server. Use the full daemon2 app for the UI.",
    },
    404,
  );
});

console.log(`Starting standalone daemon server on port ${port}...`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`Daemon server running at http://localhost:${port}`);
