/**
 * Slack Webhook Router
 *
 * Handles incoming Slack webhooks forwarded from the OS backend.
 * Routes per Slack thread and forwards formatted messages.
 *
 * Message cases:
 * 1. New thread @mention - Bot mentioned at the start of a new thread
 * 2. Mid-thread @mention - Bot mentioned in an existing thread (joining conversation)
 * 3. FYI message - No mention, but agent already exists for this thread
 */
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { and, eq, isNull } from "drizzle-orm";
import type {
  AppMentionEvent,
  GenericMessageEvent,
  BotMessageEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
} from "@slack/types";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import type { IterateEvent } from "../types/events.ts";

const logger = console;
const DAEMON_BASE_URL = "http://localhost:3000";

export const slackRouter = new Hono();

// Middleware to log request and response bodies
slackRouter.use("*", async (c, next) => {
  const reqBody = await c.req.raw.clone().text();
  console.log(`[daemon/slack] REQ ${c.req.method} ${c.req.path}`, reqBody);

  await next();

  const resBody = await c.res.clone().text();
  console.log(`[daemon/slack] RES ${c.res.status}`, resBody);
});

async function agentExists(agentPath: string): Promise<boolean> {
  const existing = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.path, agentPath), isNull(schema.agents.archivedAt)))
    .limit(1);
  return Boolean(existing[0]);
}

