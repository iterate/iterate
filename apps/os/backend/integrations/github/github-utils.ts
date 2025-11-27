import { createPrivateKey } from "crypto";
import { eq, and } from "drizzle-orm";
import { App, Octokit } from "octokit";
import { getContainer } from "@cloudflare/containers";
import { env } from "../../../env.ts";
import type { DB } from "../../db/client.ts";
import * as schemas from "../../db/schema.ts";
import type { CloudflareEnv } from "../../../env.ts";
import { invalidateOrganizationQueries } from "../../utils/websocket-utils.ts";

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
      accountId: schemas.account.accountId,
      accessToken: schemas.account.accessToken,
      refreshToken: schemas.account.refreshToken,
      accessTokenExpiresAt: schemas.account.accessTokenExpiresAt,
    })
    .from(schemas.estateAccountsPermissions)
    .innerJoin(schemas.account, eq(schemas.estateAccountsPermissions.accountId, schemas.account.id))
    .where(
      and(
        eq(schemas.estateAccountsPermissions.estateId, estateId),
        eq(schemas.account.providerId, "github-app"),
      ),
    )
    .limit(1);

  return installations.length > 0 ? installations[0] : null;
};

export const getGithubRepoForEstate = async (db: DB, estateId: string) => {
  const [estate] = await db
    .select({
      connectedRepoId: schemas.estate.connectedRepoId,
      connectedRepoRef: schemas.estate.connectedRepoRef,
      connectedRepoPath: schemas.estate.connectedRepoPath,
    })
    .from(schemas.estate)
    .where(eq(schemas.estate.id, estateId));

  if (!estate || !estate.connectedRepoId) {
    return null;
  }

  return estate;
};

export const getEstateByRepoId = async (db: DB, repoId: number) => {
  const [estate] = await db
    .select({
      id: schemas.estate.id,
      name: schemas.estate.name,
      connectedRepoRef: schemas.estate.connectedRepoRef,
      connectedRepoPath: schemas.estate.connectedRepoPath,
    })
    .from(schemas.estate)
    .where(eq(schemas.estate.connectedRepoId, repoId));

  return estate;
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

  // Create a new build record
  const [build] = await db
    .insert(schemas.builds)
    .values({
      status: "in_progress",
      commitHash,
      commitMessage: isManual ? `[Manual] ${commitMessage}` : commitMessage,
      webhookIterateId: webhookId || `${isManual ? "manual" : "auto"}-${Date.now()}`,
      estateId,
      iterateWorkflowRunId: workflowRunId,
    })
    .returning();

  // Get the organization ID for WebSocket invalidation
  const estateWithOrg = await db.query.estate.findFirst({
    where: eq(schemas.estate.id, estateId),
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

  const container = getContainer(env.ESTATE_BUILD_MANAGER, estateId);
  using _res = await container.build({
    buildId: build.id,
    repo: repoUrl,
    branch: branch || "main",
    path: connectedRepoPath || "/",
    authToken: installationToken,
  });

  return build;
}
