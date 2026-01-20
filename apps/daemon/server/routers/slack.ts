/**
 * Slack Webhook Router
 *
 * Handles incoming Slack webhooks forwarded from the OS backend.
 * Creates/reuses agents per Slack thread and sends formatted messages.
 * Uses the harness system for SDK-based session management.
 *
 * Message cases:
 * 1. New thread @mention - Bot mentioned at the start of a new thread
 * 2. Mid-thread @mention - Bot mentioned in an existing thread (joining conversation)
 * 3. FYI message - No mention, but agent already exists for this thread
 */
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { AppMentionEvent, GenericMessageEvent, BotMessageEvent } from "@slack/types";
import { getAgent, createAgent, appendToAgent } from "../services/agent-manager.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";

const logger = console;

// Working directory for agents - uses ITERATE_REPO env var with fallback to sandbox path
const ITERATE_REPO = process.env.ITERATE_REPO || "/home/iterate/src/github.com/iterate/iterate";

export const slackRouter = new Hono();

// Slack webhook envelope structure
interface SlackWebhookPayload {
  token?: string;
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  type: "event_callback" | "url_verification";
  event: AppMentionEvent | GenericMessageEvent | BotMessageEvent;
  authorizations?: Array<{
    enterprise_id: string | null;
    team_id: string;
    user_id: string;
    is_bot: boolean;
    is_enterprise_install: boolean;
  }>;
}

type MessageCase = "new_thread_mention" | "mid_thread_mention" | "fyi_message" | "ignored";

interface ParsedMessage {
  case: Exclude<MessageCase, "ignored">;
  event: AppMentionEvent | GenericMessageEvent;
  threadTs: string;
}

