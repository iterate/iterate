/**
 * Machine setup service — resolves env vars and repos for a machine,
 * then pushes them to the daemon via tool.writeFile and tool.execCommand.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import type { AppRouter } from "../../../daemon/server/trpc/app-router.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import type { CloudflareEnv } from "../../env.ts";
import { getUnifiedEnvVars } from "../utils/env-vars.ts";
import { buildEnvFileContent } from "../utils/env-file-builder.ts";
import {
  getGitHubInstallationTokenWithDiagnostics,
  getRepositoryById,
} from "../integrations/github/github.ts";

type RepoInfo = {
  url: string;
  branch: string;
  path: string;
  owner: string;
  name: string;
};

function createDaemonClient(params: { baseUrl: string; fetcher?: SandboxFetcher }) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${params.baseUrl}/api/trpc`,
        ...(params.fetcher ? { fetch: params.fetcher } : {}),
      }),
    ],
  });
}

async function buildDaemonTransport(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<{ baseUrl: string; fetcher: SandboxFetcher }> {
  const metadata = machine.metadata as Record<string, unknown>;
  const runtime = await createMachineStub({
    type: machine.type,
    env,
    externalId: machine.externalId,
    metadata,
  });
  const [baseUrl, fetcher] = await Promise.all([
    runtime.getBaseUrl(3000),
    runtime.getFetcher(3000),
  ]);
  return { baseUrl, fetcher };
}

/**
 * Resolve env vars and repo info for a machine's project.
 * Returns the .env file content string and a list of repos to clone.
 */
