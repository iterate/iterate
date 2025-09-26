import { eq, and } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env } from "../../env.ts";

export const getSlackAccessTokenForEstate = async (db: DB, estateId: string) => {
  const result = await db
    .select({
      accessToken: schema.account.accessToken,
    })
    .from(schema.estateAccountsPermissions)
    .innerJoin(schema.account, eq(schema.estateAccountsPermissions.accountId, schema.account.id))
    .where(
      and(
        eq(schema.estateAccountsPermissions.estateId, estateId),
        eq(schema.account.providerId, "slack-bot"),
      ),
    )
    .limit(1);

  return result[0]?.accessToken || null;
};

export const GithubUserAccessTokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  refresh_token_expires_in: z.number(),
});

export const getGithubUserAccessTokenForEstate = async (db: DB, estateId: string) => {
  const [result] = await db
    .select({
      id: schema.account.id,
      installationId: schema.account.accountId,
      accessToken: schema.account.accessToken,
      refreshToken: schema.account.refreshToken,
      accessTokenExpiresAt: schema.account.accessTokenExpiresAt,
      refreshTokenExpiresAt: schema.account.refreshTokenExpiresAt,
    })
    .from(schema.estateAccountsPermissions)
    .innerJoin(schema.account, eq(schema.estateAccountsPermissions.accountId, schema.account.id))
    .where(eq(schema.estateAccountsPermissions.estateId, estateId))
    .limit(1);

  if (!result) {
    throw new Error(`GitHub user access token not found for estate ${estateId}`);
  }

  if (result.accessTokenExpiresAt && result.accessTokenExpiresAt < new Date()) {
    if (!result.refreshToken) {
      throw new Error(`GitHub user refresh token not found for estate ${estateId}`);
    }

    const newAccessToken = await fetch(`https://github.com/login/oauth/access_token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET,
        refresh_token: result.refreshToken,
        grant_type: "refresh_token",
      }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "Iterate OS",
      },
    });

    if (!newAccessToken.ok) {
      throw new Error(`Failed to refresh GitHub user access token: ${newAccessToken.statusText}`);
    }

    const newAccessTokenData = GithubUserAccessTokenResponse.parse(await newAccessToken.json());

    await db
      .update(schema.account)
      .set({
        accessToken: newAccessTokenData.access_token,
        refreshToken: newAccessTokenData.refresh_token,
        accessTokenExpiresAt: new Date(Date.now() + newAccessTokenData.expires_in * 1000),
        refreshTokenExpiresAt: new Date(
          Date.now() + newAccessTokenData.refresh_token_expires_in * 1000,
        ),
      })
      .where(eq(schema.account.id, result.id));

    return {
      accessToken: newAccessTokenData.access_token,
      installationId: result.installationId,
    };
  }

  if (!result.accessToken) {
    throw new Error(`GitHub user access token not found for estate ${estateId}`);
  }

  return {
    accessToken: result.accessToken,
    installationId: result.installationId,
  };
};
