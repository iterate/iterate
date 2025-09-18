import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { contextStorage } from "hono/context-storage";
import { and, eq } from "drizzle-orm";
import type { CloudflareEnv } from "../env.ts";
import { getDb, type DB } from "./db/client.ts";
import { uploadFileHandler, uploadFileFromUrlHandler, getFileHandler } from "./file-handlers.ts";
import { getAuth, type Auth, type AuthSession } from "./auth/auth.ts";
import { appRouter } from "./trpc/root.ts";
import { createContext } from "./trpc/context.ts";
import { IterateAgent } from "./agent/iterate-agent.ts";
import { SlackAgent } from "./agent/slack-agent.ts";
import { slackApp } from "./integrations/slack/slack.ts";
import { getAgentStub } from "./agent/agent-stub-utils.ts";
import { OrganizationWebSocket } from "./durable-objects/organization-websocket.ts";
import { agentInstance } from "./db/schema.ts";

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

// agent websocket endpoint
app.all("/api/agents/:estateId/:className/:agentInstanceName", async (c) => {
  const estateId = c.req.param("estateId")!;
  const agentClassName = c.req.param("className")!;
  const agentInstanceName = c.req.param("agentInstanceName")!;

  if (agentClassName !== "IterateAgent" && agentClassName !== "SlackAgent") {
    return c.json({ error: "Invalid agent class name" }, 400);
  }

  const agentRecord = await c.var.db.query.agentInstance.findFirst({
    where: and(
      eq(agentInstance.estateId, estateId),
      eq(agentInstance.durableObjectName, agentInstanceName),
      eq(agentInstance.className, agentClassName),
    ),
  });

  if (!agentRecord) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const agentStub = await getAgentStub({
    durableObjectClassName: agentClassName,
    durableObjectName: agentInstanceName,
    agentRecord,
  });

  return agentStub.fetch(c.req.raw);
});

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

// WebSocket endpoint for organization connections
app.get("/api/ws/:organizationId", async (c) => {
  const organizationId = c.req.param("organizationId");

  // Get the Durable Object ID for this organization
  const id = c.env.ORGANIZATION_WEBSOCKET.idFromName(organizationId);
  const stub = c.env.ORGANIZATION_WEBSOCKET.get(id);

  // Forward the request to the Durable Object
  const url = new URL(c.req.url);
  url.searchParams.set("organizationId", organizationId);

  return stub.fetch(
    new Request(url.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    }),
  );
});

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

export { IterateAgent, SlackAgent, OrganizationWebSocket };
