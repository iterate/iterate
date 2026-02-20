import { implement, ORPCError } from "@orpc/server";
import type { RequestHeadersPluginContext } from "@orpc/server/plugins";
import { eq, and, or } from "drizzle-orm";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

import { workerContract } from "../../../daemon/server/orpc/contract.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { parseTokenIdFromApiKey } from "../egress-proxy/api-key-utils.ts";
import {
  getGitHubInstallationTokenWithDiagnostics,
  getRepositoryById,
} from "../integrations/github/github.ts";
import { CONNECTORS } from "../services/connectors.ts";
import { attemptSecretRefresh, type RefreshContext } from "../services/oauth-refresh.ts";
import { broadcastInvalidation } from "../utils/query-invalidation.ts";
import { decrypt } from "../utils/encryption.ts";
import { getUnifiedEnvVars } from "../utils/env-vars.ts";
import type { AppRouter } from "../../../daemon/server/trpc/app-router.ts";
import type { CloudflareEnv } from "../../env.ts";
import { outboxClient } from "../outbox/client.ts";

/** Initial context provided by the handler */
export type ORPCContext = RequestHeadersPluginContext & {
  db: DB;
  env: CloudflareEnv;
  executionCtx: ExecutionContext;
};

export function createDaemonTrpcClient(baseUrl: string) {
  return createTRPCClient<AppRouter>({
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

    // Always emit the fact that the daemon reported status.
    // Consumers decide whether to act (e.g. start the probe pipeline).
    await outboxClient.send({ transaction: db, parent: db }, "machine:daemon-status-reported", {
      machineId: machine.id,
      projectId: machineWithOrg.projectId,
      status,
      message: message ?? "",
      externalId: machineWithOrg.externalId,
    });

    logger.info("Machine daemon status reported", { machineId: machine.id, status });

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

  // Check if dangerous raw secrets mode is enabled
  // BoolyString schema only allows "true" or "false" strings
  const dangerousRawSecrets = env.DANGEROUS_RAW_SECRETS_ENABLED === "true";
  if (dangerousRawSecrets) {
    logger.warn("DANGEROUS: Raw secrets mode enabled - bypassing egress proxy", { machineId });
  }

  // Get unified env vars using shared function
  const unifiedEnvVars = await getUnifiedEnvVars(db, project.id, {
    dangerousRawSecrets,
    encryptionSecret: dangerousRawSecrets ? env.ENCRYPTION_SECRET : undefined,
  });
  const projectData = await db.query.project.findFirst({
    where: eq(schema.project.id, project.id),
    with: {
      connections: {
        where: (connection, { eq: whereEq }) => whereEq(connection.provider, "github-app"),
      },
      projectRepos: true,
    },
  });
  const githubConnection = projectData?.connections[0] ?? null;
  const projectRepos = projectData?.projectRepos ?? [];

  // In raw secrets mode, refresh all connector tokens (GitHub, Google) up front.
  // The returned map contains fresh values keyed by "secretKey:userId".
  // Without the egress proxy there's no 401→refresh flow, so tokens go stale.
  let installationToken: string | null = null;
  if (dangerousRawSecrets) {
    const freshTokens = await refreshStaleConnectorTokens(db, env, project.id, unifiedEnvVars);
    // Project-scoped GitHub token (null userId → empty string in map key)
    installationToken = freshTokens.get("github.access_token:") ?? null;
  }

  // Fall back to requesting a fresh installation token directly
  if (!installationToken && githubConnection) {
    const providerData = githubConnection.providerData as { installationId?: number };
    const installationId = providerData.installationId;
    if (installationId) {
      const tokenDiagnostics = await getGitHubInstallationTokenWithDiagnostics(env, installationId);
      installationToken = tokenDiagnostics.token;

      if (tokenDiagnostics) {
        const totalMs = tokenDiagnostics.diagnostics.totalMs;
        const details = {
          machineId,
          projectId: project.id,
          installationId,
          githubRequestUrl: tokenDiagnostics.request.url,
          githubRequestMethod: tokenDiagnostics.request.method,
          tokenStatus: tokenDiagnostics.status,
          tokenError: tokenDiagnostics.error,
          ...tokenDiagnostics.diagnostics,
          ...tokenDiagnostics.responseHeaders,
        };

        if (!tokenDiagnostics.token) {
          logger.warn("getGitHubInstallationToken failed in getEnv", details);
        } else if (totalMs >= 5_000) {
          logger.warn("getGitHubInstallationToken slow in getEnv", details);
        }
      }
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
            const repoInfo = await getRepositoryById(installationToken!, repo.externalId);
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
      secret: null,
      description: null,
      egressProxyRule: null,
      source: { type: "global", description: "Iterate-provided Resend from address" },
      createdAt: null,
    },
    {
      key: "ITERATE_CUSTOMER_REPO_PATH",
      value: repos.length > 0 ? repos[0].path : "/home/iterate/src/github.com/iterate/iterate",
      secret: null,
      description: null,
      egressProxyRule: null,
      source: { type: "global", description: "Customer repo path" },
      createdAt: null,
    },
  ];

  logger.info("Returning env data for machine", {
    machineId,
    projectId: project.id,
    envVarCount: daemonEnvVars.length,
    repoCount: repos.length,
    skipProxy: dangerousRawSecrets,
  });

  // Return the unified list - daemon will handle formatting for .env file
  return {
    envVars: daemonEnvVars.map((v) => ({
      key: v.key,
      value: v.value,
      secret: v.secret,
      description: v.description,
      source: v.source,
    })),
    repos,
    // Skip proxy when raw secrets mode is enabled - secrets are returned directly
    skipProxy: dangerousRawSecrets,
  };
});

export const workerRouter = os.router({
  machines: {
    reportStatus,
    getEnv,
  },
});

// --- Utility functions ---

type UnifiedEnvVar = Awaited<ReturnType<typeof getUnifiedEnvVars>>[number];

/**
 * Proactively refresh all refreshable connector tokens in the env vars.
 * In raw secrets mode there's no egress proxy to do 401→refresh, so tokens
 * (e.g., GitHub installation tokens, Google OAuth) go stale.
 * Also persists the fresh token to the DB so future getEnv calls benefit.
 */
async function refreshStaleConnectorTokens(
  db: DB,
  env: CloudflareEnv,
  projectId: string,
  envVars: UnifiedEnvVar[],
): Promise<Map<string, string>> {
  // Refreshable connector secret keys from the registry
  const refreshableKeys = new Set(
    Object.values(CONNECTORS)
      .filter(
        (c) =>
          c.refreshable &&
          (c.secretKey === "github.access_token" || c.secretKey === "google.access_token"),
      )
      .map((c) => c.secretKey),
  );

  const emptyMap = new Map<string, string>();

  // Env vars that come from refreshable connectors
  const toRefresh = envVars.filter((v) => v.secret && refreshableKeys.has(v.secret.secretKey));
  if (toRefresh.length === 0) return emptyMap;

  // Unique secret keys to query (deduped)
  const secretKeysToQuery = [...new Set(toRefresh.map((v) => v.secret!.secretKey))];

  // Query ALL matching secrets for the project (both project-scoped and user-scoped).
  const secrets = await db.query.secret.findMany({
    where: and(
      eq(schema.secret.projectId, projectId),
      or(...secretKeysToQuery.map((k) => eq(schema.secret.key, k))),
    ),
    columns: { id: true, key: true, userId: true },
  });

  if (secrets.length === 0) return emptyMap;

  // Representative URLs for connector detection (attemptSecretRefresh uses getConnectorForUrl)
  const connectorURLs = new Map(
    Object.values(CONNECTORS).map((c) => [
      c.secretKey,
      `https://${c.urlPatterns[0].replace("*.", "x.").replace("/*", "/x")}`,
    ]),
  );

  const refreshContext: RefreshContext = {
    encryptionSecret: env.ENCRYPTION_SECRET,
    publicUrl: env.VITE_PUBLIC_URL,
    slackClientId: env.SLACK_CLIENT_ID,
    slackClientSecret: env.SLACK_CLIENT_SECRET,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    githubAppId: env.GITHUB_APP_ID,
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
  };

  // Refresh all in parallel
  const results = await Promise.allSettled(
    secrets.map(async (secret) => {
      const url = connectorURLs.get(secret.key);
      if (!url) return null;
      const result = await attemptSecretRefresh(db, secret.id, url, refreshContext);
      if (!result.ok) {
        logger.warn("Failed to refresh connector token for raw mode", {
          secretKey: secret.key,
          code: result.code,
        });
        return null;
      }
      return { key: secret.key, userId: secret.userId, value: result.newValue };
    }),
  );

  // Build lookup: "secretKey:userId" → fresh value
  const freshValues = new Map<string, string>();
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      freshValues.set(`${r.value.key}:${r.value.userId ?? ""}`, r.value.value);
    }
  }

  // Override stale values in place
  for (const envVar of toRefresh) {
    const fresh = freshValues.get(`${envVar.secret!.secretKey}:${envVar.secret!.userId ?? ""}`);
    if (fresh) envVar.value = fresh;
  }

  logger.info("Completed refreshStaleConnectorTokens", {
    projectId,
    refreshableEnvVarCount: toRefresh.length,
    queriedSecretCount: secrets.length,
    successfulRefreshCount: freshValues.size,
  });

  return freshValues;
}
