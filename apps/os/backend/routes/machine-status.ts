import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { TRPCRouter } from "../../../daemon/server/trpc/router.ts";
import type { CloudflareEnv } from "../../env.ts";
import type { Variables } from "../worker.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { parseMachineIdFromApiKey, verifyMachineApiKey } from "../trpc/routers/machine.ts";
import { getGitHubInstallationToken, getRepositoryById } from "../integrations/github/github.ts";
import { createDaytonaProvider } from "../providers/daytona.ts";
import { createLocalDockerProvider } from "../providers/local-docker.ts";
import { broadcastInvalidation } from "../utils/query-invalidation.ts";

function createDaemonTrpcClient(baseUrl: string) {
  return createTRPCClient<TRPCRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/api/trpc`,
      }),
    ],
  });
}

export const machineStatusApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * POST /api/machines/status
 *
 * Called by the daemon when it boots to report that it's ready.
 * The daemon provides its API key in the Authorization header.
 *
 * Flow:
 * 1. Verify API key and extract machine ID
 * 2. Update machine metadata to mark daemon as ready
 * 3. Call back to daemon with env vars and repos to clone
 */
machineStatusApp.post(
  "/status",
  zValidator(
    "json",
    z.object({
      status: z.enum(["ready", "error"]).default("ready"),
      message: z.string().optional(),
    }),
  ),
  async (c) => {
    // Extract API key from Authorization header
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const apiKey = authHeader.slice(7); // Remove "Bearer " prefix
    const machineId = parseMachineIdFromApiKey(apiKey);

    if (!machineId) {
      logger.warn("Invalid machine API key format", { apiKey: apiKey.slice(0, 20) + "..." });
      return c.json({ error: "Invalid API key format" }, 401);
    }

    // Look up machine and verify API key
    const machine = await c.var.db.query.machine.findFirst({
      where: eq(schema.machine.id, machineId),
      with: {
        project: {
          with: {
            organization: true,
          },
        },
      },
    });

    if (!machine) {
      logger.warn("Machine not found for status report", { machineId });
      return c.json({ error: "Machine not found" }, 404);
    }

    if (!machine.apiKeyHash) {
      logger.error("Machine has no API key hash", { machineId });
      return c.json({ error: "Machine not configured for authentication" }, 500);
    }

    const isValid = await verifyMachineApiKey(apiKey, machine.apiKeyHash);
    if (!isValid) {
      logger.warn("Invalid API key for machine", { machineId });
      return c.json({ error: "Invalid API key" }, 401);
    }

    const { status, message } = c.req.valid("json");

    // Update machine metadata to mark daemon as ready
    const updatedMetadata = {
      ...((machine.metadata as Record<string, unknown>) ?? {}),
      daemonStatus: status,
      daemonStatusMessage: message,
      daemonReadyAt: status === "ready" ? new Date().toISOString() : null,
    };

    await c.var.db
      .update(schema.machine)
      .set({ metadata: updatedMetadata })
      .where(eq(schema.machine.id, machineId));

    logger.info("Machine daemon status updated", { machineId, status });

    // Broadcast invalidation to update UI in real-time
    c.executionCtx.waitUntil(
      broadcastInvalidation(c.env).catch((err) => {
        logger.error("Failed to broadcast invalidation", err);
      }),
    );

    // If daemon is ready, trigger bootstrap callbacks
    if (status === "ready") {
      // Use waitUntil to run callbacks in the background
      c.executionCtx.waitUntil(
        triggerBootstrapCallbacks(c.env, c.var.db, machine).catch((err) => {
          logger.error("Failed to trigger bootstrap callbacks", err);
        }),
      );
    }

    return c.json({ success: true });
  },
);

type MachineWithProject = typeof schema.machine.$inferSelect & {
  project: typeof schema.project.$inferSelect & {
    organization: typeof schema.organization.$inferSelect;
  };
};

type RepoInfo = {
  url: string;
  branch: string;
  path: string;
  owner: string;
  name: string;
};

/**
 * Trigger callbacks to the daemon to inject env vars and clone repos.
 * This runs in the background via waitUntil.
 */
async function triggerBootstrapCallbacks(
  env: CloudflareEnv,
  db: import("../db/client.ts").DB,
  machine: MachineWithProject,
) {
  const { project } = machine;

  // Get the daemon URL using the appropriate provider
  let daemonBaseUrl: string;
  const metadata = machine.metadata as Record<string, unknown>;

  if (machine.type === "daytona") {
    const provider = createDaytonaProvider(env.DAYTONA_API_KEY, env.DAYTONA_SNAPSHOT_PREFIX);
    daemonBaseUrl = provider.getPreviewUrl(machine.externalId, metadata, 3000);
  } else if (machine.type === "local-docker") {
    const provider = createLocalDockerProvider({ imageName: "iterate-sandbox:local" });
    daemonBaseUrl = provider.getPreviewUrl(machine.externalId, metadata, 3000);
  } else if (machine.type === "local-vanilla") {
    // local-vanilla machines run the daemon directly on localhost:3000
    daemonBaseUrl = "http://localhost:3000";
  } else {
    // Exhaustive check - if we get here, a new machine type was added without updating this function
    const _exhaustiveCheck: never = machine.type;
    logger.error("Unknown machine type", { machineId: machine.id, type: _exhaustiveCheck });
    return;
  }

  logger.info("Triggering bootstrap callbacks", { machineId: machine.id, daemonBaseUrl });

  // 1. Gather env vars to inject (GitHub token, etc.)
  const envVarsToInject: Record<string, string> = {};

  // Get GitHub connection and token (filter by provider to avoid returning non-GitHub connections)
  const githubConnection = await db.query.projectConnection.findFirst({
    where: (conn, { and, eq: whereEq }) =>
      and(whereEq(conn.projectId, project.id), whereEq(conn.provider, "github-app")),
  });

  if (githubConnection) {
    const providerData = githubConnection.providerData as { installationId?: number };
    if (providerData.installationId) {
      const installationToken = await getGitHubInstallationToken(env, providerData.installationId);
      if (installationToken) {
        envVarsToInject["GITHUB_ACCESS_TOKEN"] = installationToken;
      }
    }
  }

  // Add HTTPS_PROXY if configured (for future use)
  // envVarsToInject["HTTPS_PROXY"] = `${env.VITE_PUBLIC_URL}/proxy/...`;

  // 2. Call daemon to inject env vars
  const daemonClient = createDaemonTrpcClient(daemonBaseUrl);

  if (Object.keys(envVarsToInject).length > 0) {
    try {
      await daemonClient.platform.setEnvVars.mutate({ vars: envVarsToInject });
      logger.info("Injected env vars to daemon", {
        machineId: machine.id,
        varCount: Object.keys(envVarsToInject).length,
      });
    } catch (err) {
      logger.error("Error calling daemon setEnvVars", err);
    }
  }

  // 3. Get repos to clone
  const projectRepos = await db.query.projectRepo.findMany({
    where: eq(schema.projectRepo.projectId, project.id),
  });

  if (projectRepos.length > 0 && githubConnection) {
    const providerData = githubConnection.providerData as { installationId?: number };
    if (providerData.installationId) {
      const installationToken = await getGitHubInstallationToken(env, providerData.installationId);
      if (installationToken) {
        // Build repos array with clone URLs
        const repos: (RepoInfo | null)[] = await Promise.all(
          projectRepos.map(async (repo): Promise<RepoInfo | null> => {
            const repoInfo = await getRepositoryById(installationToken, repo.externalId);
            if (!repoInfo) {
              logger.warn("Could not fetch repo info", { repoId: repo.externalId });
              return null;
            }
            return {
              url: `https://x-access-token:${installationToken}@github.com/${repoInfo.owner}/${repoInfo.name}.git`,
              branch: repoInfo.defaultBranch,
              path: `~/src/github.com/${repoInfo.owner}/${repoInfo.name}`,
              owner: repoInfo.owner,
              name: repoInfo.name,
            };
          }),
        );

        const validRepos = repos.filter((r): r is RepoInfo => r !== null);

        if (validRepos.length > 0) {
          try {
            await daemonClient.platform.cloneRepos.mutate({ repos: validRepos });
            logger.info("Triggered repo cloning on daemon", {
              machineId: machine.id,
              repoCount: validRepos.length,
            });
          } catch (err) {
            logger.error("Error calling daemon cloneRepos", err);
          }
        }
      }
    }
  }
}
