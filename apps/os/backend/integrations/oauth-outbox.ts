import { eq } from "drizzle-orm";
import { env } from "../../env.ts";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import type { SecretMetadata } from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { encrypt } from "../utils/encryption.ts";
import { pokeRunningMachinesToRefresh } from "../utils/poke-machines.ts";
import { getGitHubInstallationToken } from "./github/github.ts";

export type SlackConnectionCreatedPayload = {
  projectId: string;
  teamId: string;
  teamName: string;
  teamDomain: string;
  encryptedAccessToken: string;
};

export type GitHubConnectionCreatedPayload = {
  projectId: string;
  installationId: number;
  encryptedAccessToken: string;
};

export type GoogleConnectionCreatedPayload = {
  projectId: string;
  userId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  expiresAt?: string;
  scopes: string[];
};

export async function handleSlackConnectionCreated(
  payload: SlackConnectionCreatedPayload,
): Promise<void> {
  const db = getDb();
  const project = await db.query.project.findFirst({
    where: eq(schema.project.id, payload.projectId),
  });

  if (!project) {
    logger.warn("[OAuth] Slack project not found", {
      projectId: payload.projectId,
      teamId: payload.teamId,
    });
    return;
  }

  const existingSecret = await db.query.secret.findFirst({
    where: (s, { and: whereAnd, eq: whereEq, isNull: whereIsNull }) =>
      whereAnd(
        whereEq(s.key, "slack.access_token"),
        whereEq(s.projectId, payload.projectId),
        whereIsNull(s.userId),
      ),
  });

  const slackEgressRule = `$contains(url.hostname, 'slack.com')`;

  if (existingSecret) {
    await db
      .update(schema.secret)
      .set({
        encryptedValue: payload.encryptedAccessToken,
        lastSuccessAt: new Date(),
        egressProxyRule: slackEgressRule,
      })
      .where(eq(schema.secret.id, existingSecret.id));
  } else {
    await db.insert(schema.secret).values({
      key: "slack.access_token",
      encryptedValue: payload.encryptedAccessToken,
      organizationId: project.organizationId,
      projectId: payload.projectId,
      egressProxyRule: slackEgressRule,
    });
  }

  await pokeRunningMachinesToRefresh(db, payload.projectId, env);
}

export async function handleGitHubConnectionCreated(
  payload: GitHubConnectionCreatedPayload,
): Promise<void> {
  const db = getDb();
  const project = await db.query.project.findFirst({
    where: eq(schema.project.id, payload.projectId),
  });

  if (!project) {
    logger.warn("[OAuth] GitHub project not found", {
      projectId: payload.projectId,
      installationId: payload.installationId,
    });
    return;
  }

  const installationToken = await getGitHubInstallationToken(env, payload.installationId);
  const encryptedToken = installationToken
    ? await encrypt(installationToken)
    : payload.encryptedAccessToken;
  const secretMetadata = installationToken ? { githubInstallationId: payload.installationId } : {};

  const existingSecret = await db.query.secret.findFirst({
    where: (s, { and: whereAnd, eq: whereEq, isNull: whereIsNull }) =>
      whereAnd(
        whereEq(s.key, "github.access_token"),
        whereEq(s.projectId, payload.projectId),
        whereIsNull(s.userId),
      ),
  });

  const githubEgressRule = `$contains(url.hostname, 'github.com') or $contains(url.hostname, 'githubcopilot.com')`;

  if (existingSecret) {
    await db
      .update(schema.secret)
      .set({
        encryptedValue: encryptedToken,
        lastSuccessAt: new Date(),
        metadata: secretMetadata,
        egressProxyRule: githubEgressRule,
      })
      .where(eq(schema.secret.id, existingSecret.id));
  } else {
    await db.insert(schema.secret).values({
      key: "github.access_token",
      encryptedValue: encryptedToken,
      organizationId: project.organizationId,
      projectId: payload.projectId,
      metadata: secretMetadata,
      egressProxyRule: githubEgressRule,
    });
  }

  await pokeRunningMachinesToRefresh(db, payload.projectId, env);
}

export async function handleGoogleConnectionCreated(
  payload: GoogleConnectionCreatedPayload,
): Promise<void> {
  const db = getDb();
  const project = await db.query.project.findFirst({
    where: eq(schema.project.id, payload.projectId),
  });

  if (!project) {
    logger.warn("[OAuth] Google project not found", {
      projectId: payload.projectId,
      userId: payload.userId,
    });
    return;
  }

  const existingSecret = await db.query.secret.findFirst({
    where: (s, { and: whereAnd, eq: whereEq }) =>
      whereAnd(
        whereEq(s.key, "google.access_token"),
        whereEq(s.projectId, payload.projectId),
        whereEq(s.userId, payload.userId),
      ),
  });

  const googleEgressRule = `$contains(url.hostname, 'googleapis.com')`;
  const secretMetadata: SecretMetadata = {
    encryptedRefreshToken: payload.encryptedRefreshToken,
    expiresAt: payload.expiresAt,
    scopes: payload.scopes,
  };

  if (existingSecret) {
    await db
      .update(schema.secret)
      .set({
        encryptedValue: payload.encryptedAccessToken,
        metadata: secretMetadata,
        lastSuccessAt: new Date(),
        egressProxyRule: googleEgressRule,
      })
      .where(eq(schema.secret.id, existingSecret.id));
  } else {
    await db.insert(schema.secret).values({
      key: "google.access_token",
      encryptedValue: payload.encryptedAccessToken,
      organizationId: project.organizationId,
      projectId: payload.projectId,
      userId: payload.userId,
      metadata: secretMetadata,
      egressProxyRule: googleEgressRule,
    });
  }

  await pokeRunningMachinesToRefresh(db, payload.projectId, env);
}
