import { Hono } from "hono";
import type { CloudflareEnv } from "../../../env.ts";
import { getDb } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { verifySlackSignature } from "./slack-utils.ts";

export const slackApp = new Hono<{ Bindings: CloudflareEnv }>();

slackApp.post("/webhook", async (c) => {
  const rawBody = await c.req.text();
  const timestamp = c.req.header("X-Slack-Request-Timestamp") || "";
  const signature = c.req.header("X-Slack-Signature") || "";

  const isValid = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    signature,
    timestamp,
    rawBody,
  );

  if (!isValid) {
    logger.warn("Invalid Slack signature");
    return c.text("Invalid signature", 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.text("Invalid JSON", 400);
  }

  const parsed = body as { type?: string; challenge?: string; event?: unknown; team_id?: string };

  if (parsed.type === "url_verification" && parsed.challenge) {
    return c.text(parsed.challenge);
  }

  const db = getDb();

  const instanceId = "inst_placeholder";

  try {
    await db.insert(schema.event).values({
      instanceId,
      type: `slack.${parsed.event && typeof parsed.event === "object" && "type" in parsed.event ? parsed.event.type : "unknown"}`,
      payload: body as Record<string, unknown>,
    });
  } catch (error) {
    logger.error("Failed to save Slack event", error);
  }

  return c.text("ok");
});

slackApp.get("/health", (c) => {
  return c.json({ status: "ok" });
});
