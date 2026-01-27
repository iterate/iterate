/**
 * Slack Webhook Router
 *
 * Handles incoming Slack webhooks forwarded from the OS backend.
 * Creates/reuses agents per Slack thread and sends formatted messages.
 *
 * Message cases:
 * 1. New thread @mention - Bot mentioned at the start of a new thread
 * 2. Mid-thread @mention - Bot mentioned in an existing thread (joining conversation)
 * 3. FYI message - No mention, but agent already exists for this thread
 */
import { Hono } from "hono";
import { nanoid } from "nanoid";
import type {
  AppMentionEvent,
  GenericMessageEvent,
  BotMessageEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
} from "@slack/types";
import { storeEvent, eventExists, findThreadTs } from "./db.ts";

const DAEMON_URL = process.env.ITERATE_PROJECT_BASE_URL || "http://localhost:3000";
const FALLBACK_REPO = process.env.ITERATE_REPO || "/home/iterate/src/github.com/iterate/iterate";

/**
 * Get the working directory for new agents.
 * Prefers customer repo (from platform service), falls back to ITERATE_REPO.
 */
async function getAgentWorkingDirectory(): Promise<string> {
  try {
    const res = await fetch(`${DAEMON_URL}/api/trpc/getCustomerRepoPath`);
    const json = (await res.json()) as { result?: { data: { path: string | null } } };
    const customerPath = json.result?.data?.path;
    if (customerPath) return customerPath;
  } catch (err) {
    console.error("[slack] Failed to get customer repo path:", err);
  }
  return FALLBACK_REPO;
}

export const slackRouter = new Hono();

// Middleware to log request and response bodies
slackRouter.use("*", async (c, next) => {
  const reqBody = await c.req.raw.clone().text();
  console.log(`[slack] REQ ${c.req.method} ${c.req.path}`, reqBody);

  await next();

  const resBody = await c.res.clone().text();
  console.log(`[slack] RES ${c.res.status}`, resBody);
});

// ============ tRPC helpers (inline fetch, no abstraction) ============

interface Agent {
  id: string;
  slug: string;
  status: string;
}

async function getAgent(slug: string): Promise<Agent | null> {
  const url = `${DAEMON_URL}/api/trpc/getAgent?input=${encodeURIComponent(JSON.stringify({ slug }))}`;
  const res = await fetch(url);
  const json = (await res.json()) as { result?: { data: Agent | null } };
  return json.result?.data ?? null;
}

async function createAgent(params: {
  slug: string;
  harnessType: string;
  workingDirectory: string;
}): Promise<Agent> {
  const res = await fetch(`${DAEMON_URL}/api/trpc/createAgent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as { result?: { data: Agent } };
  if (!json.result?.data) throw new Error("Failed to create agent");
  return json.result.data;
}

async function appendToAgent(slug: string, message: string): Promise<void> {
  // Uses the agent's stdin via tRPC - this maps to startAgent with initialPrompt
  // For now, we'll use startAgent which sends the message
  await fetch(`${DAEMON_URL}/api/trpc/startAgent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, initialPrompt: message }),
  });
}

// ============ Types ============

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

// ============ Route ============

slackRouter.post("/webhook", async (c) => {
  const payload = (await c.req.json()) as SlackWebhookPayload;

  console.log(`[slack] Received payload`, payload);

  // Dedupe by Slack event_id
  const slackEventId = payload.event_id;
  if (slackEventId && eventExists(slackEventId)) {
    return c.json({ success: true, message: "Duplicate event", slackEventId });
  }

  // Store the raw event
  const eventId = `evt_${nanoid(12)}`;
  const event = payload.event;
  const channel = "channel" in event ? event.channel : null;
  const threadTs = "thread_ts" in event ? event.thread_ts : "ts" in event ? event.ts : null;
  storeEvent(eventId, slackEventId ?? null, channel ?? null, threadTs ?? null, payload);

  const parsed = parseWebhookPayload(payload);

  // Handle ignored cases
  if (parsed.case === "ignored") {
    return c.json({ success: true, message: parsed.reason, eventId });
  }

  // Handle reaction events
  if (parsed.case === "reaction_added" || parsed.case === "reaction_removed") {
    try {
      const reactionThreadTs = findThreadTs(parsed.channel, parsed.itemTs);
      if (!reactionThreadTs) {
        return c.json({
          success: true,
          message: "Ignored: could not find thread for reacted message",
          eventId,
        });
      }

      const threadId = sanitizeThreadId(reactionThreadTs);
      const agentSlug = `slack-${threadId}`;
      const existingAgent = await getAgent(agentSlug);

      if (!existingAgent) {
        return c.json({
          success: true,
          message: "Ignored: no agent for this thread",
          eventId,
        });
      }

      const message = formatReactionMessage(parsed.event, parsed.case, reactionThreadTs, eventId);
      await appendToAgent(agentSlug, message);
      return c.json({
        success: true,
        agentSlug,
        created: false,
        case: parsed.case,
        eventId,
      });
    } catch (error) {
      console.error("[slack] Failed to handle reaction event", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  }

  // From here on, parsed is a ParsedMessage (not a reaction)
  const { event: msgEvent, threadTs: msgThreadTs } = parsed as ParsedMessage;
  const threadId = sanitizeThreadId(msgThreadTs);
  const agentSlug = `slack-${threadId}`;

  try {
    const existingAgent = await getAgent(agentSlug);

    // Case 1: New thread @mention - create agent and start fresh conversation
    if (parsed.case === "new_thread_mention") {
      if (existingAgent) {
        const message = formatMidThreadMentionMessage(msgEvent, msgThreadTs, eventId);
        await appendToAgent(agentSlug, message);
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
        workingDirectory: await getAgentWorkingDirectory(),
      });

      const message = formatNewThreadMentionMessage(msgEvent, msgThreadTs, eventId);
      await appendToAgent(agent.slug, message);
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
          workingDirectory: await getAgentWorkingDirectory(),
        });
        wasCreated = true;
      }

      const message = formatMidThreadMentionMessage(msgEvent, msgThreadTs, eventId);
      await appendToAgent(agent.slug, message);
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

      const message = formatFyiMessage(msgEvent, msgThreadTs, eventId);
      await appendToAgent(agentSlug, message);
      return c.json({
        success: true,
        agentSlug,
        created: false,
        case: "fyi_message",
        eventId,
      });
    }

    return c.json({ error: "Unknown message case" }, 500);
  } catch (error) {
    console.error("[slack] Failed to handle webhook", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ============ Helpers ============

function parseWebhookPayload(
  payload: SlackWebhookPayload,
): ParsedMessage | ParsedReaction | { case: "ignored"; reason: string } {
  const event = payload.event;
  const botUserId = payload.authorizations?.find((a) => a.is_bot)?.user_id;

  // Handle reaction events
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

  // Ignore bot messages
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

function formatReactionMessage(
  event: ReactionAddedEvent | ReactionRemovedEvent,
  reactionCase: "reaction_added" | "reaction_removed",
  threadTs: string,
  eventId: string,
): string {
  const user = event.user ? `<@${event.user}>` : "unknown";
  const action = reactionCase === "reaction_added" ? "added" : "removed";
  const channel = event.item.type === "message" ? event.item.channel : "unknown";

  return [
    `Reaction ${action}: :${event.reaction}:`,
    "",
    `From: ${user}`,
    `On message: ${event.item.type === "message" ? event.item.ts : "unknown"}`,
    "",
    `channel=${channel} thread_ts=${threadTs} eventId=${eventId}`,
  ].join("\n");
}
