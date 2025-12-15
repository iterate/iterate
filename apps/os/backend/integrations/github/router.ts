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
  getInstallationByRepoId,
  getGithubInstallationForEstate,
  triggerGithubBuild,
  githubAppInstance,
} from "./github-utils.ts";

export const githubApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();
githubApp.get(
  "/callback",
  zValidator(
    "query",
    z.object({
      state: z.string().optional(),
      code: z.string(),
      installation_id: z.string().transform((val) => parseInt(val)),
    }),
  ),
  async (c) => {
    if (!c.var.session) return c.json({ error: "Unauthorized" }, 401);
    const { state, code, installation_id } = c.req.valid("query");

    // If there is state missing, that means the user might have clicked save in the github ui without initiating the flow
    // just redirect them to the home page, this should not show an error to the user
    // TODO: Handle this better, find the associated estate and update stuff
    if (!state) return c.redirect("/");

    const verification = await c.var.db.query.verification.findFirst({
      where: eq(schema.verification.identifier, state),
    });
    await c.var.db.delete(schema.verification).where(eq(schema.verification.identifier, state));

    if (!verification || verification.expiresAt < new Date()) {
      return c.json({ error: "Invalid state or state has expired" }, 400);
    }
    const parsedState = z
      .object({
        installationId: z.string(),
        redirectUri: z.string(),
        userId: z.string(),
        callbackURL: z.string().optional(),
      })
      .parse(JSON.parse(verification.value));

    const { installationId, redirectUri, userId, callbackURL } = parsedState;

    const oauthResult = await githubAppInstance()
      .oauth.createToken({
        code,
        redirectUrl: redirectUri,
        state,
      })
      .catch((error) => {
        logger.error("Failed to create token", error);
        return null;
      });

    if (!oauthResult) return c.json({ error: "Failed to create token" }, 400);

    const userOctokit = await githubAppInstance().oauth.getUserOctokit(oauthResult.authentication);
    const userInfo = await userOctokit.rest.users.getAuthenticated();
    if (userInfo.status !== 200) {
      logger.error("Failed to get user info", userInfo.data);
      return c.json({ error: "Failed to get user info" }, 400);
    }

    const installationsForUser = await userOctokit.rest.apps.listInstallationsForAuthenticatedUser({
      per_page: 100,
    });

    if (installationsForUser.status !== 200) {
      logger.error("Failed to get installations for user", installationsForUser.data);
      return c.json({ error: "Failed to get installations for user" }, 400);
    }

    const installation = installationsForUser.data.installations.find(
      (installation) => installation.id === installation_id,
    );

    if (!installation) {
      const message = `User ${userInfo.data.id} does not have access to installation ${installation_id}`;
      logger.error(message);
      return c.json({ error: message }, 400);
    }
    const repos = await Array.fromAsync(
      githubAppInstance().eachRepository.iterator({
        installationId: parseInt(installation_id.toString()),
      }),
    );

    const estate = await c.var.db.transaction(async (tx) => {
      const [account] = await tx
        .insert(schema.account)
        .values({
          providerId: "github-app",
          accountId: installation_id.toString(),
          userId,
          accessToken: oauthResult.authentication.token,
          refreshToken: oauthResult.authentication.refreshToken,
          accessTokenExpiresAt: new Date(oauthResult.authentication.expiresAt!),
          refreshTokenExpiresAt: new Date(oauthResult.authentication.refreshTokenExpiresAt!),
          scope: Object.entries(installation.permissions)
            .map(([key, value]) => `${key}:${value}`)
            .join(","),
        })
        .returning();

      await tx.insert(schema.installationAccountsPermissions).values({
        accountId: account.id,
        installationId,
      });

      // user has just connected github, let's deactivate the old source to avoid confusion and to make sure we prompt them to select a new source
      await tx
        .update(schema.iterateConfigSource)
        .set({ deactivatedAt: new Date() })
        .where(eq(schema.iterateConfigSource.installationId, installationId));

      if (repos.length === 1) {
        // exactly one repo authorised, we can assume they want to use this one by default
        await tx.insert(schema.iterateConfigSource).values({
          installationId,
          provider: "github",
          repoId: repos[0].repository.id,
          branch: repos[0].repository.default_branch,
          accountId: installation_id.toString(),
        });
      }

      return tx.query.installation.findFirst({ where: eq(schema.installation.id, installationId) });
    });

    return c.redirect(
      callbackURL || (estate ? `/${estate?.organizationId}/${estate?.id}/repo` : "/"),
    );
  },
);

// GitHub webhook handler
githubApp.post("/webhook", async (c) => {
  try {
    // Get the webhook payload and signature
    const signature = c.req.header("X-Hub-Signature-256");
    const payload = await c.req.text();

    if (!signature || !payload) {
      logger.error("Missing webhook headers");
      return c.json({ error: "Missing webhook headers" }, 400);
    }

    const isValid = await validateGithubWebhookSignature(payload, signature);

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
    const estate = await getInstallationByRepoId(c.var.db, repoId);
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

    const tokenResponse = await githubAppInstance().octokit.rest.apps.createInstallationAccessToken(
      {
        installation_id: parseInt(
          githubInstallation?.accountId ?? c.env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID,
        ),
        repository_ids: [repoId],
      },
    );

    if (tokenResponse.status !== 201) {
      logger.error(
        `Failed to create installation access token (repoId: ${repoId}, installationId: ${githubInstallation?.accountId ?? "default"}): ${tokenResponse.status} ${tokenResponse.data}`,
      );
      return c.json(
        { error: `Failed to create installation access token for repository with id ${repoId}` },
        400,
      );
    }

    // Construct the repository URL
    const repoUrl = event.repository?.html_url || event.repository?.url;
    if (!repoUrl) {
      return c.json({ error: "Repository URL not found in webhook payload" }, 400);
    }

    // Use the common build trigger function
    const build = await triggerGithubBuild({
      installationId: estate.id,
      commitHash: commitHash!,
      commitMessage: commitMessage || "No commit message",
      repoUrl,
      installationToken: tokenResponse.data.token,
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
