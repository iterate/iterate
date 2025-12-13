import { createPrivateKey } from "crypto";
import { eq, and, desc } from "drizzle-orm";
import { SignJWT } from "jose";
import { db, schema } from "./cli-db.ts";

// Same as the backend/integrations/github/github-utils.ts file
async function generateGithubJWT() {
  const alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  if (!process.env.GITHUB_APP_PRIVATE_KEY || !process.env.GITHUB_APP_CLIENT_ID) {
    throw new Error("GITHUB_APP_PRIVATE_KEY or GITHUB_APP_CLIENT_ID is not set");
  }

  const key = createPrivateKey({
    key: process.env.GITHUB_APP_PRIVATE_KEY,
    format: "pem",
  });

  return await new SignJWT({})
    .setProtectedHeader({ alg, typ: "JWT" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(process.env.GITHUB_APP_CLIENT_ID)
    .sign(key);
}

export async function getRepoAccessToken(estateId: string) {
  const [result] = await db
    .select({
      estateId: schema.estate.id,
      accountId: schema.account.accountId,
    })
    .from(schema.estate)
    .innerJoin(
      schema.estateAccountsPermissions,
      eq(schema.estate.id, schema.estateAccountsPermissions.estateId),
    )
    .innerJoin(schema.account, eq(schema.estateAccountsPermissions.accountId, schema.account.id))
    .where(and(eq(schema.estate.id, estateId), eq(schema.account.providerId, "github-app")))
    .orderBy(desc(schema.account.createdAt))
    .limit(1);

  if (!result) {
    throw new Error(`GitHub account not found for estate ${estateId}`);
  }

  const installationId = result.accountId;
  const githubJWT = await generateGithubJWT();

  const tokenRes = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubJWT}`,
        "User-Agent": "Iterate OS",
      },
    },
  );

  if (!tokenRes.ok) {
    throw new Error(`Failed to fetch installation token: ${tokenRes.statusText}`);
  }
  const { token } = (await tokenRes.json()) as { token: string };
  const source = await db.query.iterateConfigSource.findFirst({
    where: eq(schema.iterateConfigSource.estateId, estateId),
    orderBy: desc(schema.iterateConfigSource.createdAt),
  });
  return { token, repoId: source?.repoId, repoRef: source?.branch, repoPath: source?.path };
}
