import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import * as arctic from "arctic";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import * as schema from "../../db/schema.ts";
import type { SecretMetadata } from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { encrypt } from "../../utils/encryption.ts";
import { outboxClient } from "../../outbox/client.ts";

/**
 * Google OAuth scopes for Gmail, Calendar, Docs, Sheets, and Drive access.
 * These match the scopes configured in Google Cloud Console.
 */
export const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
];

export type GoogleOAuthStateData = {
  projectId: string;
  userId: string;
  callbackURL?: string;
};

const GoogleOAuthState = z.object({
  projectId: z.string(),
  userId: z.string(),
  callbackURL: z.string().optional(),
  codeVerifier: z.string(),
});

/**
 * Create a Google OAuth client using arctic.
 */
export function createGoogleClient(env: CloudflareEnv) {
  const redirectUri = `${env.VITE_PUBLIC_URL}/api/integrations/google/callback`;
  return new arctic.Google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, redirectUri);
}

/**
 * Revoke a Google access token.
 * Returns true if revocation succeeded or token was already invalid.
 */
export async function revokeGoogleToken(accessToken: string): Promise<boolean> {
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

    // Google returns 200 for successful revocation
    // Returns 400 if token is already invalid/revoked - that's fine
    if (response.ok || response.status === 400) {
      return true;
    }

    logger.warn("Google token revocation failed", { status: response.status });
    return false;
  } catch (error) {
    logger.error("Failed to revoke Google token", error);
    return false;
  }
}

export const googleApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * Google OAuth callback handler.
 * Handles the redirect from Google after the user authorizes the app.
 * This is a USER-SCOPED connection (unlike Slack which is project-scoped).
 */
googleApp.get(
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

    // Handle OAuth denial/error from Google
    if (error) {
      logger.warn("Google OAuth error", { error });

      if (state) {
        const verification = await c.var.db.query.verification.findFirst({
          where: eq(schema.verification.identifier, state),
        });

        if (verification) {
          await c.var.db
            .delete(schema.verification)
            .where(eq(schema.verification.identifier, state));
        }

        if (verification && verification.expiresAt >= new Date()) {
          const stateData = GoogleOAuthState.safeParse(JSON.parse(verification.value));

          if (stateData.success) {
            const { callbackURL, projectId } = stateData.data;
            const errorParam = "google_oauth_denied";

            if (callbackURL) {
              const redirectURL = new URL(callbackURL, c.env.VITE_PUBLIC_URL);
              redirectURL.searchParams.set("error", errorParam);
              return c.redirect(redirectURL.toString());
            }

            const project = await c.var.db.query.project.findFirst({
              where: eq(schema.project.id, projectId),
              with: {
                organization: true,
              },
            });

            if (project) {
              return c.redirect(
                `/orgs/${project.organization.slug}/projects/${project.slug}/connectors?error=${errorParam}`,
              );
            }
          }
        }
      }

      return c.redirect("/?error=google_oauth_denied");
    }

    if (!state || !code) {
      logger.warn("Google callback received without state or code");
      return c.redirect("/");
    }

    const verification = await c.var.db.query.verification.findFirst({
      where: eq(schema.verification.identifier, state),
    });

    await c.var.db.delete(schema.verification).where(eq(schema.verification.identifier, state));

    if (!verification || verification.expiresAt < new Date()) {
      return c.json({ error: "Invalid state or state has expired" }, 400);
    }

    const stateData = GoogleOAuthState.parse(JSON.parse(verification.value));

    const { projectId, userId, callbackURL, codeVerifier } = stateData;

    if (c.var.session.user.id !== userId) {
      logger.warn("Google callback user mismatch", {
        sessionUserId: c.var.session.user.id,
        stateUserId: userId,
      });
      return c.json({ error: "User mismatch - please restart the Google connection flow" }, 403);
    }

    const google = createGoogleClient(c.env);

    let tokens: arctic.OAuth2Tokens;
    try {
      tokens = await google.validateAuthorizationCode(code, codeVerifier);
    } catch (err) {
      logger.error("Failed to exchange Google authorization code", err);
      return c.json({ error: "Failed to validate authorization code" }, 400);
    }

    const accessToken = tokens.accessToken();
    const refreshToken = tokens.refreshToken();
    const expiresAt = tokens.accessTokenExpiresAt();

    // Fetch user info from Google
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userInfoResponse.ok) {
      logger.error("Failed to fetch Google user info", await userInfoResponse.text());
      return c.json({ error: "Failed to get user info from Google" }, 400);
    }

    const userInfo = (await userInfoResponse.json()) as {
      id: string;
      email: string;
      name?: string;
      picture?: string;
    };

    const encryptedAccessToken = await encrypt(accessToken);
    const encryptedRefreshToken = refreshToken ? await encrypt(refreshToken) : undefined;

    const project = await c.var.db.transaction(async (tx) => {
      // Check if this user already has a Google connection for this project
      const existingConnection = await tx.query.projectConnection.findFirst({
        where: (pc, { eq: whereEq, and: whereAnd }) =>
          whereAnd(
            whereEq(pc.projectId, projectId),
            whereEq(pc.provider, "google"),
            whereEq(pc.userId, userId),
          ),
      });

      if (existingConnection) {
        // Update existing connection
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
            },
            scopes: GOOGLE_OAUTH_SCOPES.join(" "),
          })
          .where(eq(schema.projectConnection.id, existingConnection.id));
      } else {
        // Create new user-scoped connection
        await tx.insert(schema.projectConnection).values({
          projectId,
          provider: "google",
          externalId: userInfo.id,
          scope: "user",
          userId,
          providerData: {
            googleUserId: userInfo.id,
            email: userInfo.email,
            name: userInfo.name,
            picture: userInfo.picture,
            encryptedAccessToken,
          },
          scopes: GOOGLE_OAUTH_SCOPES.join(" "),
        });
      }

      // Upsert user-scoped secret for egress proxy
      // This allows `getIterateSecret({secretKey: "google.access_token"})` to resolve for this user
      const projectInfo = await tx.query.project.findFirst({
        where: eq(schema.project.id, projectId),
      });

      if (projectInfo) {
        const existingSecret = await tx.query.secret.findFirst({
          where: (s, { and: whereAnd, eq: whereEq }) =>
            whereAnd(
              whereEq(s.key, "google.access_token"),
              whereEq(s.projectId, projectId),
              whereEq(s.userId, userId),
            ),
        });

        const googleEgressRule = `$contains(url.hostname, 'googleapis.com')`;
        const secretMetadata: SecretMetadata = {
          encryptedRefreshToken,
          expiresAt: expiresAt?.toISOString(),
          scopes: GOOGLE_OAUTH_SCOPES,
        };

        if (existingSecret) {
          await tx
            .update(schema.secret)
            .set({
              encryptedValue: encryptedAccessToken,
              metadata: secretMetadata,
              lastSuccessAt: new Date(),
              egressProxyRule: googleEgressRule,
            })
            .where(eq(schema.secret.id, existingSecret.id));
        } else {
          await tx.insert(schema.secret).values({
            key: "google.access_token",
            encryptedValue: encryptedAccessToken,
            organizationId: projectInfo.organizationId,
            projectId,
            userId,
            metadata: secretMetadata,
            egressProxyRule: googleEgressRule,
          });
        }
      }

      // Emit connection:google:created event for async processing (machine refresh)
      await outboxClient.sendTx(tx, "connection:google:created", async (_tx) => ({
        payload: { projectId },
      }));

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