slackRouter.post("/webhook", async (c) => {
  const payload = (await c.req.json()) as SlackWebhookPayload;

  console.log(`[daemon/slack] Received payload`, payload);

  // Store the raw event for later inspection
  const slackEventId = payload.event_id;
  const eventId = await storeEvent(payload, slackEventId);

  const parsed = parseWebhookPayload(payload);

  // Handle ignored cases
  if (parsed.case === "ignored") {
    return c.json({ success: true, message: parsed.reason, eventId });
  }

  const { event, threadTs } = parsed;
  const threadId = sanitizeThreadId(threadTs);
  const agentSlug = `slack-${threadId}`;

  try {
    const existingAgent = await getAgent(agentSlug);

    // Case 1: New thread @mention - create agent and start fresh conversation
    if (parsed.case === "new_thread_mention") {
      if (existingAgent) {
        // Rare: agent already exists for what we think is a new thread
        const message = formatMidThreadMentionMessage(event, threadTs, eventId);
        await appendToAgent(existingAgent, message);
        return c.json({
          success: true,
          agentSlug,
          created: false,
          case: "mid_thread_mention",
          eventId,
        });
      }

      const agent = await createAgent({
        slug: agentSlug,
        harnessType: "opencode",
        workingDirectory: ITERATE_REPO,
      });

      const message = formatNewThreadMentionMessage(event, threadTs, eventId);
      await appendToAgent(agent, message);
      return c.json({
        success: true,
        agentSlug,
        created: true,
        case: "new_thread_mention",
        eventId,
      });
    }

    // Case 2: Mid-thread @mention - create agent if needed, join existing conversation
    if (parsed.case === "mid_thread_mention") {
      let agent = existingAgent;
      let wasCreated = false;

      if (!agent) {
        agent = await createAgent({
          slug: agentSlug,
          harnessType: "opencode",
          workingDirectory: ITERATE_REPO,
        });
        wasCreated = true;
      }

      const message = formatMidThreadMentionMessage(event, threadTs, eventId);
      await appendToAgent(agent, message);
      return c.json({
        success: true,
        agentSlug,
        created: wasCreated,
        case: "mid_thread_mention",
        eventId,
      });
    }

    // Case 3: FYI message - only forward if agent already exists
    if (parsed.case === "fyi_message") {
      if (!existingAgent) {
        return c.json({
          success: true,
          message: "Ignored: no mention and no existing agent",
          eventId,
        });
      }

      const message = formatFyiMessage(event, threadTs, eventId);
      await appendToAgent(existingAgent, message);
      return c.json({ success: true, agentSlug, created: false, case: "fyi_message", eventId });
    }

    // Should never reach here
    return c.json({ error: "Unknown message case" }, 500);
  } catch (error) {
    logger.error("[Slack Webhook] Failed to handle webhook", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Parse webhook payload and determine the message case.
 */
function parseWebhookPayload(
  payload: SlackWebhookPayload,
): ParsedMessage | { case: "ignored"; reason: string } {
  const event = payload.event;
  const botUserId = payload.authorizations?.find((a) => a.is_bot)?.user_id;

  // Ignore bot messages (our own responses echoed back)
  if ("bot_profile" in event && event.bot_profile) {
    return { case: "ignored", reason: "Ignored: bot message" };
  }
  if ("subtype" in event && event.subtype === "bot_message") {
    return { case: "ignored", reason: "Ignored: bot message" };
  }

  // Ignore messages without bot authorization
  if (!botUserId) {
    return { case: "ignored", reason: "Ignored: no bot user recipient" };
  }

  // Determine thread timestamp
  // If it's a reply, use thread_ts (parent message timestamp)
  // Otherwise use ts (this message becomes the thread root)
  const threadTs = event.thread_ts || event.ts;
  if (!threadTs) {
    return { case: "ignored", reason: "Ignored: no thread timestamp" };
  }

  // Is this a new thread or a reply to an existing thread?
  const isNewThread = !event.thread_ts;

  // Is the bot mentioned?
  const isMention = event.type === "app_mention";

  // Determine case
  let messageCase: MessageCase;
  if (isMention && isNewThread) {
    messageCase = "new_thread_mention";
  } else if (isMention && !isNewThread) {
    messageCase = "mid_thread_mention";
  } else {
    messageCase = "fyi_message";
  }

  return {
    case: messageCase,
    event: event as AppMentionEvent | GenericMessageEvent,
    threadTs,
  };
}

/**
 * Sanitize Slack timestamp for use as slug.
 * Slack timestamps: "1234567890.123456" → "1234567890-123456"
 */
function sanitizeThreadId(ts: string): string {
  return ts.replace(/\./g, "-");
}

/**
 * Store the raw webhook event in SQLite for later inspection.
 * Uses Slack's event_id for deduplication - if already stored, returns existing ID.
 */
async function storeEvent(payload: SlackWebhookPayload, slackEventId?: string): Promise<string> {
  // Check for existing event with same Slack event_id (dedup)
  if (slackEventId) {
    const existing = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.externalId, slackEventId))
      .limit(1);
    if (existing[0]) {
      return existing[0].id;
    }
  }

  const eventId = `evt_${nanoid(12)}`;
  await db.insert(schema.events).values({
    id: eventId,
    type: "slack:webhook",
    externalId: slackEventId,
    payload: payload as unknown as Record<string, unknown>,
  });

  return eventId;
}

/**
 * Format message for a new thread @mention.
 * This is a fresh conversation - provide full context.
 */
function formatNewThreadMentionMessage(
  event: AppMentionEvent | GenericMessageEvent,
  threadTs: string,
  eventId: string,
): string {
  const user = event.user ? `<@${event.user}>` : "unknown";
  const channel = event.channel || "unknown";
  const text = event.text || "(no text)";

  return [
    `You've been mentioned to start a new conversation.`,
    "",
    `From: ${user}`,
    `Message: ${text}`,
    "",
    `channel=${channel} thread_ts=${threadTs} eventId=${eventId}`,
  ].join("\n");
}

/**
 * Format message for a mid-thread @mention.
 * Bot is being called into an existing conversation.
 */
function formatMidThreadMentionMessage(
  event: AppMentionEvent | GenericMessageEvent,
  threadTs: string,
  eventId: string,
): string {
  const user = event.user ? `<@${event.user}>` : "unknown";
  const channel = event.channel || "unknown";
  const text = event.text || "(no text)";

  return [
    `You've been mentioned in an existing thread.`,
    "",
    `From: ${user}`,
    `Message: ${text}`,
    "",
    `channel=${channel} thread_ts=${threadTs} eventId=${eventId}`,
  ].join("\n");
}

/**
 * Format message for FYI (no mention but agent exists).
 * Another message in a thread the agent is participating in.
 */
function formatFyiMessage(
  event: AppMentionEvent | GenericMessageEvent,
  threadTs: string,
  eventId: string,
): string {
  const user = event.user ? `<@${event.user}>` : "unknown";
  const channel = event.channel || "unknown";
  const text = event.text || "(no text)";

  return [
    `FYI: Another message in this thread (you were not @mentioned).`,
    "",
    `From: ${user}`,
    `Message: ${text}`,
    "",
    `channel=${channel} thread_ts=${threadTs} eventId=${eventId}`,
  ].join("\n");
}
