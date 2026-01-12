import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import * as arctic from "arctic";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../worker.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { encrypt } from "../../utils/encryption.ts";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export type GmailOAuthStateData = {
  projectId: string;
  userId: string;
  callbackURL?: string;
};

export function createGmailClient(env: CloudflareEnv) {
  const redirectURI = `${env.VITE_PUBLIC_URL}/api/integrations/gmail/callback`;
  return new arctic.Google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, redirectURI);
}

export async function revokeGmailToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    if (response.ok) {
      return true;
    }

    if (response.status === 400) {
      return true;
    }

    logger.warn("Gmail token revocation failed", { status: response.status });
    return false;
  } catch (error) {
    logger.error("Failed to revoke Gmail token", error);
    return false;
  }
}

export const gmailApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

gmailApp.get(
  "/callback",
  zValidator(
    "query",
    z.object({
      state: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  async (c) => {
    if (!c.var.session) return c.json({ error: "Unauthorized" }, 401);

    const { state, code, error } = c.req.valid("query");

    if (error) {
      logger.warn("Gmail OAuth error", { error });
      return c.redirect("/?error=gmail_oauth_denied");
    }

    if (!state || !code) {
      logger.warn("Gmail callback received without state or code");
      return c.redirect("/");
    }

    const verification = await c.var.db.query.verification.findFirst({
      where: eq(schema.verification.identifier, state),
    });

    await c.var.db.delete(schema.verification).where(eq(schema.verification.identifier, state));

    if (!verification || verification.expiresAt < new Date()) {
      return c.json({ error: "Invalid state or state has expired" }, 400);
    }

    const stateData = z
      .object({
        projectId: z.string(),
        userId: z.string(),
        callbackURL: z.string().optional(),
        codeVerifier: z.string(),
      })
      .parse(JSON.parse(verification.value));

    const { projectId, userId, callbackURL, codeVerifier } = stateData;

    if (c.var.session.user.id !== userId) {
      logger.warn("Gmail callback user mismatch", {
        sessionUserId: c.var.session.user.id,
        stateUserId: userId,
      });
      return c.json({ error: "User mismatch - please restart the Gmail connection flow" }, 403);
    }

    const gmail = createGmailClient(c.env);

    let tokens: arctic.OAuth2Tokens;
    try {
      tokens = await gmail.validateAuthorizationCode(code, codeVerifier);
    } catch (error) {
      logger.error("Failed to validate Gmail authorization code", error);
      return c.json({ error: "Failed to validate authorization code" }, 400);
    }

    const accessToken = tokens.accessToken();
    const refreshToken = tokens.refreshToken();

    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userInfoResponse.ok) {
      logger.error("Failed to fetch Gmail user info", await userInfoResponse.text());
      return c.json({ error: "Failed to get user info from Google" }, 400);
    }

    const userInfo = (await userInfoResponse.json()) as {
      id: string;
      email: string;
      name?: string;
      picture?: string;
    };

    const encryptedAccessToken = await encrypt(accessToken);
    const encryptedRefreshToken = refreshToken ? await encrypt(refreshToken) : null;

    const project = await c.var.db.transaction(async (tx) => {
      const existingConnection = await tx.query.projectConnection.findFirst({
        where: (pc, { eq, and }) =>
          and(eq(pc.projectId, projectId), eq(pc.provider, "gmail"), eq(pc.userId, userId)),
      });

      if (existingConnection) {
        await tx
          .update(schema.projectConnection)
          .set({
            externalId: userInfo.id,
            providerData: {
              googleUserId: userInfo.id,
              email: userInfo.email,
              name: userInfo.name,
              picture: userInfo.picture,
              encryptedAccessToken,
              encryptedRefreshToken,
              tokenExpiresAt: tokens.accessTokenExpiresAt()?.toISOString(),
            },
            scopes: GMAIL_SCOPES.join(" "),
          })
          .where(eq(schema.projectConnection.id, existingConnection.id));
      } else {
        await tx.insert(schema.projectConnection).values({
          projectId,
          provider: "gmail",
          externalId: userInfo.id,
          scope: "user",
          userId,
          providerData: {
            googleUserId: userInfo.id,
            email: userInfo.email,
            name: userInfo.name,
            picture: userInfo.picture,
            encryptedAccessToken,
            encryptedRefreshToken,
            tokenExpiresAt: tokens.accessTokenExpiresAt()?.toISOString(),
          },
          scopes: GMAIL_SCOPES.join(" "),
        });
      }

      return tx.query.project.findFirst({
        where: eq(schema.project.id, projectId),
        with: {
          organization: true,
        },
      });
    });

    const redirectPath =
      callbackURL ||
      (project ? `/orgs/${project.organization.slug}/projects/${project.slug}/connectors` : "/");
    return c.redirect(redirectPath);
  },
);

