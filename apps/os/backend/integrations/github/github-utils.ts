import { createPrivateKey, createHmac } from "crypto";
import { SignJWT } from "jose";
import { eq, and } from "drizzle-orm";
import { env } from "../../../env.ts";
import type { DB } from "../../db/client.ts";
import * as schemas from "../../db/schema.ts";

export const generateGithubJWT = async () => {
  const alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  const key = createPrivateKey({
    key: env.GITHUB_APP_PRIVATE_KEY,
    format: "pem",
  });

  return await new SignJWT({})
    .setProtectedHeader({ alg, typ: "JWT" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(env.GITHUB_APP_CLIENT_ID)
    .sign(key);
};

export const getGithubInstallationForEstate = async (db: DB, estateId: string) => {
  const [githubInstallation] = await db
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

  return githubInstallation;
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

export const validateGithubWebhookSignature = (
  payload: string,
  signature: string | null,
  secret: string,
): boolean => {
  if (!signature) return false;

  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  const expectedSignature = `sha256=${hmac.digest("hex")}`;

  // Timing-safe comparison
  return signature === expectedSignature;
};

export const getGithubInstallationToken = async (installationId: string) => {
  const jwt = await generateGithubJWT();

  const tokenRes = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "Iterate OS",
      },
    },
  );

  if (!tokenRes.ok) {
    throw new Error(`Failed to fetch installation token: ${tokenRes.statusText}`);
  }

  const { token } = (await tokenRes.json()) as { token: string };
  return token;
};
