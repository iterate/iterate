import { Hono } from "hono";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { contextStorage } from "hono/context-storage";
import { WorkerEntrypoint } from "cloudflare:workers";
import { cors } from "hono/cors";
import { typeid } from "typeid-js";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { z } from "zod/v4";
import type { CloudflareEnv } from "../env.ts";
import { ReactRouterServerContext } from "../app/context.ts";
import { getDb, type DB } from "./db/client.ts";
import {
  uploadFileHandler,
  uploadFileFromURLHandler,
  getFileHandler,
  getExportHandler,
} from "./file-handlers.ts";
import { getAuth, type Auth, type AuthSession } from "./auth/auth.ts";
import { appRouter } from "./trpc/root.ts";
import { createContext } from "./trpc/context.ts";
import { IterateAgent } from "./agent/iterate-agent.ts";
import { OnboardingAgent } from "./agent/onboarding-agent.ts";
import { SlackAgent } from "./agent/slack-agent.ts";
import { slackApp } from "./integrations/slack/slack.ts";
import { OrganizationWebSocket } from "./durable-objects/organization-websocket.ts";
import { EstateBuildTracker } from "./durable-objects/estate-build-tracker.ts";
import { verifySignedUrl } from "./utils/url-signing.ts";
import { getUserEstateAccess } from "./trpc/trpc.ts";
import { githubApp } from "./integrations/github/router.ts";
import { logger } from "./tag-logger.ts";
import { syncSlackForAllEstatesHelper } from "./trpc/routers/admin.ts";
import { AdvisoryLocker } from "./durable-objects/advisory-locker.ts";
import { processSystemTasks } from "./onboarding-tasks.ts";
import { getAgentStubByName, toAgentClassName } from "./agent/agents/stub-getters.ts";

type TrpcCaller = ReturnType<typeof appRouter.createCaller>;
export type Variables = {
  auth: Auth;
  session: AuthSession;
  db: DB;
  trpcCaller: TrpcCaller;
};

const app = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();
app.use(contextStorage());

app.use("*", async (c, next) => {
  const db = getDb();
  const auth = getAuth(db);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("db", db);
  c.set("auth", auth);
  c.set("session", session);
  const trpcCaller = appRouter.createCaller(createContext(c));
  c.set("trpcCaller", trpcCaller);
  return next();
});

app.use("*", async (c, next) => {
  const requestTags = {
    userId: c.var.session?.user?.id || undefined,
    path: c.req.path,
    httpMethod: c.req.method,
    url: c.req.url,
    traceId: typeid("req").toString(),
  };
  return logger.run(requestTags, () => next());
});

app.use(
  "*",
  cors({
    credentials: true,
    origin: (c) => c,
  }),
);

// Error tracking with PostHog
app.onError((err, c) => {
  // Log the error with cause-chaining and contextual suffix
  logger.error(`${err instanceof Error ? err.message : String(err)} (hono unhandled error)`, err);
  // Return error response
  return c.json({ error: "Internal Server Error" }, 500);
});

app.all("/api/auth/*", (c) => c.var.auth.handler(c.req.raw));

// agent websocket endpoint
app.all("/api/agents/:estateId/:className/:agentInstanceName", async (c) => {
  const agentClassName = c.req.param("className")!;
  const agentInstanceName = c.req.param("agentInstanceName")!;

  if (
    agentClassName !== "IterateAgent" &&
    agentClassName !== "SlackAgent" &&
    agentClassName !== "OnboardingAgent"
  ) {
    return c.json({ error: "Invalid agent class name" }, 400);
  }

  try {
    const agentStub = await getAgentStubByName(toAgentClassName(agentClassName), {
      db: c.var.db,
      agentInstanceName,
    });
    return agentStub.raw.fetch(c.req.raw);
  } catch (error) {
    const message = (error as Error).message || "Unknown error";
    if (message.includes("not found")) {
      return c.json({ error: "Agent not found" }, 404);
    }
    logger.error("Failed to get agent stub:", error as Error);
    return c.json({ error: "Failed to connect to agent" }, 500);
  }
});

