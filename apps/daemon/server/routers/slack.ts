/**
 * Slack Webhook Router
 *
 * Handles incoming Slack webhooks forwarded from the OS backend.
 * Routes per Slack thread and forwards formatted messages.
 */
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type {
  AppMentionEvent,
  GenericMessageEvent,
  BotMessageEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
} from "@slack/types";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { activeAgentExists, sendToAgentGateway } from "../utils/agent-gateway.ts";
import { registerSlackWork } from "../services/slack-stream-consumer.ts";

const logger = console;

export const slackRouter = new Hono();

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
  itemTs: string;
  channel: string;
}

slackRouter.use("*", async (c, next) => {
  const reqBody = await c.req.raw.clone().text();
  logger.log(`[daemon/slack] REQ ${c.req.method} ${c.req.path}`, reqBody);

  await next();

  const resBody = await c.res.clone().text();
  logger.log(`[daemon/slack] RES ${c.res.status}`, resBody);
});

slackRouter.post("/webhook", async (c) => {
  const requestId = c.req.header("x-iterate-request-id") ?? `daemon-${nanoid(10)}`;
  const payload = (await c.req.json()) as SlackWebhookPayload;
  const slackEventId = payload.event_id;

  const eventId = await storeEvent(payload, slackEventId);
  const parsed = parseWebhookPayload(payload);

  if (parsed.case === "ignored") {
    return c.json({ success: true, message: parsed.reason, eventId, requestId });
  }

  if (parsed.case === "reaction_added" || parsed.case === "reaction_removed") {
    const threadTs = await lookupThreadTsForMessage(parsed.channel, parsed.itemTs);
    if (!threadTs) {
      return c.json({
        success: true,
        message: "Ignored: could not find thread for reacted message",
        eventId,
        requestId,
      });
    }

    const hasAgent = await activeAgentExists(getAgentPath(threadTs));
    if (!hasAgent) {
      return c.json({
        success: true,
        message: "Ignored: no agent for this thread",
        eventId,
        requestId,
      });
    }

    void handleSlackWebhookAsync({
      parsed,
      eventId,
      requestId,
      precomputedThreadTs: threadTs,
      precomputedHasAgent: hasAgent,
    }).catch((error) => {
      logger.error("[Slack Webhook] Failed to handle webhook", { error, eventId, requestId });
    });
    return c.json({
      success: true,
      queued: true,
      created: false,
      case: parsed.case,
      eventId,
      requestId,
    });
  }

  const hasAgent = await activeAgentExists(getAgentPath(parsed.threadTs));
  if (parsed.case === "fyi_message" && !hasAgent) {
    return c.json({
      success: true,
      message: "Ignored: no mention and no existing agent",
      eventId,
      requestId,
    });
  }

  const responseCase =
    parsed.case === "new_thread_mention" && hasAgent ? "mid_thread_mention" : parsed.case;
  const created =
    parsed.case === "new_thread_mention" ? !hasAgent : parsed.case !== "fyi_message" && !hasAgent;

  // Process asynchronously so OS webhook forwarding does not time out.
  void handleSlackWebhookAsync({
    parsed,
    eventId,
    requestId,
    precomputedHasAgent: hasAgent,
  }).catch((error) => {
    logger.error("[Slack Webhook] Failed to handle webhook", { error, eventId, requestId });
  });
  return c.json({
    success: true,
    queued: true,
    created,
    case: responseCase,
    eventId,
    requestId,
  });
});

async function handleSlackWebhookAsync(params: {
  parsed: ParsedMessage | ParsedReaction;
  eventId: string;
  requestId: string;
  precomputedThreadTs?: string;
  precomputedHasAgent?: boolean;
}): Promise<void> {
  const { parsed, eventId, requestId, precomputedThreadTs, precomputedHasAgent } = params;

  // Reaction events: lookup the parent thread, then forward to the existing agent if present.
  if (parsed.case === "reaction_added" || parsed.case === "reaction_removed") {
    const threadTs =
      precomputedThreadTs ?? (await lookupThreadTsForMessage(parsed.channel, parsed.itemTs));
    if (!threadTs) {
      logger.log("[Slack Webhook] Ignored reaction: thread not found", { eventId, requestId });
      return;
    }

    const agentPath = getAgentPath(threadTs);
    const hasAgent = precomputedHasAgent ?? (await activeAgentExists(agentPath));
    if (!hasAgent) {
      logger.log("[Slack Webhook] Ignored reaction: no agent", { agentPath, eventId, requestId });
      return;
    }

    await registerSlackWork({
      agentPath,
      channel: parsed.channel,
      threadTs,
      emojiTimestamp: threadTs,
      emoji: "eyes",
      requestId,
    });

    const message = formatReactionMessage(parsed.event, parsed.case, threadTs, eventId);
    await sendToAgentGateway(agentPath, { type: "prompt", message });
    return;
  }

  const messageParsed = parsed as ParsedMessage;
  const { event, threadTs } = messageParsed;
  const agentPath = getAgentPath(threadTs);
  const hasAgent = precomputedHasAgent ?? (await activeAgentExists(agentPath));

  if (messageParsed.case === "new_thread_mention") {
    const messageTs = event.ts || threadTs;
    await registerSlackWork({
      agentPath,
      channel: event.channel || "",
      threadTs,
      emojiTimestamp: messageTs,
      emoji: "eyes",
      requestId,
    });

    const message = hasAgent
      ? formatMidThreadMentionMessage(event, threadTs, eventId)
      : formatNewThreadMentionMessage(event, threadTs, eventId);
    await sendToAgentGateway(agentPath, { type: "prompt", message });
    return;
  }

  if (messageParsed.case === "mid_thread_mention") {
    const messageTs = event.ts || threadTs;
    await registerSlackWork({
      agentPath,
      channel: event.channel || "",
      threadTs,
      emojiTimestamp: messageTs,
      emoji: "eyes",
      requestId,
    });

    const message = formatMidThreadMentionMessage(event, threadTs, eventId);
    await sendToAgentGateway(agentPath, { type: "prompt", message });
    return;
  }

  if (messageParsed.case === "fyi_message") {
    if (!hasAgent) {
      logger.log("[Slack Webhook] Ignored FYI: no existing agent", { eventId, requestId });
      return;
    }

    await registerSlackWork({
      agentPath,
      channel: event.channel || "",
      threadTs,
      emojiTimestamp: threadTs,
      emoji: "thinking_face",
      requestId,
    });

    const message = formatFyiMessage(event, threadTs, eventId);
    await sendToAgentGateway(agentPath, { type: "prompt", message });
    return;
  }
}

