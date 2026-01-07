import { Hono } from "hono";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../worker.ts";
import * as schema from "../../db/schema.ts";
import { verifySlackSignature, getSlackEventType } from "./slack-utils.ts";

export const slackApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

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
  const teamId = (p.team_id as string) ||
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
    where: (pc, { eq, and }) =>
      and(
        eq(pc.provider, "slack"),
        eq(pc.externalId, teamId)
      ),
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

  let payload: unknown;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // For now, just acknowledge - actual handling would be implemented later
  console.log("Received Slack interactive payload:", payload);

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

  // Parse form data
  const formData = new URLSearchParams(body);
  const command = formData.get("command");
  const text = formData.get("text");

  console.log(`Received slash command: ${command} ${text}`);

  // For now, just acknowledge
  return c.json({
    response_type: "ephemeral",
    text: "Command received! This feature is coming soon.",
  });
});
