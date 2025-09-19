import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { CloudflareEnv } from "../../../env";
import type { Variables } from "../../worker";
import * as schema from "../../db/schema.ts";

export const UserAccessTokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  refresh_token_expires_in: z.number(),
});

export const InstallationInfoResponse = z.looseObject({
  installations: z.array(
    z.looseObject({
      id: z.number(),
      permissions: z.record(z.string(), z.string()),
    }),
  ),
});

export const githubApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();
githubApp.get(
  "/callback",
  zValidator(
    "query",
    z.object({
      state: z.string(),
      code: z.string(),
      installation_id: z.string().transform((val) => parseInt(val)),
    }),
  ),
  async (c) => {
    if (!c.var.session) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const { state, code, installation_id } = c.req.valid("query");
    const verification = await c.var.db.query.verification.findFirst({
      where: eq(schema.verification.identifier, state),
    });
    await c.var.db.delete(schema.verification).where(eq(schema.verification.identifier, state));

    if (!verification || verification.expiresAt < new Date()) {
      return c.json({ error: "Invalid state or state has expired" }, 400);
    }
    const parsedState = z
      .object({
        estateId: z.string(),
        redirectUri: z.string(),
        userId: z.string(),
      })
      .parse(JSON.parse(verification.value));

    const { estateId, redirectUri, userId } = parsedState;

    const userAccessTokenRes = await fetch(`https://github.com/login/oauth/access_token`, {
      method: "POST",
      body: new URLSearchParams({
        code,
        client_id: c.env.GITHUB_APP_CLIENT_ID,
        client_secret: c.env.GITHUB_APP_CLIENT_SECRET,
        redirect_uri: redirectUri,
      }),
      headers: {
        Accept: "application/json",
        "User-Agent": "Iterate OS",
      },
    });
    if (!userAccessTokenRes.ok) {
      return c.json({ error: "Failed to get user access token" }, 400);
    }
    const userAccessTokenData = UserAccessTokenResponse.parse(await userAccessTokenRes.json());

    const installationInfoRes = await fetch(`https://api.github.com/user/installations`, {
      headers: {
        Authorization: `Bearer ${userAccessTokenData.access_token}`,
        "User-Agent": "Iterate OS",
      },
    });

    if (!installationInfoRes.ok) {
      console.log(await installationInfoRes.text());
      return c.json({ error: "Failed to get installation info" }, 400);
    }

    const installationInfoData = InstallationInfoResponse.parse(await installationInfoRes.json());

    const installation = installationInfoData.installations.find(
      (installation) => installation.id === installation_id,
    );

    if (!installation) {
      return c.json({ error: "Installation not found" }, 400);
    }
    const scope = Object.entries(installation.permissions)
      .map(([key, value]) => `${key}:${value}`)
      .join(",");

    const [account] = await c.var.db
      .insert(schema.account)
      .values({
        providerId: "github-app",
        accountId: installation_id.toString(),
        userId,
        accessToken: userAccessTokenData.access_token,
        refreshToken: userAccessTokenData.refresh_token,
        accessTokenExpiresAt: new Date(Date.now() + userAccessTokenData.expires_in * 1000),
        refreshTokenExpiresAt: new Date(
          Date.now() + userAccessTokenData.refresh_token_expires_in * 1000,
        ),
        scope,
      })
      .returning();

    await c.var.db.insert(schema.estateAccountsPermissions).values({
      accountId: account.id,
      estateId,
    });

    return c.redirect("/");
  },
);