function parseWebhookPayload(
  payload: SlackWebhookPayload,
): ParsedMessage | ParsedReaction | { case: "ignored"; reason: string } {
  const event = payload.event;
  const botUserId = payload.authorizations?.find((a) => a.is_bot)?.user_id;

  if (event.type === "reaction_added" || event.type === "reaction_removed") {
    if (event.item.type !== "message") {
      return { case: "ignored", reason: "Ignored: reaction not on message" };
    }
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

  if ("bot_profile" in event && event.bot_profile) {
    return { case: "ignored", reason: "Ignored: bot message" };
  }
  if ("subtype" in event && event.subtype === "bot_message") {
    return { case: "ignored", reason: "Ignored: bot message" };
  }

  if (!botUserId) {
    return { case: "ignored", reason: "Ignored: no bot user recipient" };
  }

  const threadTs = event.thread_ts || event.ts;
  if (!threadTs) {
    return { case: "ignored", reason: "Ignored: no thread timestamp" };
  }

  const isNewThread = !event.thread_ts;
  const isMention = event.type === "app_mention" || event.text?.includes(`<@${botUserId}>`);

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

function sanitizeThreadId(ts: string): string {
  return ts.replace(/\./g, "-");
}

function getAgentPath(threadTs: string): string {
  return `/slack/${sanitizeThreadId(threadTs)}`;
}

async function storeEvent(payload: SlackWebhookPayload, slackEventId?: string): Promise<string> {
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

function formatFileLines(files: GenericMessageEvent["files"] | AppMentionEvent["files"]): string[] {
  if (!files) return [];
  return files.map((file) => {
    if ("url_private" in file) return `File url_private: ${file.url_private}`;
    return `File id: ${file.id}`;
  });
}

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
    "Refer to SLACK.md for how to respond via `iterate tool slack`.",
    "",
    `From: ${user}`,
    `Message: ${text}`,
    ...formatFileLines(event.files),
    "",
    `channel=${channel} thread_ts=${threadTs} eventId=${eventId}`,
  ].join("\n");
}

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
    "Refer to SLACK.md for how to respond via `iterate tool slack`.",
    "",
    `From: ${user}`,
    `Message: ${text}`,
    ...formatFileLines(event.files),
    "",
  ];

  if (messageTs !== threadTs) {
    lines.push(
      `channel=${channel} thread_ts=${threadTs} message_ts=${messageTs} eventId=${eventId}`,
    );
  } else {
    lines.push(`channel=${channel} thread_ts=${threadTs} eventId=${eventId}`);
  }

  return lines.join("\n");
}

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
    ...formatFileLines(event.files),
    "",
  ];

  if (messageTs !== threadTs) {
    lines.push(
      `channel=${channel} thread_ts=${threadTs} message_ts=${messageTs} eventId=${eventId}`,
    );
  } else {
    lines.push(`channel=${channel} thread_ts=${threadTs} eventId=${eventId}`);
  }

  return lines.join("\n");
}

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

async function lookupThreadTsForMessage(
  channel: string,
  messageTs: string,
): Promise<string | null> {
  const events = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.type, "slack:webhook"));

  for (const evt of events) {
    const payload = evt.payload as SlackWebhookPayload | null;
    if (!payload?.event) continue;

    const event = payload.event;
    if (event.type === "reaction_added" || event.type === "reaction_removed") continue;

    if (
      "channel" in event &&
      event.channel === channel &&
      "ts" in event &&
      event.ts === messageTs
    ) {
      return "thread_ts" in event && event.thread_ts ? event.thread_ts : messageTs;
    }
  }

  return null;
}
