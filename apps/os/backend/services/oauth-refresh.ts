/**
 * OAuth Token Refresh Service
 *
 * Handles automatic refresh of OAuth tokens for connectors.
 * Called by the egress proxy when a 401 response is received.
 */

import { eq } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import type { SecretMetadata } from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { decryptWithSecret, encryptWithSecret } from "../utils/encryption-core.ts";
import { getConnectorForUrl, getFullReauthUrl } from "./connectors.ts";

export type RefreshResult =
  | { ok: true; newValue: string }
  | {
      ok: false;
      code: "NOT_REFRESHABLE" | "NO_REFRESH_TOKEN" | "REFRESH_FAILED";
      reauthUrl: string;
    };

/**
 * Context required for OAuth refresh operations.
 * Allows the service to work in both main worker and standalone egress proxy.
 */
export type RefreshContext = {
  orgSlug?: string;
  projectSlug?: string;
  encryptionSecret: string;
  publicUrl?: string;
  slackClientId?: string;
  slackClientSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  // GitHub App credentials for regenerating installation tokens
  githubAppId?: string;
  githubAppPrivateKey?: string;
};

/**
 * Attempt to refresh an OAuth token.
 *
 * @param db - Database connection
 * @param secretId - ID of the secret to refresh
 * @param originalUrl - The URL that triggered the 401 (used to determine connector)
 * @param context - OAuth credentials and context for building URLs
 * @returns RefreshResult with new token value or error with reauth URL
 */
export async function attemptSecretRefresh(
  db: DB,
  secretId: string,
  originalUrl: string,
  context: RefreshContext,
): Promise<RefreshResult> {
  // Get the secret
  const secret = await db.query.secret.findFirst({
    where: eq(schema.secret.id, secretId),
  });

  if (!secret) {
    logger.error("attemptSecretRefresh: secret not found", { secretId });
    return {
      ok: false,
      code: "REFRESH_FAILED",
      reauthUrl: "/settings/connectors",
    };
  }

  // Determine connector from URL
  const connector = getConnectorForUrl(originalUrl);
  const reauthUrl = connector
    ? getFullReauthUrl(connector, context, context.publicUrl)
    : "/settings/connectors";

  // Check if connector is refreshable
  if (!connector?.refreshable) {
    logger.info("attemptSecretRefresh: connector not refreshable", {
      secretId,
      connector: connector?.name,
    });
    return { ok: false, code: "NOT_REFRESHABLE", reauthUrl };
  }

  const metadata = secret.metadata as SecretMetadata | null;

  // GitHub uses installation tokens (regenerated via App), not refresh tokens
  if (connector.name === "GitHub") {
    if (!metadata?.githubInstallationId) {
      logger.warn("attemptSecretRefresh: no GitHub installation ID", { secretId });
      return { ok: false, code: "NO_REFRESH_TOKEN", reauthUrl };
    }

    try {
      const newTokenData = await refreshGitHubInstallationToken(
        metadata.githubInstallationId,
        context,
      );

      if (!newTokenData) {
        logger.warn("attemptSecretRefresh: GitHub refresh returned no data", { secretId });
        await updateSecretFailure(db, secretId);
        return { ok: false, code: "REFRESH_FAILED", reauthUrl };
      }

      // Encrypt and store new token
      const encryptedNewToken = await encryptWithSecret(
        newTokenData.accessToken,
        context.encryptionSecret,
      );

      await db
        .update(schema.secret)
        .set({
          encryptedValue: encryptedNewToken,
          lastSuccessAt: new Date(),
        })
        .where(eq(schema.secret.id, secretId));

      logger.info("attemptSecretRefresh: GitHub success", { secretId });
      return { ok: true, newValue: newTokenData.accessToken };
    } catch (error) {
      logger.error("attemptSecretRefresh: GitHub error", {
        secretId,
        error: error instanceof Error ? error.message : String(error),
      });
      await updateSecretFailure(db, secretId);
      return { ok: false, code: "REFRESH_FAILED", reauthUrl };
    }
  }

  // Standard OAuth refresh flow for other connectors
  if (!metadata?.encryptedRefreshToken) {
    logger.warn("attemptSecretRefresh: no refresh token", { secretId });
    return { ok: false, code: "NO_REFRESH_TOKEN", reauthUrl };
  }

  // Decrypt refresh token
  const refreshToken = await decryptWithSecret(
    metadata.encryptedRefreshToken,
    context.encryptionSecret,
  );

  // Attempt refresh based on connector type
  try {
    const newTokenData = await refreshOAuthToken(connector.name, refreshToken, context);

    if (!newTokenData) {
      logger.warn("attemptSecretRefresh: refresh returned no data", { secretId });
      await updateSecretFailure(db, secretId);
      return { ok: false, code: "REFRESH_FAILED", reauthUrl };
    }

    // Encrypt and store new token
    const encryptedNewToken = await encryptWithSecret(
      newTokenData.accessToken,
      context.encryptionSecret,
    );

    // Update metadata if we got a new refresh token
    const newMetadata: SecretMetadata = { ...metadata };
    if (newTokenData.refreshToken) {
      newMetadata.encryptedRefreshToken = await encryptWithSecret(
        newTokenData.refreshToken,
        context.encryptionSecret,
      );
    }
    if (newTokenData.expiresAt) {
      newMetadata.expiresAt = newTokenData.expiresAt;
    }

    // Update the secret
    await db
      .update(schema.secret)
      .set({
        encryptedValue: encryptedNewToken,
        metadata: newMetadata,
        lastSuccessAt: new Date(),
      })
      .where(eq(schema.secret.id, secretId));

    logger.info("attemptSecretRefresh: success", { secretId, connector: connector.name });
    return { ok: true, newValue: newTokenData.accessToken };
  } catch (error) {
    logger.error("attemptSecretRefresh: error", {
      secretId,
      error: error instanceof Error ? error.message : String(error),
    });
    await updateSecretFailure(db, secretId);
    return { ok: false, code: "REFRESH_FAILED", reauthUrl };
  }
}

