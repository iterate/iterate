import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { trpcRouter } from "./integrations/trpc/router.ts";

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (import.meta.env.DEV) return origin;
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

app.all("*", (c) => {
  // Skip Vite's internal paths during development - let Vite handle them
  if (import.meta.env.DEV) {
    const url = new URL(c.req.url);
    const skipPaths = ["/@vite", "/@fs", "/node_modules/.vite", "/__vite_ping"];
    if (skipPaths.some((p) => url.pathname.startsWith(p))) {
      return new Response(null, { status: 404 });
    }
  }

  return handler.fetch(c.req.raw);
});

export default createServerEntry({
  fetch: app.fetch,
});
