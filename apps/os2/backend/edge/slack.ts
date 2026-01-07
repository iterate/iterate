import { Hono } from "hono";
import type { CloudflareEnv } from "../../env.ts";
import type { Variables } from "../worker.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";

export const slackEdgeApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

slackEdgeApp.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);

  if (!payload || typeof payload !== "object") {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const typedPayload = payload as Record<string, unknown>;

  if (typedPayload.type === "url_verification") {
    return c.json({ challenge: typedPayload.challenge });
  }

  const teamId =
    (typedPayload.team_id as string | undefined) ||
    ((typedPayload.team as Record<string, unknown> | undefined)?.id as string | undefined) ||
    ((typedPayload.event as Record<string, unknown> | undefined)?.team as string | undefined);

  if (!teamId) {
    logger.warn("Slack webhook missing team_id");
  }

  const db = c.var.db;

  // TODO: Implement projectConnection lookup once the table is added
  // For now, we store events without a projectId
  const projectId = null;

  if (teamId) {
    logger.warn(`Project connection lookup not yet implemented for Slack team ${teamId}`);
  }

  try {
    await db.insert(schema.event).values({
      type: getSlackEventType(typedPayload),
      payload: typedPayload,
      projectId,
    });
  } catch (error) {
    logger.error("Failed to store Slack event", error);
  }

  return c.text("ok");
});

function getSlackEventType(payload: Record<string, unknown>): string {
  if (payload.type === "url_verification") {
    return "slack.url_verification";
  }

  if (payload.type === "event_callback" && typeof payload.event === "object" && payload.event) {
    const event = payload.event as Record<string, unknown>;
    const eventType = event.type as string | undefined;
    const subtype = event.subtype as string | undefined;
    if (eventType) {
      return subtype ? `slack.${eventType}.${subtype}` : `slack.${eventType}`;
    }
  }

  if (payload.command) {
    return "slack.command";
  }

  return `slack.${String(payload.type ?? "unknown")}`;
}
