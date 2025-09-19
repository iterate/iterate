import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { contextStorage } from "hono/context-storage";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { CloudflareEnv } from "../env.ts";
import { getDb, type DB } from "./db/client.ts";
import { uploadFileHandler, uploadFileFromUrlHandler, getFileHandler } from "./file-handlers.ts";
import { getAuth, type Auth, type AuthSession } from "./auth/auth.ts";
import { appRouter } from "./trpc/root.ts";
import { createContext } from "./trpc/context.ts";
import { IterateAgent } from "./agent/iterate-agent.ts";
import { SlackAgent } from "./agent/slack-agent.ts";
import { slackApp } from "./integrations/slack/slack.ts";
import { OrganizationWebSocket } from "./durable-objects/organization-websocket.ts";
import { runConfigInSandbox } from "./sandbox/run-config.ts";
import { githubApp } from "./integrations/github/router.ts";
import {
  validateGithubWebhookSignature,
  getEstateByRepoId,
  getGithubInstallationForEstate,
  getGithubInstallationToken,
} from "./integrations/github/github-utils.ts";
import * as schemas from "./db/schema.ts";

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

// GitHub webhook handler
app.post("/api/webhooks/github", async (c) => {
  try {
    // Get the webhook payload and signature
    const signature = c.req.header("X-Hub-Signature-256");
    const payload = await c.req.text();

    // Validate the webhook signature
    if (!c.env.GITHUB_WEBHOOK_SECRET) {
      console.error("GITHUB_WEBHOOK_SECRET not configured");
      return c.json({ error: "Webhook secret not configured" }, 500);
    }

    const isValid = validateGithubWebhookSignature(
      payload,
      signature || null,
      c.env.GITHUB_WEBHOOK_SECRET,
    );

    if (!isValid) {
      console.error("Invalid webhook signature");
      return c.json({ error: "Invalid signature" }, 401);
    }

    // Parse the webhook payload
    const event = JSON.parse(payload);
    const eventType = c.req.header("X-GitHub-Event");

    // We only handle check_suite events from GitHub Apps
    if (eventType !== "check_suite") {
      // Silently ignore other event types
      return c.json({ message: "Event type not relevant" }, 200);
    }

    // Extract repository information
    const repoId = event.repository?.id;
    if (!repoId) {
      console.error("Missing repository information");
      return c.json({ error: "Invalid webhook payload - no repository" }, 400);
    }

    // Only process relevant check_suite actions
    if (event.action !== "requested" && event.action !== "rerequested") {
      // Silently ignore completed, in_progress, etc.
      return c.json({ message: "Check suite action not relevant" }, 200);
    }

    // Extract commit information from check_suite
    const commitHash = event.check_suite?.head_sha;
    const commitMessage = event.check_suite?.head_commit?.message || "Check suite run";
    const branch = event.check_suite?.head_branch;

    if (!commitHash) {
      console.error("Missing commit information in check_suite");
      return c.json({ error: "Invalid webhook payload - no commit hash" }, 400);
    }

    console.log(`Processing check_suite: branch=${branch}, commit=${commitHash.substring(0, 7)}`);

    // Find the estate connected to this repository
    const estate = await getEstateByRepoId(c.var.db, repoId);
    if (!estate) {
      console.log(`No estate found for repository ${repoId}`);
      return c.json({ message: "Repository not connected to any estate" }, 200);
    }

    // Only process if the push is to the configured branch
    if (branch && branch !== estate.connectedRepoRef) {
      console.log(
        `Ignoring event on branch ${branch}, estate configured for ${estate.connectedRepoRef}`,
      );
      return c.json({ message: "Event not on configured branch" }, 200);
    }

    // Get the GitHub installation for this estate
    const githubInstallation = await getGithubInstallationForEstate(c.var.db, estate.id);
    if (!githubInstallation) {
      console.error(`No GitHub installation found for estate ${estate.id}`);
      return c.json({ error: "GitHub installation not found" }, 500);
    }

    // Get an installation access token
    const installationToken = await getGithubInstallationToken(githubInstallation.accountId);
    console.log(`Got installation token for estate ${estate.id}`);
    // Create an in-progress build log
    const [build] = await c.var.db
      .insert(schemas.builds)
      .values({
        status: "in_progress",
        commitHash: commitHash!, // We've already checked this is defined above
        commitMessage: commitMessage || "No commit message",
        webhookIterateId: event.id || `webhook-${Date.now()}`,
        estateId: estate.id,
        iterateWorkflowRunId: event.workflow_run?.id?.toString(),
      })
      .returning();

    // Construct the repository URL
    const repoUrl = event.repository?.html_url || event.repository?.url;
    if (!repoUrl) {
      await c.var.db
        .update(schemas.builds)
        .set({
          status: "failed",
          completedAt: new Date(),
          output: { stderr: "Repository URL not found in webhook payload" },
        })
        .where(eq(schemas.builds.id, build.id));

      return c.json({ error: "Repository URL not found" }, 400);
    }

    // Run the configuration in the sandbox
    const result = await runConfigInSandbox(c.env, {
      githubRepoUrl: repoUrl,
      githubToken: installationToken,
      branch: estate.connectedRepoRef || "main",
      commitHash,
      workingDirectory: estate.connectedRepoPath || undefined,
    });

    // Determine build status based on result
    const buildStatus = "error" in result ? "failed" : "complete";
    const output =
      "error" in result ? { stderr: result.error, details: result.details } : result.output;

    // Update the build log with the result
    await c.var.db
      .update(schemas.builds)
      .set({
        status: buildStatus,
        completedAt: new Date(),
        output,
      })
      .where(eq(schemas.builds.id, build.id));

    // Store the configuration in the iterateConfig table if successful
    if (buildStatus === "complete" && "stdout" in output && output.stdout) {
      try {
        // Parse the output to extract the configuration
        const configData = JSON.parse(output.stdout);

        // Upsert the config - always overwrite if it exists
        await c.var.db
          .insert(schemas.iterateConfig)
          .values({
            config: configData,
            estateId: estate.id,
          })
          .onConflictDoUpdate({
            target: schemas.iterateConfig.estateId,
            set: {
              config: configData,
            },
          });
      } catch (parseError) {
        console.error("Failed to parse configuration output:", parseError);
        // The build succeeded but we couldn't parse the config
        // This is logged but not treated as a build failure
      }
    }

    return c.json({
      message: "Webhook processed",
      buildId: build.id,
      status: buildStatus,
    });
  } catch (error) {
    console.error("GitHub webhook error:", error);
    return c.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
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

export default app;

export { IterateAgent, SlackAgent, OrganizationWebSocket };
export { Sandbox } from "@cloudflare/sandbox";
