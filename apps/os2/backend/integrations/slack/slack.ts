import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../worker.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { encrypt } from "../../utils/encryption.ts";
import { verifySlackSignature, getSlackEventType } from "./slack-utils.ts";

export const SLACK_BOT_SCOPES = [
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users.profile:read",
  "users:read",
  "users:read.email",
  "assistant:write",
  "conversations.connect:write",
];

export type SlackOAuthStateData = {
  projectId: string;
  userId: string;
  callbackURL?: string;
};

/**
 * Revoke a Slack access token using auth.revoke API
 * Returns true if revocation succeeded or token was already invalid
 */
export async function revokeSlackToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch("https://slack.com/api/auth.revoke", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      logger.warn("Slack auth.revoke HTTP error", { status: response.status });
      return false;
    }

    const data = (await response.json()) as { ok: boolean; revoked?: boolean; error?: string };

    if (!data.ok) {
      // Token might already be invalid/revoked - that's fine
      if (data.error === "invalid_auth" || data.error === "token_revoked") {
        return true;
      }
      logger.warn("Slack auth.revoke API error", { error: data.error });
      return false;
    }

    return true;
  } catch (error) {
    logger.error("Failed to revoke Slack token", error);
    return false;
  }
}

export const slackApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * Slack OAuth callback handler
 * Handles the redirect from Slack after the user authorizes the app
 */
