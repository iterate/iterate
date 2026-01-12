import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { trpcRouter } from "./integrations/trpc/router.ts";
import { daemonApp } from "./backend/daemon-app.ts";

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
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "Stream-Seq",
      "Stream-TTL",
      "Stream-Expires-At",
    ],
    exposeHeaders: [
      "Stream-Next-Offset",
      "Stream-Cursor",
      "Stream-Up-To-Date",
      "ETag",
      "Content-Type",
      "Content-Encoding",
      "Vary",
      "Location",
    ],
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

app.route("/api", daemonApp);

app.all("*", (c) => {
  return handler.fetch(c.req.raw);
});

export default createServerEntry({
  fetch: app.fetch,
});
