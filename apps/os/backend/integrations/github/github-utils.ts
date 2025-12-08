import { createPrivateKey } from "crypto";
import { eq, and, isNull } from "drizzle-orm";
import { App, Octokit } from "octokit";
import { getContainer } from "@cloudflare/containers";
import { typeid } from "typeid-js";
import { env } from "../../../env.ts";
import type { DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import type { CloudflareEnv } from "../../../env.ts";
import { invalidateOrganizationQueries } from "../../utils/websocket-utils.ts";
import { recentActiveSources } from "../../db/helpers.ts";

const privateKey = createPrivateKey({
  key: env.GITHUB_APP_PRIVATE_KEY,
  format: "pem",
}).export({
  type: "pkcs8",
  format: "pem",
}) as string;

export type GithubAppInstance = App & { octokit: Octokit };
export const githubAppInstance = (): GithubAppInstance =>
  new App({
    appId: env.GITHUB_APP_ID,
    privateKey,
    oauth: {
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      allowSignup: true,
    },
    webhooks: {
      secret: env.GITHUB_WEBHOOK_SECRET,
    },
    Octokit: Octokit.defaults({ userAgent: "Iterate OS" }),
  });

export const getGithubInstallationForEstate = async (db: DB, estateId: string) => {
  const installations = await db
    .select({
      accountId: schema.account.accountId,
      accessToken: schema.account.accessToken,
      refreshToken: schema.account.refreshToken,
      accessTokenExpiresAt: schema.account.accessTokenExpiresAt,
    })
    .from(schema.estateAccountsPermissions)
    .innerJoin(schema.account, eq(schema.estateAccountsPermissions.accountId, schema.account.id))
    .where(
      and(
        eq(schema.estateAccountsPermissions.estateId, estateId),
        eq(schema.account.providerId, "github-app"),
      ),
    )
    .limit(2);

  return installations.at(0);
};

export const getGithubRepoForEstate = async (db: DB, estateId: string) => {
  const e = await db.query.estate.findFirst({
    where: eq(schema.estate.id, estateId),
    with: recentActiveSources,
  });
  const s = e?.sources?.[0];
  const estate = {
    connectedRepoId: s?.repoId,
    connectedRepoRef: s?.branch,
    connectedRepoPath: s?.path,
    connectedRepoAccountId: s?.accountId,
  };

  if (!estate || !estate.connectedRepoId) {
    return null;
  }

  return estate;
};

export const getEstateByRepoId = async (db: DB, repoId: number) => {
  const configSource = await db.query.iterateConfigSource.findFirst({
    where: and(
      eq(schema.iterateConfigSource.repoId, repoId),
      isNull(schema.iterateConfigSource.deactivatedAt),
    ),
    with: {
      estate: true,
    },
  });
  return (
    configSource?.estate && {
      id: configSource.estate.id,
      name: configSource.estate.name,
      connectedRepoRef: configSource.branch,
      connectedRepoPath: configSource.path,
      connectedRepoAccountId: configSource.accountId,
    }
  );
};

export const validateGithubWebhookSignature = async (payload: string, signature: string) =>
  await githubAppInstance()
    .webhooks.verify(payload, signature)
    .catch(() => false);

export const getOctokitForInstallation = async (installationId: string): Promise<Octokit> =>
  await githubAppInstance().getInstallationOctokit(parseInt(installationId));

// Helper function to trigger a GitHub estate build
export async function triggerGithubBuild(params: {
  db: DB;
  env: CloudflareEnv;
  estateId: string;
  commitHash: string;
  commitMessage: string;
  repoUrl: string;
  installationToken: string;
  connectedRepoPath?: string;
  branch?: string;
  webhookId?: string;
  workflowRunId?: string;
  isManual?: boolean;
}) {
  const {
    db,
    env,
    estateId,
    commitHash,
    commitMessage,
    repoUrl,
    installationToken,
    connectedRepoPath,
    branch,
    webhookId,
    workflowRunId,
    isManual = false,
  } = params;

  const buildId = typeid("build").toString();

  const container = getContainer(env.ESTATE_BUILD_MANAGER, estateId);

  // Trigger the build first, so that we don't add a in_progress build record to the database if the build fails to start
  using _build = await container.build({
    buildId,
    repo: repoUrl,
    branch: branch || "main",
    path: connectedRepoPath || "/",
    authToken: installationToken,
  });

  // Create a new build record
  const [build] = await db
    .insert(schema.builds)
    .values({
      id: buildId,
      status: "in_progress",
      commitHash,
      commitMessage: isManual ? `[Manual] ${commitMessage}` : commitMessage,
      webhookIterateId: webhookId || `${isManual ? "manual" : "auto"}-${Date.now()}`,
      files: [],
      estateId,
      iterateWorkflowRunId: workflowRunId,
    })
    .returning();

  // Get the organization ID for WebSocket invalidation
  const estateWithOrg = await db.query.estate.findFirst({
    where: eq(schema.estate.id, estateId),
    with: {
      organization: true,
    },
  });

  // Invalidate organization queries to show the new in-progress build
  if (estateWithOrg?.organization) {
    await invalidateOrganizationQueries(env, estateWithOrg.organization.id, {
      type: "INVALIDATE",
      invalidateInfo: {
        type: "TRPC_QUERY",
        paths: ["estate.getBuilds"],
      },
    });
  }

  return build;
}
