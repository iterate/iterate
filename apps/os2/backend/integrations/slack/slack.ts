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
import { verifySlackSignature, getSlackEventType } from "./slack-utils.ts";

export type SlackOAuthStateData = {
  projectId: string;
  userId: string;
  redirectUri: string;
  callbackURL?: string;
};

export function createSlackClient(env: CloudflareEnv) {
  const redirectURI = `${env.VITE_PUBLIC_URL}/api/integrations/slack/callback`;
  return new arctic.Slack(env.SLACK_CLIENT_ID, env.SLACK_CLIENT_SECRET, redirectURI);
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
      code: z.string(),
    }),
  ),
  async (c) => {
    if (!c.var.session) return c.json({ error: "Unauthorized" }, 401);

    const { state, code } = c.req.valid("query");

    if (!state) {
      logger.warn("Slack callback received without state");
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
        redirectUri: z.string(),
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

    const slack = createSlackClient(c.env);

    let tokens: arctic.OAuth2Tokens;
    try {
      tokens = await slack.validateAuthorizationCode(code);
    } catch (error) {
      logger.error("Failed to validate Slack authorization code", error);
      return c.json({ error: "Failed to validate authorization code" }, 400);
    }

    const accessToken = tokens.accessToken();

    // Fetch team info from Slack
    const teamResponse = await fetch("https://slack.com/api/team.info", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!teamResponse.ok) {
      logger.error("Failed to fetch Slack team info", await teamResponse.text());
      return c.json({ error: "Failed to get team info" }, 400);
    }

    const teamData = (await teamResponse.json()) as {
      ok: boolean;
      team?: { id: string; name: string; domain: string };
      error?: string;
    };

    if (!teamData.ok || !teamData.team) {
      logger.error("Slack team.info API error", teamData.error);
      return c.json({ error: "Failed to get team info from Slack" }, 400);
    }

    const encryptedAccessToken = await encrypt(accessToken);

    const project = await c.var.db.transaction(async (tx) => {
      const existingConnection = await tx.query.projectConnection.findFirst({
        where: (pc, { eq, and }) => and(eq(pc.projectId, projectId), eq(pc.provider, "slack")),
      });

      if (existingConnection) {
        await tx
          .update(schema.projectConnection)
          .set({
            externalId: teamData.team!.id,
            providerData: {
              teamId: teamData.team!.id,
              teamName: teamData.team!.name,
              teamDomain: teamData.team!.domain,
              encryptedAccessToken,
            },
          })
          .where(eq(schema.projectConnection.id, existingConnection.id));
      } else {
        await tx.insert(schema.projectConnection).values({
          projectId,
          provider: "slack",
          externalId: teamData.team!.id,
          scope: "project",
          userId,
          providerData: {
            teamId: teamData.team!.id,
            teamName: teamData.team!.name,
            teamDomain: teamData.team!.domain,
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

  // Verify Slack signature
  const isValid = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    c.req.header("x-slack-signature") ?? null,
    c.req.header("x-slack-request-timestamp") ?? null,
    body,
  );

  if (!isValid) {
    console.warn("Invalid Slack signature");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (typeof payload !== "object" || payload === null) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const p = payload as Record<string, unknown>;

  // Handle URL verification challenge
  if (p.type === "url_verification") {
    return c.json({ challenge: p.challenge });
  }

  // Get team ID from payload
  const teamId =
    (p.team_id as string) ||
    ((p.team as Record<string, unknown>)?.id as string) ||
    ((p.event as Record<string, unknown>)?.team as string);

  if (!teamId) {
    console.warn("No team_id in Slack webhook payload");
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
    // Log but don't fail - the webhook might be from a workspace not yet linked
    console.warn(`No project found for Slack team ${teamId}`);
    return c.text("ok");
  }

  // Save event to database
  const eventType = getSlackEventType(payload);

  try {
    await db.insert(schema.event).values({
      type: eventType,
      payload: payload as Record<string, unknown>,
      projectId,
    });
  } catch (error) {
    console.error("Failed to save Slack event:", error);
    // Don't fail the webhook - Slack might retry and cause duplicates
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