slackApp.get(
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

    // Handle OAuth denial/error from Slack
    if (error) {
      logger.warn("Slack OAuth error", { error });
      return c.redirect("/?error=slack_oauth_denied");
    }

    if (!state || !code) {
      logger.warn("Slack callback received without state or code");
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
      })
      .parse(JSON.parse(verification.value));

    const { projectId, userId, callbackURL } = stateData;

    if (c.var.session.user.id !== userId) {
      logger.warn("Slack callback user mismatch", {
        sessionUserId: c.var.session.user.id,
        stateUserId: userId,
      });
      return c.json({ error: "User mismatch - please restart the Slack connection flow" }, 403);
    }

    // Use WebClient for proper OAuth v2 token exchange
    // arctic.Slack uses OpenID Connect which doesn't work with bot scopes
    const redirectUri = `${c.env.VITE_PUBLIC_URL}/api/integrations/slack/callback`;
    const slackClient = new WebClient();

    let tokens;
    try {
      tokens = await slackClient.oauth.v2.access({
        client_id: c.env.SLACK_CLIENT_ID,
        client_secret: c.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      });
    } catch (error) {
      logger.error("Failed to exchange Slack authorization code", error);
      return c.json({ error: "Failed to validate authorization code" }, 400);
    }

    if (!tokens.ok || !tokens.access_token || !tokens.team?.id) {
      logger.error("Slack oauth.v2.access failed", tokens.error);
      return c.json({ error: "Failed to get tokens from Slack" }, 400);
    }

    const accessToken = tokens.access_token;
    const teamData = {
      id: tokens.team.id,
      name: tokens.team.name ?? "Unknown",
      domain: (tokens as { team: { domain?: string } }).team.domain ?? tokens.team.id,
    };

    const encryptedAccessToken = await encrypt(accessToken);

    let project;
    try {
      project = await c.var.db.transaction(async (tx) => {
        // Check if this project already has a Slack connection
        const existingProjectConnection = await tx.query.projectConnection.findFirst({
          where: (pc, { eq, and }) => and(eq(pc.projectId, projectId), eq(pc.provider, "slack")),
        });

        // Check if this Slack workspace is already connected to another project
        const existingWorkspaceConnection = await tx.query.projectConnection.findFirst({
          where: (pc, { eq, and }) => and(eq(pc.provider, "slack"), eq(pc.externalId, teamData.id)),
          with: { project: true },
        });

        if (existingWorkspaceConnection && existingWorkspaceConnection.projectId !== projectId) {
          throw new Error(
            `workspace_already_connected:${existingWorkspaceConnection.project?.name || "another project"}`,
          );
        }

        if (existingProjectConnection) {
          await tx
            .update(schema.projectConnection)
            .set({
              externalId: teamData.id,
              providerData: {
                teamId: teamData.id,
                teamName: teamData.name,
                teamDomain: teamData.domain,
                encryptedAccessToken,
              },
            })
            .where(eq(schema.projectConnection.id, existingProjectConnection.id));
        } else {
          await tx.insert(schema.projectConnection).values({
            projectId,
            provider: "slack",
            externalId: teamData.id,
            scope: "project",
            userId,
            providerData: {
              teamId: teamData.id,
              teamName: teamData.name,
              teamDomain: teamData.domain,
              encryptedAccessToken,
            },
          });
        }

        return tx.query.project.findFirst({
          where: eq(schema.project.id, projectId),
          with: {
            organization: true,
          },
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("workspace_already_connected:")) {
        const projectName = error.message.split(":")[1];
        const redirectPath = callbackURL || "/";
        return c.redirect(
          `${redirectPath}?error=slack_workspace_already_connected&project=${encodeURIComponent(projectName)}`,
        );
      }
      throw error;
    }

    const redirectPath =
      callbackURL ||
      (project ? `/orgs/${project.organization.slug}/projects/${project.slug}/connectors` : "/");
    return c.redirect(redirectPath);
  },
);

/**
 * Slack webhook handler
 * - Verifies Slack signature
 * - Handles url_verification challenge
 * - Saves events to the events table
 */
slackApp.post("/webhook", async (c) => {
  const body = await c.req.text();

  logger.info("[Slack Webhook] Received webhook request");

  // Verify Slack signature
  const isValid = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    c.req.header("x-slack-signature") ?? null,
    c.req.header("x-slack-request-timestamp") ?? null,
    body,
  );

  if (!isValid) {
    logger.warn("[Slack Webhook] Invalid signature");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    logger.warn("[Slack Webhook] Invalid JSON body");
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (typeof payload !== "object" || payload === null) {
    logger.warn("[Slack Webhook] Invalid payload structure");
    return c.json({ error: "Invalid payload" }, 400);
  }

  const p = payload as Record<string, unknown>;

  // Log the full payload for debugging
  logger.info("[Slack Webhook] Payload received", {
    type: p.type,
    event_type: (p.event as Record<string, unknown>)?.type,
    team_id: p.team_id,
  });

  // Handle URL verification challenge
  if (p.type === "url_verification") {
    logger.info("[Slack Webhook] URL verification challenge received");
    return c.text(p.challenge as string);
  }

  // Get team ID from payload
  const teamId =
    (p.team_id as string) ||
    ((p.team as Record<string, unknown>)?.id as string) ||
    ((p.event as Record<string, unknown>)?.team as string);

  if (!teamId) {
    logger.warn("[Slack Webhook] No team_id in payload");
    return c.text("ok");
  }

  // Find the project associated with this Slack team
  const db = c.var.db;

  // Try to find a project linked to this Slack team
  const connection = await db.query.projectConnection.findFirst({
    where: (pc, { eq, and }) => and(eq(pc.provider, "slack"), eq(pc.externalId, teamId)),
  });

  const projectId = connection?.projectId;

  if (!projectId) {
    logger.warn("[Slack Webhook] No project found for team", { teamId });
    return c.text("ok");
  }

  // Save event to database
  const eventType = getSlackEventType(payload);
  logger.info("[Slack Webhook] Saving event", { eventType, projectId, teamId });

  try {
    await db.insert(schema.event).values({
      type: eventType,
      payload: payload as Record<string, unknown>,
      projectId,
    });
    logger.info("[Slack Webhook] Event saved successfully");
  } catch (error) {
    logger.error("[Slack Webhook] Failed to save event", error);
  }

  return c.text("ok");
});

/**
 * Slack interactive endpoint (for future use)
 * Handles interactive components like buttons, menus, etc.
 */
slackApp.post("/interactive", async (c) => {
  const body = await c.req.text();

  // Verify Slack signature
  const isValid = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    c.req.header("x-slack-signature") ?? null,
    c.req.header("x-slack-request-timestamp") ?? null,
    body,
  );

  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Parse the payload (interactive payloads are URL-encoded with a payload field)
  const formData = new URLSearchParams(body);
  const payloadStr = formData.get("payload");

  if (!payloadStr) {
    return c.json({ error: "Missing payload" }, 400);
  }

  try {
    JSON.parse(payloadStr);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  return c.json({ ok: true });
});

/**
 * Slack slash commands endpoint (for future use)
 */
slackApp.post("/commands", async (c) => {
  const body = await c.req.text();

  // Verify Slack signature
  const isValid = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    c.req.header("x-slack-signature") ?? null,
    c.req.header("x-slack-request-timestamp") ?? null,
    body,
  );

  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  return c.json({
    response_type: "ephemeral",
    text: "Command received! This feature is coming soon.",
  });
});