// tRPC endpoint
app.all("/api/trpc/*", (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    allowMethodOverride: true,
    createContext: () => createContext(c),
    onError: ({ error, path }) => {
      const procedurePath = path ?? "unknown";
      const status = getHTTPStatusCodeFromError(error);
      if (status >= 500) {
        // logger.error tracks the error in posthog - we only want this for 500 errors
        logger.error(
          new Error(`TRPC Error ${status} in ${procedurePath}: ${error.message}`, { cause: error }),
        );
      } else {
        // however, we DO want to log other errors to stdout with path and stacktrace
        logger.warn(`TRPC Error ${status} in ${procedurePath}:\n${error.stack}`);
      }
    },
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
app.post("/api/estate/:estateId/files/from-url", uploadFileFromURLHandler);
app.get("/api/estate/:estateId/exports/:exportId", getExportHandler);

app.get("/api/files/:id", getFileHandler);

// Mount the Slack integration app
app.route("/api/integrations/slack", slackApp);
app.route("/api/integrations/github", githubApp);

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

// Watch logs (admin UI) → DO (requires user session + estate access)
app.get("/api/estate/:estateId/builds/:buildId/ws", async (c) => {
  const estateId = c.req.param("estateId");
  const buildId = c.req.param("buildId");

  const session = c.var.session;
  if (!session?.user) return c.json({ error: "Unauthorized" }, 401);
  const { hasAccess } = await getUserEstateAccess(c.var.db, session.user.id, estateId, undefined);
  if (!hasAccess) return c.json({ error: "Forbidden" }, 403);

  const id = c.env.ESTATE_BUILDS.idFromName(estateId);
  const stub = c.env.ESTATE_BUILDS.get(id);

  const url = new URL(c.req.url);
  url.pathname = "/ws";
  url.searchParams.set("estateId", estateId);
  url.searchParams.set("buildId", buildId);
  return stub.fetch(
    new Request(url.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    }),
  );
});

// Ingest logs via HTTP from container (signed URL required)
app.post("/api/builds/:estateId/:buildId/ingest", async (c) => {
  const estateId = c.req.param("estateId");
  const buildId = c.req.param("buildId");

  const id = c.env.ESTATE_BUILDS.idFromName(estateId);
  const stub = c.env.ESTATE_BUILDS.get(id);

  const url = new URL(c.req.url);
  const hasSignature = !!url.searchParams.get("signature");
  if (!hasSignature) return c.json({ error: "Signature required" }, 401);
  const valid = await verifySignedUrl(c.req.url, c.env.EXPIRING_URLS_SIGNING_KEY);
  if (!valid) return c.json({ error: "Invalid or expired signature" }, 401);

  url.pathname = "/ingest";
  url.searchParams.set("estateId", estateId);
  url.searchParams.set("buildId", buildId);

  return stub.fetch(
    new Request(url.toString(), {
      method: "POST",
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    }),
  );
});

// Ingest agent background task logs (from sandbox/codex), batched every ~10s
app.post("/api/agent-logs/:estateId/:className/:durableObjectName/ingest", async (c) => {
  const estateId = c.req.param("estateId");
  const durableObjectName = c.req.param("durableObjectName");

  const url = new URL(c.req.url);
  const hasSignature = !!url.searchParams.get("signature");
  if (!hasSignature) return c.json({ error: "Signature required" }, 401);
  const valid = await verifySignedUrl(c.req.url, c.env.EXPIRING_URLS_SIGNING_KEY);
  if (!valid) return c.json({ error: "Invalid or expired signature" }, 401);

  // Parse body
  const body = (await c.req.json()) as unknown;
  const LogItem = z.object({
    seq: z.number(),
    ts: z.number(),
    stream: z.enum(["stdout", "stderr"]),
    message: z.string(),
    event: z.string().optional(),
  });
  const Body = z.object({
    processId: z.string(),
    logs: z.array(LogItem).default([]),
  });
  const parsed = Body.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid payload" }, 400);
  const { processId, logs } = parsed.data;

  const agent = await getAgentStubByName(toAgentClassName(c.req.param("className")!), {
    db: c.var.db,
    agentInstanceName: durableObjectName,
    estateId,
  });
  const result = (await agent.ingestBackgroundLogs({
    processId,
    logs,
  })) as { lastSeq?: number } | void;
  const lastSeq = result && typeof result.lastSeq === "number" ? result.lastSeq : undefined;
  return c.json({ ok: true, lastSeq });
});

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

app.all("*", (c) => {
  const contextProvider = new RouterContextProvider();
  contextProvider.set(ReactRouterServerContext, {
    cloudflare: { env: c.env, ctx: c.executionCtx },
    variables: c.var,
  });
  return requestHandler(c.req.raw, contextProvider);
});

// In order to use cloudflare's fancy RPC system, we need to export a WorkerEntrypoint subclass.
// Any methods on this class can be called via worker binding
// The special `fetch` method is used to handle HTTP requests
// This is only really needed when we have multiple workers, though. I just ported it over because I mistakenly
// thought we need it sooner
export default class extends WorkerEntrypoint {
  fetch(request: Request) {
    return app.fetch(request, this.env, this.ctx);
  }

  async scheduled(controller: ScheduledController) {
    const db = getDb();
    switch (controller.cron) {
      case "*/1 * * * *": {
        try {
          logger.info("Running scheduled onboarding tasks");
          const result = await processSystemTasks(db);
          logger.info("Onboarding tasks completed", result);
        } catch (error) {
          logger.error("Onboarding tasks failed:", error);
        }
        break;
      }
      case "0 0 * * *": {
        try {
          logger.info("Running scheduled Slack sync for all estates");
          const result = await syncSlackForAllEstatesHelper(db);
          logger.info("Scheduled Slack sync completed", {
            total: result.total,
            successful: result.results.filter((r) => r.success).length,
            failed: result.results.filter((r) => !r.success).length,
          });
        } catch (error) {
          logger.error("Scheduled Slack sync failed:", error);
        }
        break;
      }
      default:
        logger.error("Unknown cron pattern:", controller.cron);
    }
  }
}

export {
  IterateAgent,
  OnboardingAgent,
  SlackAgent,
  OrganizationWebSocket,
  AdvisoryLocker,
  EstateBuildTracker,
};
export { Sandbox } from "@cloudflare/sandbox";
