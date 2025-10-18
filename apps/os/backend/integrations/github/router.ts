import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { CloudflareEnv } from "../../../env";
import type { Variables } from "../../worker";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import {
  validateGithubWebhookSignature,
  getEstateByRepoId,
  getGithubInstallationForEstate,
  getGithubInstallationToken,
  triggerGithubBuild,
} from "./github-utils.ts";

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
        callbackURL: z.string().optional(),
      })
      .parse(JSON.parse(verification.value));

    const { estateId, redirectUri: redirectUriOriginal, userId, callbackURL } = parsedState;

    let redirectUri = redirectUriOriginal;
    if (process.env.GITHUB_OAUTH_REDIRECT_BASE_URL) {
      redirectUri = new URL(
        new URL(redirectUriOriginal).pathname,
        process.env.GITHUB_OAUTH_REDIRECT_BASE_URL,
      ).toString();
    }

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
      logger.error(
        "Failed to get user access token",
        new Error(await userAccessTokenRes.text(), {
          cause: { status: userAccessTokenRes.status, statusText: userAccessTokenRes.statusText },
        }),
      );
      return c.json({ error: "Failed to get user access token" }, 400);
    }
    let userAccessTokenData;
    const data = await userAccessTokenRes.json();
    try {
      userAccessTokenData = UserAccessTokenResponse.parse(data);
    } catch (error) {
      logger.error(
        "Failed to parse user access token",
        new Error(JSON.stringify(data), { cause: error }),
      );
      return c.json({ error: "Failed to get user access token" }, 400);
    }

    const installationInfoRes = await fetch(`https://api.github.com/user/installations`, {
      headers: {
        Authorization: `Bearer ${userAccessTokenData.access_token}`,
        "User-Agent": "Iterate OS",
      },
    });

    if (!installationInfoRes.ok) {
      logger.log(await installationInfoRes.text());
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

    return c.redirect(callbackURL || "/");
  },
);

// GitHub webhook handler
githubApp.post("/webhook", async (c) => {
  try {
    // Get the webhook payload and signature
    const signature = c.req.header("X-Hub-Signature-256");
    const payload = await c.req.text();

    // Validate the webhook signature
    if (!c.env.GITHUB_WEBHOOK_SECRET) {
      logger.error("GITHUB_WEBHOOK_SECRET not configured");
      return c.json({ error: "Webhook secret not configured" }, 500);
    }

    const isValid = validateGithubWebhookSignature(
      payload,
      signature || null,
      c.env.GITHUB_WEBHOOK_SECRET,
    );

    if (!isValid) {
      logger.error("Invalid webhook signature");
      return c.json({ error: "Invalid signature" }, 401);
    }

    // Parse the webhook payload
    const event = JSON.parse(payload);
    const eventType = c.req.header("X-GitHub-Event");

    // We only handle push events
    if (eventType !== "push") {
      // Silently ignore other event types
      return c.json({ message: "Event type not relevant" }, 200);
    }

    // Extract repository information
    const repoId = event.repository?.id;
    if (!repoId) {
      logger.error("Missing repository information");
      return c.json({ error: "Invalid webhook payload - no repository" }, 400);
    }

    // Extract commit information from push event
    const commitHash = event.after || event.head_commit?.id;
    const commitMessage = event.head_commit?.message || "Push event";
    const branch = event.ref?.replace("refs/heads/", "");

    if (!commitHash) {
      logger.error("Missing commit information in push event");
      return c.json({ error: "Invalid webhook payload - no commit hash" }, 400);
    }

    logger.log(`Processing push: branch=${branch}, commit=${commitHash.substring(0, 7)}`);

    // Find the estate connected to this repository
    const estate = await getEstateByRepoId(c.var.db, repoId);
    if (!estate) {
      logger.log(`No estate found for repository ${repoId}`);
      return c.json({ message: "Repository not connected to any estate" }, 200);
    }

    // Only process if the push is to the configured branch
    if (branch && branch !== estate.connectedRepoRef) {
      logger.log(
        `Ignoring event on branch ${branch}, estate configured for ${estate.connectedRepoRef}`,
      );
      return c.json({ message: "Event not on configured branch" }, 200);
    }

    // Get the GitHub installation for this estate
    const githubInstallation = await getGithubInstallationForEstate(c.var.db, estate.id);
    if (!githubInstallation) {
      logger.error(`No GitHub installation found for estate ${estate.id}`);
      return c.json({ error: "GitHub installation not found" }, 500);
    }

    // Get an installation access token
    const installationToken = await getGithubInstallationToken(githubInstallation.accountId);

    // Construct the repository URL
    const repoUrl = event.repository?.html_url || event.repository?.url;
    if (!repoUrl) {
      return c.json({ error: "Repository URL not found in webhook payload" }, 400);
    }

    if (!installationToken) {
      logger.error(`No installation token found for estate ${estate.id}`);
      return c.json(
        { error: "Installation token not found, please re-authenticate github app" },
        400,
      );
    }

    // Use the common build trigger function
    const build = await triggerGithubBuild({
      db: c.var.db,
      env: c.env,
      estateId: estate.id,
      commitHash: commitHash!,
      commitMessage: commitMessage || "No commit message",
      repoUrl,
      installationToken,
      connectedRepoPath: estate.connectedRepoPath || undefined,
      branch: estate.connectedRepoRef || "main",
      webhookId: event.id || `webhook-${Date.now()}`,
      workflowRunId: event.workflow_run?.id?.toString(),
      isManual: false,
    });

    // Build started successfully
    return c.json({
      message: "Build started",
      buildId: build.id,
      status: "in_progress",
    });
  } catch (error) {
    logger.error("GitHub webhook error:", error);
    return c.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});
