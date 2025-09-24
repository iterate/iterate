import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { CloudflareEnv } from "../../../env";
import type { Variables } from "../../worker";
import * as schema from "../../db/schema.ts";
import { runConfigInSandbox } from "../../sandbox/run-config.ts";
import { invalidateOrganizationQueries } from "../../utils/websocket-utils.ts";
import { signUrl } from "../../utils/url-signing.ts";
import {
  validateGithubWebhookSignature,
  getEstateByRepoId,
  getGithubInstallationForEstate,
  getGithubInstallationToken,
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

// GitHub webhook handler
githubApp.post("/webhook", async (c) => {
  try {
    // Get the webhook payload and signature
    const signature = c.req.header("X-Hub-Signature-256");
    const payload = await c.req.text();

    // Validate the webhook signature
    if (!c.env.GITHUB_WEBHOOK_SECRET) {
      console.error("GITHUB_WEBHOOK_SECRET not configured");
      return c.json({ error: "Webhook secret not configured" }, 500);
    }

    const isValid = validateGithubWebhookSignature(
      payload,
      signature || null,
      c.env.GITHUB_WEBHOOK_SECRET,
    );

    if (!isValid) {
      console.error("Invalid webhook signature");
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
      console.error("Missing repository information");
      return c.json({ error: "Invalid webhook payload - no repository" }, 400);
    }

    // Extract commit information from push event
    const commitHash = event.after || event.head_commit?.id;
    const commitMessage = event.head_commit?.message || "Push event";
    const branch = event.ref?.replace("refs/heads/", "");

    if (!commitHash) {
      console.error("Missing commit information in push event");
      return c.json({ error: "Invalid webhook payload - no commit hash" }, 400);
    }

    console.log(`Processing push: branch=${branch}, commit=${commitHash.substring(0, 7)}`);

    // Find the estate connected to this repository
    const estate = await getEstateByRepoId(c.var.db, repoId);
    if (!estate) {
      console.log(`No estate found for repository ${repoId}`);
      return c.json({ message: "Repository not connected to any estate" }, 200);
    }

    // Only process if the push is to the configured branch
    if (branch && branch !== estate.connectedRepoRef) {
      console.log(
        `Ignoring event on branch ${branch}, estate configured for ${estate.connectedRepoRef}`,
      );
      return c.json({ message: "Event not on configured branch" }, 200);
    }

    // Get the GitHub installation for this estate
    const githubInstallation = await getGithubInstallationForEstate(c.var.db, estate.id);
    if (!githubInstallation) {
      console.error(`No GitHub installation found for estate ${estate.id}`);
      return c.json({ error: "GitHub installation not found" }, 500);
    }

    // Get an installation access token
    const installationToken = await getGithubInstallationToken(githubInstallation.accountId);
    // Create an in-progress build log
    const [build] = await c.var.db
      .insert(schema.builds)
      .values({
        status: "in_progress",
        commitHash: commitHash!, // We've already checked this is defined above
        commitMessage: commitMessage || "No commit message",
        webhookIterateId: event.id || `webhook-${Date.now()}`,
        estateId: estate.id,
        iterateWorkflowRunId: event.workflow_run?.id?.toString(),
      })
      .returning();

    // Get the organization ID from the estate for WebSocket invalidation
    const estateWithOrg = await c.var.db.query.estate.findFirst({
      where: eq(schema.estate.id, estate.id),
      with: {
        organization: true,
      },
    });

    // Invalidate organization queries to show the new in-progress build
    if (estateWithOrg?.organization) {
      await invalidateOrganizationQueries(c.env, estateWithOrg.organization.id, {
        type: "INVALIDATE",
        invalidateInfo: {
          type: "TRPC_QUERY",
          paths: ["estate.getBuilds"],
        },
      });
    }

    // Construct the repository URL
    const repoUrl = event.repository?.html_url || event.repository?.url;
    if (!repoUrl) {
      await c.var.db
        .update(schema.builds)
        .set({
          status: "failed",
          completedAt: new Date(),
          output: { stderr: "Repository URL not found in webhook payload" },
        })
        .where(eq(schema.builds.id, build.id));

      return c.json({ error: "Repository URL not found" }, 400);
    }

    // Generate a signed callback URL
    let baseUrl = new URL(c.req.url).origin;
    if (baseUrl.includes("localhost")) {
      baseUrl = `https://${c.env.ITERATE_USER}.dev.iterate.com`;
    }
    const callbackUrl = await signUrl(
      `${baseUrl}/api/build/callback`,
      c.env.EXPIRING_URLS_SIGNING_KEY,
      3600, // 1 hour expiration
    );

    // Run the configuration in the sandbox with callback
    const result = await runConfigInSandbox(c.env, {
      githubRepoUrl: repoUrl,
      githubToken: installationToken,
      branch: estate.connectedRepoRef || "main",
      commitHash,
      workingDirectory: estate.connectedRepoPath || undefined,
      callbackUrl,
      buildId: build.id,
      estateId: estate.id,
    });

    // When using callback, the build is handled asynchronously
    // The callback endpoint will handle updating the build status and iterate config
    if ("error" in result) {
      // If there was an immediate error (e.g., sandbox not available), update the build
      await c.var.db
        .update(schema.builds)
        .set({
          status: "failed",
          completedAt: new Date(),
          output: { stderr: result.details ? `${result.error}: ${result.details}` : result.error },
        })
        .where(eq(schema.builds.id, build.id));

      // Invalidate organization queries to show the failed build
      if (estateWithOrg?.organization) {
        await invalidateOrganizationQueries(c.env, estateWithOrg.organization.id, {
          type: "INVALIDATE",
          invalidateInfo: {
            type: "TRPC_QUERY",
            paths: ["estate.getBuilds"],
          },
        });
      }

      return c.json({
        message: "Build failed to start",
        buildId: build.id,
        status: "failed",
      });
    }

    // Build started successfully, results will be sent to callback
    return c.json({
      message: "Build started, results will be sent via callback",
      buildId: build.id,
      status: "in_progress",
    });
  } catch (error) {
    console.error("GitHub webhook error:", error);
    return c.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});
