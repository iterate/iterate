import { createPrivateKey } from "crypto";
import { eq, and, isNull } from "drizzle-orm";
import { App, Octokit } from "octokit";
import { env } from "../../../env.ts";
import { getDb, type DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { recentActiveSources } from "../../db/helpers.ts";
import type { InstallationBuilderWorkflowInput } from "../../outbox/client.ts";
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

export const getGithubInstallationForInstallation = async (db: DB, installationId: string) => {
  const installations = await db
    .select({
      accountId: schema.account.accountId,
      accessToken: schema.account.accessToken,
      refreshToken: schema.account.refreshToken,
      accessTokenExpiresAt: schema.account.accessTokenExpiresAt,
    })
    .from(schema.installationAccountsPermissions)
    .innerJoin(
      schema.account,
      eq(schema.installationAccountsPermissions.accountId, schema.account.id),
    )
    .where(
      and(
        eq(schema.installationAccountsPermissions.installationId, installationId),
        eq(schema.account.providerId, "github-app"),
      ),
    )
    .limit(2);

  return installations.at(0);
};

export const getGithubRepoForInstallation = async (db: DB, installationId: string) => {
  const e = await db.query.installation.findFirst({
    where: eq(schema.installation.id, installationId),
    with: recentActiveSources,
  });
  const s = e?.sources?.[0];
  const installation = {
    connectedRepoId: s?.repoId,
    connectedRepoRef: s?.branch,
    connectedRepoPath: s?.path,
    connectedRepoAccountId: s?.accountId,
  };

  if (!installation || !installation.connectedRepoId) {
    return null;
  }

  return installation;
};

export const getInstallationByRepoId = async (db: DB, repoId: number) => {
  const configSource = await db.query.iterateConfigSource.findFirst({
    where: and(
      eq(schema.iterateConfigSource.repoId, repoId),
      isNull(schema.iterateConfigSource.deactivatedAt),
    ),
    with: {
      installation: true,
    },
  });
  return (
    configSource?.installation && {
      id: configSource.installation.id,
      name: configSource.installation.name,
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

// Helper function to trigger a GitHub installation build
export async function triggerGithubBuild(payload: InstallationBuilderWorkflowInput) {
  const db = getDb();

  const res = await outboxClient.sendTx(db, "installation:build:created", async (tx) => {
    const [build] = await tx
      .insert(schema.builds)
      .values({
        status: "queued",
        commitHash: payload.commitHash,
        commitMessage: payload.isManual
          ? `[Manual] ${payload.commitMessage}`
          : payload.commitMessage,
        webhookIterateId:
          payload.webhookId || `${payload.isManual ? "manual" : "auto"}-${Date.now()}`,
        files: [],
        installationId: payload.installationId,
        iterateWorkflowRunId: payload.workflowRunId,
      })
      .returning();

    return { payload: { buildId: build.id, ...payload } };
  });

  // stupid circular type problem
  const id: string = res.payload.buildId;
  return { id };
}