async function sendToAgentGateway(
  agentPath: string,
  event: IterateEvent,
): Promise<{ wasCreated: boolean; route?: string | null }> {
  const response = await fetch(`${DAEMON_BASE_URL}/api/agents${agentPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  const body = (await response.json()) as {
    wasCreated?: boolean;
    route?: string | null;
  };

  if (!response.ok) {
    throw new Error(`Agent gateway failed: ${response.status}`);
  }

  return { wasCreated: body.wasCreated ?? false, route: body.route ?? null };
}

// Slack webhook envelope structure
interface SlackWebhookPayload {
  token?: string;
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  type: "event_callback" | "url_verification";
  event:
    | AppMentionEvent
    | GenericMessageEvent
    | BotMessageEvent
    | ReactionAddedEvent
    | ReactionRemovedEvent;
  authorizations?: Array<{
    enterprise_id: string | null;
    team_id: string;
    user_id: string;
    is_bot: boolean;
    is_enterprise_install: boolean;
  }>;
}

type MessageCase =
  | "new_thread_mention"
  | "mid_thread_mention"
  | "fyi_message"
  | "reaction_added"
  | "reaction_removed"
  | "ignored";

interface ParsedMessage {
  case: Exclude<MessageCase, "ignored" | "reaction_added" | "reaction_removed">;
  event: AppMentionEvent | GenericMessageEvent;
  threadTs: string;
}

interface ParsedReaction {
  case: "reaction_added" | "reaction_removed";
  event: ReactionAddedEvent | ReactionRemovedEvent;
  /** The ts of the message that was reacted to (need to look up thread_ts) */
  itemTs: string;
  channel: string;
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

  // Handle reaction events - need to look up the thread_ts from the original message
  if (parsed.case === "reaction_added" || parsed.case === "reaction_removed") {
    try {
      const threadTs = await lookupThreadTsForMessage(parsed.channel, parsed.itemTs);
      if (!threadTs) {
        return c.json({
          success: true,
          message: "Ignored: could not find thread for reacted message",
          eventId,
        });
      }

      const agentPath = getAgentPath(threadTs);
      const hasAgent = await agentExists(agentPath);

      if (!hasAgent) {
        return c.json({
          success: true,
          message: "Ignored: no agent for this thread",
          eventId,
        });
      }

      const message = formatReactionMessage(parsed.event, parsed.case, threadTs, eventId);
      await sendToAgentGateway(agentPath, { type: "prompt", message });
      return c.json({ success: true, agentPath, created: false, case: parsed.case, eventId });
    } catch (error) {
      logger.error("[Slack Webhook] Failed to handle reaction event", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  }

  // From here on, parsed is a ParsedMessage (not a reaction)
  const { event, threadTs } = parsed as ParsedMessage;
  const agentPath = getAgentPath(threadTs);

  try {
    const hasAgent = await agentExists(agentPath);

    // Case 1: New thread @mention - create agent and start fresh conversation
    if (parsed.case === "new_thread_mention") {
      if (hasAgent) {
        // Rare: agent already exists for what we think is a new thread
        const message = formatMidThreadMentionMessage(event, threadTs, eventId);
        const { wasCreated } = await sendToAgentGateway(agentPath, { type: "prompt", message });
        return c.json({
          success: true,
          agentPath,
          created: wasCreated,
          case: "mid_thread_mention",
          eventId,
        });
      }

      const message = formatNewThreadMentionMessage(event, threadTs, eventId);
      const { wasCreated } = await sendToAgentGateway(agentPath, { type: "prompt", message });
      return c.json({
        success: true,
        agentPath,
        created: wasCreated,
        case: "new_thread_mention",
        eventId,
      });
    }

    // Case 2: Mid-thread @mention - create agent if needed, join existing conversation
    if (parsed.case === "mid_thread_mention") {
      const message = formatMidThreadMentionMessage(event, threadTs, eventId);
      const { wasCreated } = await sendToAgentGateway(agentPath, { type: "prompt", message });
      return c.json({
        success: true,
        agentPath,
        created: wasCreated,
        case: "mid_thread_mention",
        eventId,
      });
    }

    // Case 3: FYI message - only forward if agent already exists
    if (parsed.case === "fyi_message") {
      if (!hasAgent) {
        return c.json({
          success: true,
          message: "Ignored: no mention and no existing agent",
          eventId,
        });
      }

      const message = formatFyiMessage(event, threadTs, eventId);
      const { wasCreated } = await sendToAgentGateway(agentPath, { type: "prompt", message });
      return c.json({
        success: true,
        agentPath,
        created: wasCreated,
        case: "fyi_message",
        eventId,
      });
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
): ParsedMessage | ParsedReaction | { case: "ignored"; reason: string } {
  const event = payload.event;
  const botUserId = payload.authorizations?.find((a) => a.is_bot)?.user_id;

  // Handle reaction events
  if (event.type === "reaction_added" || event.type === "reaction_removed") {
    // Only handle reactions on messages
    if (event.item.type !== "message") {
      return { case: "ignored", reason: "Ignored: reaction not on message" };
    }
    // Ignore the bot's own reactions
    if (event.user === botUserId) {
      return { case: "ignored", reason: "Ignored: bot's own reaction" };
    }
    return {
      case: event.type,
      event,
      itemTs: event.item.ts,
      channel: event.item.channel,
    };
  }

  // Ignore bot messages (our own responses echoed back)
  if ("bot_profile" in event && event.bot_profile) {
    return { case: "ignored", reason: "Ignored: bot message" };
  }
  if ("subtype" in event && event.subtype === "bot_message") {
    return { case: "ignored", reason: "Ignored: bot message" };
  }

  // Ignore regular message events when the bot is mentioned - app_mention handles those
  // Slack sends both app_mention and message events for the same @mention
  if (event.type === "message" && "text" in event && event.text && botUserId) {
    const mentionPattern = new RegExp(`<@${botUserId}>`);
    if (mentionPattern.test(event.text)) {
      // actually maybe it doesn't.
      // todo: smart deduplication - check if this is actually a duplicate of an app_mention event
      // return { case: "ignored", reason: "Ignored: duplicate of app_mention event" };
    }
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
  const isMention = event.type === "app_mention" || event.text?.includes(`<@${botUserId}>`);

  // Determine case
  let messageCase: Exclude<MessageCase, "reaction_added" | "reaction_removed">;
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
 * Sanitize Slack timestamp for use as a path segment.
 * Slack timestamps: "1234567890.123456" → "1234567890-123456"
 */
function sanitizeThreadId(ts: string): string {
  return ts.replace(/\./g, "-");
}

function getAgentPath(threadTs: string): string {
  return `/slack/${sanitizeThreadId(threadTs)}`;
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
  const agentSlug = `slack-${sanitizeThreadId(threadTs)}`;

  return [
    `[Agent: ${agentSlug}] New Slack thread started.`,
    `Refer to SLACK.md for how to respond via \`iterate tool slack\`.`,
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
  const messageTs = event.ts || threadTs;
  const agentSlug = `slack-${sanitizeThreadId(threadTs)}`;

  const lines = [
    `[Agent: ${agentSlug}] You've been @mentioned in thread ${threadTs}.`,
    `Refer to SLACK.md for how to respond via \`iterate tool slack\`.`,
    "",
    `From: ${user}`,
    `Message: ${text}`,
    "",
  ];

  // Only show message_ts if different from thread_ts (i.e., this is a reply, not the root)
  if (messageTs !== threadTs) {
    lines.push(
      `channel=${channel} thread_ts=${threadTs} message_ts=${messageTs} eventId=${eventId}`,
    );
  } else {
    lines.push(`channel=${channel} thread_ts=${threadTs} eventId=${eventId}`);
  }

  return lines.join("\n");
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
  const messageTs = event.ts || threadTs;

  const lines = [
    `Another message in thread ${threadTs} (FYI, no @mention).`,
    "",
    `From: ${user}`,
    `Message: ${text}`,
    "",
  ];

  // Only show message_ts if different from thread_ts
  if (messageTs !== threadTs) {
    lines.push(
      `channel=${channel} thread_ts=${threadTs} message_ts=${messageTs} eventId=${eventId}`,
    );
  } else {
    lines.push(`channel=${channel} thread_ts=${threadTs} eventId=${eventId}`);
  }

  return lines.join("\n");
}

/**
 * Format message for reaction events.
 */
function formatReactionMessage(
  event: ReactionAddedEvent | ReactionRemovedEvent,
  reactionCase: "reaction_added" | "reaction_removed",
  threadTs: string,
  eventId: string,
): string {
  const user = event.user ? `<@${event.user}>` : "unknown";
  const action = reactionCase === "reaction_added" ? "added" : "removed";
  const channel = event.item.type === "message" ? event.item.channel : "unknown";
  const messageTs = event.item.type === "message" ? event.item.ts : "unknown";

  const lines = [
    `Reaction ${action} in thread ${threadTs}: :${event.reaction}:`,
    "",
    `From: ${user}`,
  ];

  // Only show message_ts if different from thread_ts
  if (messageTs !== threadTs) {
    lines.push(`On message: ${messageTs}`);
  }

  lines.push("");
  if (messageTs !== threadTs) {
    lines.push(
      `channel=${channel} thread_ts=${threadTs} message_ts=${messageTs} eventId=${eventId}`,
    );
  } else {
    lines.push(`channel=${channel} thread_ts=${threadTs} eventId=${eventId}`);
  }

  return lines.join("\n");
}

/**
 * Look up the thread_ts for a message by querying stored events.
 * Reactions only give us the message ts, but we need the thread_ts to find the agent.
 */
async function lookupThreadTsForMessage(
  channel: string,
  messageTs: string,
): Promise<string | null> {
  // Search for a stored event that matches this channel and message ts
  // The message could be the thread root (ts === thread_ts) or a reply (has thread_ts)
  const events = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.type, "slack:webhook"));

  for (const evt of events) {
    const payload = evt.payload as SlackWebhookPayload | null;
    if (!payload?.event) continue;

    const event = payload.event;

    // Skip reaction events
    if (event.type === "reaction_added" || event.type === "reaction_removed") continue;

    // Check if this event matches our channel and ts
    if (
      "channel" in event &&
      event.channel === channel &&
      "ts" in event &&
      event.ts === messageTs
    ) {
      // Found the message - return its thread_ts (or ts if it's the root)
      return "thread_ts" in event && event.thread_ts ? event.thread_ts : messageTs;
    }
  }

  return null;
}
