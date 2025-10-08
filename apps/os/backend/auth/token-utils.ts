import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { createAuthorizationURL } from "better-auth/oauth2";
import { generateRandomString } from "better-auth/crypto";
import { env } from "../../env.ts";
import * as schema from "../db/schema.ts";
import type { DB } from "../db/client.ts";
import type { AgentDurableObjectInfo, GoogleOAuthState } from "./oauth-state-schemas.ts";
import { GOOGLE_INTEGRATION_SCOPES } from "./integrations.ts";

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

export const GoogleTokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export const getGoogleAccessTokenForUser = async (db: DB, userId: string) => {
  const [result] = await db
    .select({
      id: schema.account.id,
      accessToken: schema.account.accessToken,
      refreshToken: schema.account.refreshToken,
      accessTokenExpiresAt: schema.account.accessTokenExpiresAt,
    })
    .from(schema.account)
    .where(and(eq(schema.account.providerId, "google"), eq(schema.account.userId, userId)))
    .limit(1);

  if (!result) {
    throw new Error(`Google access token not found for user ${userId}`);
  }

  if (result.accessTokenExpiresAt && result.accessTokenExpiresAt < new Date()) {
    if (!result.refreshToken) {
      throw new Error(`Google refresh token not found for user ${userId}`);
    }

    const refreshResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: result.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!refreshResponse.ok) {
      throw new Error(`Failed to refresh Google access token: ${refreshResponse.statusText}`);
    }

    const newTokenData = GoogleTokenResponse.parse(await refreshResponse.json());

    await db
      .update(schema.account)
      .set({
        accessToken: newTokenData.access_token,
        accessTokenExpiresAt: new Date(Date.now() + newTokenData.expires_in * 1000),
      })
      .where(eq(schema.account.id, result.id));

    return newTokenData.access_token;
  }

  if (!result.accessToken) {
    throw new Error(`Google access token not found for user ${userId}`);
  }

  return result.accessToken;
};

export const getGoogleOAuthURL = async ({
  db,
  estateId,
  userId,
  agentDurableObject,
  callbackUrl,
}: {
  db: DB;
  estateId: string;
  userId: string;
  agentDurableObject: AgentDurableObjectInfo;
  callbackUrl?: string;
}) => {
  const state = generateRandomString(32);
  const redirectURI = `${env.VITE_PUBLIC_URL}/api/auth/integrations/callback/google`;
  const fullUrl = await createAuthorizationURL({
    id: "google",
    options: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectURI,
    },
    redirectURI,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    scopes: GOOGLE_INTEGRATION_SCOPES,
    state,
    additionalParams: {
      access_type: "offline",
      prompt: "consent",
    },
  });

  const googleOAuthState: GoogleOAuthState = {
    link: {
      userId,
    },
    callbackUrl,
    fullUrl: fullUrl.toString(),
    agentDurableObject,
  };
  await db.insert(schema.verification).values({
    identifier: state,
    value: JSON.stringify(googleOAuthState),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes for OAuth flow
  });

  const organization = await db.query.estate.findFirst({
    where: eq(schema.estate.id, estateId),
    columns: {
      organizationId: true,
    },
  });

  if (!organization) {
    throw new Error("Organization not found");
  }

  return `${env.VITE_PUBLIC_URL}/${organization.organizationId}/${estateId}/integrations/redirect?key=${state}`;
};