/**
 * Update the secret's lastFailedAt timestamp.
 */
async function updateSecretFailure(db: DB, secretId: string): Promise<void> {
  await db
    .update(schema.secret)
    .set({ lastFailedAt: new Date() })
    .where(eq(schema.secret.id, secretId));
}

/**
 * Refresh an OAuth token using provider-specific logic.
 */
async function refreshOAuthToken(
  connectorName: string,
  refreshToken: string,
  context: RefreshContext,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string } | null> {
  switch (connectorName.toLowerCase()) {
    case "slack":
      return refreshSlackToken(refreshToken, context);
    case "google":
    case "gmail":
      return refreshGoogleToken(refreshToken, context);
    case "github":
      // GitHub is handled separately via installation tokens
      return null;
    default:
      logger.warn("refreshOAuthToken: unknown connector", { connectorName });
      return null;
  }
}

/**
 * Refresh a GitHub App installation token.
 * GitHub App installation tokens expire after 1 hour but can be regenerated anytime.
 */
async function refreshGitHubInstallationToken(
  installationId: number,
  context: RefreshContext,
): Promise<{ accessToken: string; expiresAt?: string } | null> {
  if (!context.githubAppId || !context.githubAppPrivateKey) {
    logger.warn("GitHub App credentials not configured for refresh");
    return null;
  }

  try {
    // Generate JWT for GitHub App authentication
    const { createPrivateKey } = await import("node:crypto");
    const { SignJWT, importPKCS8 } = await import("jose");

    const keyString = context.githubAppPrivateKey.replace(/\\n/g, "\n");
    const privateKey = createPrivateKey({
      key: keyString,
      format: "pem",
    }).export({
      type: "pkcs8",
      format: "pem",
    }) as string;

    const key = await importPKCS8(privateKey, "RS256");

    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(context.githubAppId)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);

    // Get installation access token
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Iterate-OS",
        },
      },
    );

    if (!response.ok) {
      logger.error("GitHub installation token request failed", {
        status: response.status,
        body: await response.text(),
      });
      return null;
    }

    const data = (await response.json()) as { token: string; expires_at: string };

    return {
      accessToken: data.token,
      expiresAt: data.expires_at,
    };
  } catch (error) {
    logger.error("Failed to refresh GitHub installation token", {
      installationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// Slack OAuth token response type
type SlackTokenResponse = {
  ok: boolean;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
};

/**
 * Refresh a Slack OAuth token.
 */
async function refreshSlackToken(
  refreshToken: string,
  context: RefreshContext,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string } | null> {
  if (!context.slackClientId || !context.slackClientSecret) {
    logger.warn("Slack client credentials not configured");
    return null;
  }

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: context.slackClientId,
      client_secret: context.slackClientSecret,
    }),
  });

  const data = (await response.json()) as SlackTokenResponse;

  if (!data.ok || !data.access_token) {
    logger.warn("Slack token refresh failed", { error: data.error });
    return null;
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // Slack may return a new refresh token
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined,
  };
}

// Google OAuth token response type
type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
};

/**
 * Refresh a Google OAuth token.
 */
async function refreshGoogleToken(
  refreshToken: string,
  context: RefreshContext,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string } | null> {
  if (!context.googleClientId || !context.googleClientSecret) {
    logger.warn("Google client credentials not configured");
    return null;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: context.googleClientId,
      client_secret: context.googleClientSecret,
    }),
  });

  const data = (await response.json()) as GoogleTokenResponse;

  if (data.error || !data.access_token) {
    logger.warn("Google token refresh failed", { error: data.error });
    return null;
  }

  return {
    accessToken: data.access_token,
    // Google doesn't return a new refresh token on refresh
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined,
  };
}
