import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { contextStorage } from "hono/context-storage";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { WorkerEntrypoint } from "cloudflare:workers";
import { cors } from "hono/cors";
import { typeid } from "typeid-js";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { type CloudflareEnv } from "../env.ts";
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
import { runConfigInSandbox } from "./sandbox/run-config.ts";
import { githubApp } from "./integrations/github/router.ts";
import { buildCallbackApp } from "./integrations/github/build-callback.ts";
import { logger } from "./tag-logger.ts";
import { syncSlackForAllEstatesHelper } from "./trpc/routers/admin.ts";
import { getAgentStubByName, toAgentClassName } from "./agent/agents/stub-getters.ts";

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
  workerEntrypoint?: WorkerEntrypoint;
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
    return agentStub.fetch(c.req.raw);
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
    createContext: (opts) => createContext(c, opts),
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
app.route("/api/build", buildCallbackApp);

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

// Test build endpoint for sandbox
app.post(
  "/api/test-build",
  zValidator(
    "json",
    z.object({
      githubRepoUrl: z
        .string()
        .url()
        .regex(/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/, {
          message: "Invalid GitHub repository URL format",
        }),
      githubToken: z.string().min(1, "GitHub token is required"),
      branch: z.string().optional(),
      commitHash: z
        .string()
        .regex(/^[a-f0-9]{7,40}$/i, "Invalid commit hash format")
        .optional(),
      connectedRepoPath: z
        .string()
        .refine(
          (val) => !val || !val.startsWith("/"),
          "Directory to use within the connected repository",
        )
        .optional(),
    }),
  ),
  async (c) => {
    try {
      const body = c.req.valid("json");

      // Run the configuration in the sandbox
      const result = await runConfigInSandbox(c.env, body);

      // Return appropriate status code based on the result
      if ("error" in result) {
        return c.json(result, 400);
      }

      return c.json(result);
    } catch (error) {
      logger.error(
        "Test build error:",
        error instanceof Error ? error : new Error(error as string),
      );
      return c.json(
        {
          error: "Internal server error during build test",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

const requestHandler = createRequestHandler(
  // @ts-ignore - this is a virtual module
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

app.all("*", (c) => {
  return requestHandler(c.req.raw, {
    cloudflare: { env: c.env, ctx: c.executionCtx },
  });
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
    switch (controller.cron) {
      case "0 0 * * *": {
        const db = getDb();

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

export { IterateAgent, OnboardingAgent, SlackAgent, OrganizationWebSocket };
export { Sandbox } from "@cloudflare/sandbox";
