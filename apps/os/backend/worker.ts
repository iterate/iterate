import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { contextStorage } from "hono/context-storage";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { CloudflareEnv } from "../env.ts";
import { getDb, type DB } from "./db/client.ts";
import { uploadFileHandler, uploadFileFromURLHandler, getFileHandler } from "./file-handlers.ts";
import { getAuth, type Auth, type AuthSession } from "./auth/auth.ts";
import { appRouter } from "./trpc/root.ts";
import { createContext } from "./trpc/context.ts";
import { IterateAgent } from "./agent/iterate-agent.ts";
import { SlackAgent } from "./agent/slack-agent.ts";
import { slackApp } from "./integrations/slack/slack.ts";
import { OrganizationWebSocket } from "./durable-objects/organization-websocket.ts";
import { runConfigInSandbox } from "./sandbox/run-config.ts";
import { githubApp } from "./integrations/github/router.ts";

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
  console.log("session", session);
  c.set("db", db);
  c.set("auth", auth);
  c.set("session", session);
  return next();
});

app.all("/api/create-admin", async (c) => {
  const auth = getAuth(c.var.db);
  const admin = await auth.api.createUser({
    body: {
      email: "admin@example.com",
      name: "Admin",
      password: "password",
      role: "admin",
    },
  });
  return c.json({ admin });
});

app.all("/api/auth/*", (c) => c.var.auth.handler(c.req.raw));

// agent websocket endpoint
app.all("/api/agents/:estateId/:className/:agentInstanceName", async (c) => {
  const agentClassName = c.req.param("className")!;
  const agentInstanceName = c.req.param("agentInstanceName")!;

  if (agentClassName !== "IterateAgent" && agentClassName !== "SlackAgent") {
    return c.json({ error: "Invalid agent class name" }, 400);
  }

  try {
    const agentStub =
      agentClassName === "SlackAgent"
        ? await SlackAgent.getStubByName({ db: c.var.db, agentInstanceName })
        : await IterateAgent.getStubByName({ db: c.var.db, agentInstanceName });
    return agentStub.fetch(c.req.raw);
  } catch (error) {
    const message = (error as Error).message || "Unknown error";
    if (message.includes("not found")) {
      return c.json({ error: "Agent not found" }, 404);
    }
    console.error("Failed to get agent stub:", error);
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
    onError: (opts) => {
      console.error("TRPC error:", opts.error);
      return opts.error;
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
app.get("/api/estate/:estateId/files/:id", getFileHandler);

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
      workingDirectory: z
        .string()
        .refine(
          (val) => !val || !val.startsWith("/"),
          "Working directory should be a relative path within the repository",
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
      console.error("Test build error:", error);
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
}

export { IterateAgent, SlackAgent, OrganizationWebSocket };
export { Sandbox } from "@cloudflare/sandbox";
