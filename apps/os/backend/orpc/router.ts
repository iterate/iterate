import { implement, ORPCError } from "@orpc/server";
import type { RequestHeadersPluginContext } from "@orpc/server/plugins";
import { eq, and } from "drizzle-orm";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createMachineProvider } from "../providers/index.ts";
import { workerContract } from "../../../daemon/server/orpc/contract.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { parseTokenIdFromApiKey } from "../egress-proxy/api-key-utils.ts";
import { getGitHubInstallationToken, getRepositoryById } from "../integrations/github/github.ts";
import { broadcastInvalidation } from "../utils/query-invalidation.ts";
import { decrypt } from "../utils/encryption.ts";
import { getUnifiedEnvVars } from "../utils/env-vars.ts";
import type { TRPCRouter } from "../../../daemon/server/trpc/router.ts";
import type { CloudflareEnv } from "../../env.ts";

/** Initial context provided by the handler */
export type ORPCContext = RequestHeadersPluginContext & {
  db: DB;
  env: CloudflareEnv;
  executionCtx: ExecutionContext;
};

export function createDaemonTrpcClient(baseUrl: string) {
  return createTRPCClient<TRPCRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/api/trpc`,
      }),
    ],
  });
}

const os = implement(workerContract).$context<ORPCContext>();

/** Middleware that extracts and validates API key from Authorization header */
const withApiKey = os.middleware(async ({ context, next }) => {
  const authHeader = context.reqHeaders?.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new ORPCError("UNAUTHORIZED", { message: "Missing or invalid Authorization header" });
  }

  const apiKey = authHeader.slice(7); // Remove "Bearer " prefix
  return next({ context: { apiKey } });
});

/**
 * Authenticate an API key and return the associated machine.
 * API key format: pak_<tokenId>_<randomHex>
 *
 * The token is project-scoped (shared by all machines in the project).
 * Machine ID is provided separately to identify which machine is calling.
 */
async function authenticateApiKey(
  db: DB,
  apiKey: string,
  machineId: string,
): Promise<{
  machine: typeof schema.machine.$inferSelect & {
    project: typeof schema.project.$inferSelect;
  };
  tokenId: string;
}> {
  const tokenId = parseTokenIdFromApiKey(apiKey);
  if (!tokenId) {
    logger.warn("Invalid API key format", { apiKey: apiKey.slice(0, 20) + "..." });
    throw new ORPCError("UNAUTHORIZED", { message: "Invalid API key format" });
  }

  const accessToken = await db.query.projectAccessToken.findFirst({
    where: eq(schema.projectAccessToken.id, tokenId),
  });

  if (!accessToken) {
    logger.warn("Access token not found", { tokenId });
    throw new ORPCError("UNAUTHORIZED", { message: "Invalid API key" });
  }

  if (accessToken.revokedAt) {
    logger.warn("Access token revoked", { tokenId });
    throw new ORPCError("UNAUTHORIZED", { message: "Token has been revoked" });
  }

  // Decrypt the stored token and compare with the provided API key
  const storedToken = await decrypt(accessToken.encryptedToken);
  if (apiKey !== storedToken) {
    logger.warn("Invalid API key for token", { tokenId });
    throw new ORPCError("UNAUTHORIZED", { message: "Invalid API key" });
  }

  // Find the machine by ID and verify it belongs to the same project as the token
  const machine = await db.query.machine.findFirst({
    where: eq(schema.machine.id, machineId),
    with: { project: true },
  });

  if (!machine) {
    logger.warn("Machine not found", { machineId });
    throw new ORPCError("UNAUTHORIZED", { message: "Machine not found" });
  }

  if (machine.projectId !== accessToken.projectId) {
    logger.warn("Machine does not belong to token's project", {
      machineId,
      machineProjectId: machine.projectId,
      tokenProjectId: accessToken.projectId,
    });
    throw new ORPCError("UNAUTHORIZED", { message: "Token not valid for this machine" });
  }

  // Update last used timestamp in background
  db.update(schema.projectAccessToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.projectAccessToken.id, tokenId))
    .catch(() => {});

  return { machine, tokenId };
}

export const reportStatus = os.machines.reportStatus
  .use(withApiKey)
  .handler(async ({ input, context }) => {
    const { db, env, apiKey, executionCtx } = context;

    // Authenticate and get machine
    const { machine } = await authenticateApiKey(db, apiKey, input.machineId);

    // Re-fetch with organization for invalidation
    const machineWithOrg = await db.query.machine.findFirst({
      where: eq(schema.machine.id, machine.id),
      with: { project: { with: { organization: true } } },
    });

    if (!machineWithOrg) {
      throw new ORPCError("NOT_FOUND", { message: "Machine not found" });
    }

    const { status, message } = input;

    // Update machine metadata to mark daemon as ready
    const updatedMetadata = {
      ...((machineWithOrg.metadata as Record<string, unknown>) ?? {}),
      daemonStatus: status,
      daemonStatusMessage: message,
      daemonReadyAt: status === "ready" ? new Date().toISOString() : null,
    };

    // If machine is in 'starting' state and daemon reports ready, activate it
    // This archives any existing active machine and promotes this one to active
    if (status === "ready" && machineWithOrg.state === "starting") {
      // Use transaction to ensure atomic activation - prevents race conditions
      // if two machines report ready simultaneously
      const archivedMachines = await db.transaction(async (tx) => {
        // Archive all currently active machines for this project
        const activeMachines = await tx.query.machine.findMany({
          where: and(
            eq(schema.machine.projectId, machineWithOrg.projectId),
            eq(schema.machine.state, "active"),
          ),
        });

        for (const activeMachine of activeMachines) {
          // Archive in DB (within transaction)
          await tx
            .update(schema.machine)
            .set({ state: "archived" })
            .where(eq(schema.machine.id, activeMachine.id));

          logger.info("Archived existing active machine", { machineId: activeMachine.id });
        }

        // Promote this machine to active
        await tx
          .update(schema.machine)
          .set({ state: "active", metadata: updatedMetadata })
          .where(eq(schema.machine.id, machine.id));

        logger.info("Machine activated", { machineId: machine.id });

        return activeMachines;
      });

      // Archive via provider AFTER transaction commits
      // This is intentional - we want DB state to be consistent first,
      // then clean up provider resources. Provider failures are logged but don't rollback.
      // TODO: Replace with outbox consumer once outbox system is added
      for (const activeMachine of archivedMachines) {
        const provider = await createMachineProvider({
          type: activeMachine.type,
          env,
          externalId: activeMachine.externalId,
          metadata: (activeMachine.metadata as Record<string, unknown>) ?? {},
          buildProxyUrl: () => "",
        });
        await provider.archive().catch((err) => {
          logger.error("Failed to archive machine via provider", {
            machineId: activeMachine.id,
            err,
          });
        });
      }
    } else {
      // Just update metadata
      await db
        .update(schema.machine)
        .set({ metadata: updatedMetadata })
        .where(eq(schema.machine.id, machine.id));

      logger.info("Machine daemon status updated", { machineId: machine.id, status });
    }

    // Broadcast invalidation to update UI in real-time
    executionCtx.waitUntil(
      broadcastInvalidation(env).catch((err) => {
        logger.error("Failed to broadcast invalidation", err);
      }),
    );

    // Note: Bootstrap data is now pulled by the daemon via getBootstrapData endpoint
    // after it reports ready. No push-based callback needed.

    return { success: true };
  });

export const getEnv = os.machines.getEnv.use(withApiKey).handler(async ({ input, context }) => {
  const { db, env, apiKey } = context;

  // Authenticate and get machine
  const { machine } = await authenticateApiKey(db, apiKey, input.machineId);
  const { project } = machine;
  const machineId = machine.id;

  // Get unified env vars using shared function
  const [unifiedEnvVars, githubConnection, projectRepos] = await Promise.all([
    getUnifiedEnvVars(db, project.id),
    db.query.projectConnection.findFirst({
      where: (conn, { and: whereAnd, eq: whereEq }) =>
        whereAnd(whereEq(conn.projectId, project.id), whereEq(conn.provider, "github-app")),
    }),
    db.query.projectRepo.findMany({
      where: eq(schema.projectRepo.projectId, project.id),
    }),
  ]);

  // Get GitHub installation token (needed for repos)
  let installationToken: string | null = null;
  if (githubConnection) {
    const providerData = githubConnection.providerData as { installationId?: number };
    if (providerData.installationId) {
      installationToken = await getGitHubInstallationToken(env, providerData.installationId);
    }
  }

  // Process repo info
  type RepoInfo = {
    url: string;
    branch: string;
    path: string;
    owner: string;
    name: string;
  };

  const repoResults =
    installationToken && projectRepos.length > 0
      ? await Promise.all(
          projectRepos.map(async (repo): Promise<RepoInfo | null> => {
            const repoInfo = await getRepositoryById(installationToken, repo.externalId);
            if (!repoInfo) {
              logger.warn("Could not fetch repo info", { repoId: repo.externalId });
              return null;
            }
            return {
              // Plain URL - auth is handled by GIT_CONFIG_* env vars which rewrite to include magic string
              url: `https://github.com/${repoInfo.owner}/${repoInfo.name}.git`,
              branch: repoInfo.defaultBranch,
              path: `/home/iterate/src/github.com/${repoInfo.owner}/${repoInfo.name}`,
              owner: repoInfo.owner,
              name: repoInfo.name,
            };
          }),
        )
      : [];

  const repos = repoResults.filter((r): r is RepoInfo => r !== null);

  // Add daemon-specific env vars not shown in frontend
  const daemonEnvVars: typeof unifiedEnvVars = [
    ...unifiedEnvVars,
    {
      key: "ITERATE_RESEND_FROM_ADDRESS",
      value: `${env.VITE_APP_STAGE}@${env.RESEND_BOT_DOMAIN}`,
      isSecret: false,
      description: null,
      egressProxyRule: null,
      source: { type: "global", description: "Iterate-provided Resend from address" },
      createdAt: null,
    },
    {
      key: "ITERATE_CUSTOMER_REPO_PATH",
      value: repos.length > 0 ? repos[0].path : "/home/iterate/src/placeholder-repo",
      isSecret: false,
      description: null,
      egressProxyRule: null,
      source: { type: "global", description: "Customer repo path" },
      createdAt: null,
    },
  ];

  logger.info("Returning env data for machine", {
    machineId,
    envVarCount: daemonEnvVars.length,
    repoCount: repos.length,
  });

  // Return the unified list - daemon will handle formatting for .env file
  return {
    envVars: daemonEnvVars.map((v) => ({
      key: v.key,
      value: v.value,
      description: v.description,
      source: v.source,
    })),
    repos,
  };
});

export const workerRouter = os.router({
  machines: {
    reportStatus,
    getEnv,
  },
});