export async function resolveMachineSetupData(
  db: DB,
  env: CloudflareEnv,
  projectId: string,
  machineId: string,
): Promise<{ envFileContent: string; repos: RepoInfo[] }> {
  const dangerousRawSecrets = env.DANGEROUS_RAW_SECRETS_ENABLED === "true";

  // Get unified env vars
  const unifiedEnvVars = await getUnifiedEnvVars(db, projectId, {
    dangerousRawSecrets,
    encryptionSecret: dangerousRawSecrets ? env.ENCRYPTION_SECRET : undefined,
  });

  // Fetch project connections and repos
  const projectData = await db.query.project.findFirst({
    where: eq(schema.project.id, projectId),
    with: {
      connections: {
        where: (connection, { eq: whereEq }) => whereEq(connection.provider, "github-app"),
      },
      projectRepos: true,
    },
  });
  const githubConnection = projectData?.connections[0] ?? null;
  const projectRepos = projectData?.projectRepos ?? [];

  // Get GitHub installation token for repo access
  let installationToken: string | null = null;
  if (githubConnection) {
    const providerData = githubConnection.providerData as { installationId?: number };
    const installationId = providerData.installationId;
    if (installationId) {
      const tokenResult = await getGitHubInstallationTokenWithDiagnostics(env, installationId);
      installationToken = tokenResult.token;
      if (!tokenResult.token) {
        logger.warn("[machine-setup] Failed to get GitHub installation token", {
          machineId,
          projectId,
          installationId,
        });
      }
    }
  }

  // Resolve repo info
  const repoResults =
    installationToken && projectRepos.length > 0
      ? await Promise.all(
          projectRepos.map(async (repo): Promise<RepoInfo | null> => {
            const repoInfo = await getRepositoryById(installationToken!, repo.externalId);
            if (!repoInfo) {
              logger.warn("[machine-setup] Could not fetch repo info", {
                repoId: repo.externalId,
              });
              return null;
            }
            return {
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

  // Add daemon-specific env vars
  const daemonEnvVars = [
    ...unifiedEnvVars,
    {
      key: "ITERATE_RESEND_FROM_ADDRESS",
      value: `${env.VITE_APP_STAGE}@${env.RESEND_BOT_DOMAIN}`,
      secret: null,
      description: null,
      egressProxyRule: null,
      source: { type: "global" as const, description: "Iterate-provided Resend from address" },
      createdAt: null,
    },
    {
      key: "ITERATE_CUSTOMER_REPO_PATH",
      value: repos.length > 0 ? repos[0].path : "/home/iterate/src/github.com/iterate/iterate",
      secret: null,
      description: null,
      egressProxyRule: null,
      source: { type: "global" as const, description: "Customer repo path" },
      createdAt: null,
    },
  ];

  const envFileContent = buildEnvFileContent(daemonEnvVars, { skipProxy: dangerousRawSecrets });

  return { envFileContent, repos };
}

/**
 * Push setup data (env file + repo clones) to a machine's daemon.
 */
export async function pushSetupToMachine(
  db: DB,
  env: CloudflareEnv,
  machine: typeof schema.machine.$inferSelect,
): Promise<void> {
  const { envFileContent, repos } = await resolveMachineSetupData(
    db,
    env,
    machine.projectId,
    machine.id,
  );

  const transport = await buildDaemonTransport(machine, env);
  const client = createDaemonClient(transport);

  // Idempotency: hash the full setup intent (env content + repo list) and write a
  // sentinel file at the end. On retry, if the sentinel matches, skip everything.
  const setupFingerprint = hashSetupIntent(envFileContent, repos);
  const sentinelPath = "~/.iterate/.setup-done";
  const existingSentinel = await client.tool.readFile.query({ path: sentinelPath });
  if (existingSentinel.exists && existingSentinel.content?.trim() === setupFingerprint) {
    logger.info("[machine-setup] Setup already completed (sentinel matches), skipping", {
      machineId: machine.id,
    });
    return;
  }

  // Write env file first so pidnap picks up env vars immediately
  logger.info("[machine-setup] Writing .env to machine", {
    machineId: machine.id,
    contentLength: envFileContent.length,
  });
  await client.tool.writeFile.mutate({
    path: "~/.iterate/.env",
    content: envFileContent,
    mode: 0o600,
  });

  // Clone repos — skip already-cloned dirs so retries after partial failure work
  for (const repo of repos) {
    logger.info("[machine-setup] Cloning repo on machine", {
      machineId: machine.id,
      repo: `${repo.owner}/${repo.name}`,
      path: repo.path,
    });

    // mkdir -p for parent dir first
    const parentDir = repo.path.split("/").slice(0, -1).join("/");
    await client.tool.execCommand.mutate({
      command: ["mkdir", "-p", parentDir],
    });

    // Skip if already cloned (retry-safe)
    const dirCheck = await client.tool.execCommand
      .mutate({ command: ["test", "-d", `${repo.path}/.git`] })
      .then((r) => r.exitCode === 0)
      .catch(() => false);

    if (dirCheck) {
      logger.info("[machine-setup] Repo already cloned, skipping", {
        machineId: machine.id,
        repo: `${repo.owner}/${repo.name}`,
      });
      continue;
    }

    // Clone — try with branch first, fall back to default
    try {
      await client.tool.execCommand.mutate({
        command: ["git", "clone", "--branch", repo.branch, "--single-branch", repo.url, repo.path],
        timeout: 120_000,
      });
    } catch {
      // If branch clone failed (e.g., empty repo), try without --branch
      logger.info("[machine-setup] Branch clone failed, retrying without --branch", {
        machineId: machine.id,
        repo: `${repo.owner}/${repo.name}`,
      });
      await client.tool.execCommand.mutate({
        command: ["git", "clone", repo.url, repo.path],
        timeout: 120_000,
      });
    }
  }

  // Write sentinel file last — marks the full setup as complete.
  // If we crashed before here, the next retry re-writes .env and re-clones (skipping existing).
  await client.tool.writeFile.mutate({
    path: sentinelPath,
    content: setupFingerprint,
    mode: 0o600,
  });

  logger.info("[machine-setup] Setup push complete", {
    machineId: machine.id,
    envVarBytes: envFileContent.length,
    repoCount: repos.length,
  });
}

/**
 * Push updated env vars to all active machines for a project.
 * Called when env vars change (user edits, OAuth token refresh, etc.).
 */
export async function pushEnvToRunningMachines(
  db: DB,
  projectId: string,
  env: CloudflareEnv,
): Promise<void> {
  const runningMachines = await db.query.machine.findMany({
    where: (machine, { eq: whereEq, and: whereAnd }) =>
      whereAnd(whereEq(machine.projectId, projectId), whereEq(machine.state, "active")),
  });

  if (runningMachines.length === 0) {
    logger.info("[machine-setup] No running machines to push env to", { projectId });
    return;
  }

  logger.info("[machine-setup] Pushing env to running machines", {
    projectId,
    machineCount: runningMachines.length,
  });

  // Resolve env data once, push to all machines
  const { envFileContent } = await resolveMachineSetupData(db, env, projectId, "env-refresh");

  await Promise.all(
    runningMachines.map(async (machine) => {
      try {
        const transport = await buildDaemonTransport(machine, env);
        const client = createDaemonClient(transport);
        // Read first to skip no-op writes (avoids unnecessary pidnap restarts)
        const existing = await client.tool.readFile.query({ path: "~/.iterate/.env" });
        if (existing.exists && existing.content === envFileContent) {
          logger.info("[machine-setup] .env already up to date, skipping", {
            machineId: machine.id,
          });
          return;
        }
        await client.tool.writeFile.mutate({
          path: "~/.iterate/.env",
          content: envFileContent,
          mode: 0o600,
        });
        logger.info("[machine-setup] Pushed env to machine", { machineId: machine.id });
      } catch (err) {
        logger.error("[machine-setup] Failed to push env to machine", {
          machineId: machine.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}

/** Hash the full setup intent (env content + sorted repo paths) into a short fingerprint. */
function hashSetupIntent(envFileContent: string, repos: RepoInfo[]): string {
  const repoPaths = repos.map((r) => r.path).sort();
  return createHash("sha256")
    .update(envFileContent)
    .update(repoPaths.join("\n"))
    .digest("hex")
    .slice(0, 16);
}
