import { createPrivateKey } from "crypto";
import { eq, and, isNull } from "drizzle-orm";
import { App, Octokit } from "octokit";
import { env } from "../../../env.ts";
import { getDb, type DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { recentActiveSources } from "../../db/helpers.ts";
import type { EstateBuilderWorkflowInput } from "../../outbox/client.ts";
import { outboxClient } from "../../outbox/client.ts";

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
export async function triggerGithubBuild(payload: EstateBuilderWorkflowInput) {
  const db = getDb();
  return await db.transaction(async (tx) => {
    const [build] = await tx
      .insert(schema.builds)
      .values({
        status: "in_progress",
        commitHash: payload.commitHash,
        commitMessage: payload.isManual
          ? `[Manual] ${payload.commitMessage}`
          : payload.commitMessage,
        webhookIterateId:
          payload.webhookId || `${payload.isManual ? "manual" : "auto"}-${Date.now()}`,
        files: [],
        estateId: payload.estateId,
        iterateWorkflowRunId: payload.workflowRunId,
      })
      .returning();

    // eslint-disable-next-line iterate/drizzle-conventions -- i need it
    await outboxClient.sendEvent({ parent: db, transaction: tx }, "estate:build:created", {
      buildId: build.id,
      ...payload,
    });

    return { id: build.id };
  });
}
