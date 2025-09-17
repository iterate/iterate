import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { contextStorage } from "hono/context-storage";
import type { CloudflareEnv } from "../env.ts";
import { getDb, type DB } from "./db/client.ts";
import { uploadFileHandler, uploadFileFromUrlHandler, getFileHandler } from "./file-handlers.ts";
import { getAuth, type Auth, type AuthSession } from "./auth/auth.ts";
import { appRouter } from "./trpc/root.ts";
import { createContext } from "./trpc/context.ts";
import { IterateAgent } from "./agent/iterate-agent.ts";
import { SlackAgent } from "./agent/slack-agent.ts";
import { slackApp } from "./integrations/slack/slack.ts";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: CloudflareEnv;
      ctx: ExecutionContext;
    };
  }
}

export type Variables = {
  auth: Auth;
  session: AuthSession;
  db: DB;
};

const app = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();
app.use(contextStorage());

app.use("*", async (c, next) => {
  const db = getDb();
  const auth = getAuth(db);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  c.set("db", db);
  c.set("auth", auth);
  c.set("session", session);
  return next();
});

app.all("/api/auth/*", (c) => c.var.auth.handler(c.req.raw));

// tRPC endpoint
app.all("/api/trpc/*", (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: (opts) => createContext(c, opts),
  });
});

// File upload routes
app.use("/api/estate/:estateId/*", async (c, next) => {
  if (!c.var.session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  //TODO: session.user.estates.includes(c.req.param("estateId")) -> PASS
  return next();
});

app.post("/api/estate/:estateId/files", uploadFileHandler);
app.post("/api/estate/:estateId/files/from-url", uploadFileFromUrlHandler);
app.get("/api/estate/:estateId/files/:id", getFileHandler);

// Mount the Slack integration app
app.route("/api/integrations/slack", slackApp);

const requestHandler = createRequestHandler(
  //@ts-expect-error - this is a virtual module
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

app.all("*", (c) => {
  return requestHandler(c.req.raw, {
    cloudflare: { env: c.env, ctx: c.executionCtx },
  });
});

export default app;

export { IterateAgent, SlackAgent };
