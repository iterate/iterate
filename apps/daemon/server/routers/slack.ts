/**
 * Slack Webhook Router
 *
 * Handles incoming Slack webhooks forwarded from the OS backend.
 * One agent per Slack thread, keyed by thread_ts.
 *
 * Flow:
 *   1. OS worker receives Slack event, forwards to POST /webhook
 *   2. We parse & classify (mention / FYI / reaction / ignored)
 *   3. For mentions: getOrCreateAgent(agentPath)
 *      For FYI / reactions: getAgent — skip if no agent exists
 *   4. If agent is newly created, subscribe to agent-change callbacks
 *   5. Add emoji reaction (eyes) to the triggering Slack message
 *   6. Fire-and-forget prompt to the agent via /api/agents/:path
 *   7. Agent-change callback fires as agent works:
 *      - isWorking=true  → ensure emoji is on, set thread status
 *      - isWorking=false → remove emoji, clear thread status
 *
 * Structurally symmetric with webchat.ts and email.ts — if you change the
 * pattern in one, update the others to match.
 */
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { x } from "tinyexec";
import type {
  AppMentionEvent,
  GenericMessageEvent,
  BotMessageEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
} from "@slack/types";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { trpcRouter } from "../trpc/router.ts";

const logger = console;

export const slackRouter = new Hono();

/**
 * Per-agent Slack thread context stored in memory.
 *
 * When a webhook arrives we add an emoji reaction (e.g. "eyes") to the
 * triggering Slack message and record the details here, keyed by agent path.
 * When the agent-change callback fires with `isWorking: false`, we use this
 * context to remove the reaction and clear the thread status.
 */
type SlackThreadContext = {
  channel: string;
  threadTs: string;
  /** The `ts` of the Slack message we reacted to (so we can remove the reaction later). */
  emojiTimestamp: string;
  /** The emoji name we added (e.g. "eyes", "thinking_face"). */
  emoji: string;
  requestId?: string;
};

const slackThreadContextByAgentPath = new Map<string, SlackThreadContext>();
const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;
const AGENT_ROUTER_BASE_URL = `${DAEMON_BASE_URL}/api/agents`;
const SLACK_AGENT_CHANGE_CALLBACK_URL = `${DAEMON_BASE_URL}/api/integrations/slack/agent-change-callback`;

/**
 * We consume `iterate:agent-updated` events delivered to the callback URL.
 * This is currently the only event type. In the future, other iterate-level
 * or raw OpenCode events may be delivered on this same callback channel.
 */
const AgentUpdatedEvent = z.object({
  type: z.literal("iterate:agent-updated"),
  payload: z
    .object({
      path: z.string(),
      shortStatus: z.string(),
      isWorking: z.boolean(),
    })
    .passthrough(),
});

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

function isParsedReaction(parsed: ParsedMessage | ParsedReaction): parsed is ParsedReaction {
  return parsed.case === "reaction_added" || parsed.case === "reaction_removed";
}

slackRouter.use("*", async (c, next) => {
  const reqBody = await c.req.raw.clone().text();
  logger.log(`[daemon/slack] REQ ${c.req.method} ${c.req.path}`, reqBody);

  await next();

  const resBody = await c.res.clone().text();
  logger.log(`[daemon/slack] RES ${c.res.status}`, resBody);
});

/**
 * Main webhook handler. Follows the same pattern as webchat.ts:
 *
 *   1. Parse & classify the Slack event, store it.
 *   2. Compute agentPath from the thread timestamp.
 *   3. For @mentions: getOrCreateAgent  ->  wasNewlyCreated
 *      For FYI / reactions: getAgent    ->  skip if no agent exists
 *   4. If wasNewlyCreated, subscribe to agent-change callbacks (once per agent).
 *   5. Update slackThreadContextByAgentPath with emoji info.
 *   6. Fire-and-forget fetch to AGENT_ROUTER_BASE_URL + agentPath.
 */
slackRouter.post("/webhook", async (c) => {
  const requestId = c.req.header("x-iterate-request-id") ?? `daemon-${nanoid(10)}`;
  const payload = (await c.req.json()) as SlackWebhookPayload;
  const slackEventId = payload.event_id;

  const eventId = await storeEvent(payload, slackEventId);
  const parsed = parseWebhookPayload(payload);

  if (parsed.case === "ignored") {
    return c.json({ success: true, message: parsed.reason, eventId, requestId });
  }

  const caller = trpcRouter.createCaller({});

  // ── Reaction events ──
  // Reactions never create agents; they only forward to an existing one.
  if (isParsedReaction(parsed)) {
    const threadTs = await lookupThreadTsForMessage(parsed.channel, parsed.itemTs);
    if (!threadTs) {
      return c.json({
        success: true,
        message: "Ignored: could not find thread for reacted message",
        eventId,
        requestId,
      });
    }

    const agentPath = getAgentPath(threadTs);
    const agent = await caller.getAgent({ path: agentPath });
    if (!agent) {
      return c.json({
        success: true,
        message: "Ignored: no agent for this thread",
        eventId,
        requestId,
      });
    }

    const message = formatReactionMessage(parsed.event, parsed.case, threadTs, eventId);

    // Track emoji so callback can clear it when agent goes idle.
    slackThreadContextByAgentPath.set(agentPath, {
      channel: parsed.channel,
      threadTs,
      emojiTimestamp: threadTs,
      emoji: "eyes",
      requestId,
    });

    // Fire-and-forget prompt to the agent.
    void fetch(`${AGENT_ROUTER_BASE_URL}${agentPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "iterate:agent:prompt-added", message }),
    }).catch((error) => {
      logger.error(`[slack] failed to post reaction prompt for thread_ts=${threadTs}`, error);
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

  // ── Message events (mentions & FYI) ──

  const { event, threadTs } = parsed;
  const agentPath = getAgentPath(threadTs);
  const isMention = parsed.case === "new_thread_mention" || parsed.case === "mid_thread_mention";

  let wasNewlyCreated = false;

  if (isMention) {
    // Mentions always get-or-create an agent, matching the webchat pattern.
    const result = await caller.getOrCreateAgent({ agentPath, createWithEvents: [] });
    wasNewlyCreated = result.wasNewlyCreated;
  } else {
    // FYI messages (no @mention) in a thread — only forward if an agent already exists.
    const agent = await caller.getAgent({ path: agentPath });
    if (!agent) {
      return c.json({
        success: true,
        message: "Ignored: no mention and no existing agent",
        eventId,
        requestId,
      });
    }
  }

  // Subscribe to agent-change callbacks once, when the agent is first created.
  if (wasNewlyCreated) {
    void caller.subscribeToAgentChanges({
      agentPath,
      callbackUrl: SLACK_AGENT_CHANGE_CALLBACK_URL,
    });
  }

  const messageTs = event.ts || threadTs;
  const emoji = parsed.case === "fyi_message" ? "thinking_face" : "eyes";

  // Track emoji so the callback handler can remove it when the agent goes idle.
  slackThreadContextByAgentPath.set(agentPath, {
    channel: event.channel || "",
    threadTs,
    emojiTimestamp: messageTs,
    emoji,
    requestId,
  });

  // Build the formatted prompt for the agent.
  let message: string;
  if (parsed.case === "new_thread_mention" && wasNewlyCreated) {
    message = formatNewThreadMentionMessage(event, threadTs, eventId);
  } else if (parsed.case === "fyi_message") {
    message = formatFyiMessage(event, threadTs, eventId);
  } else {
    // mid_thread_mention, or new_thread_mention that hit an existing agent
    message = formatMidThreadMentionMessage(event, threadTs, eventId);
  }

  const responseCase =
    parsed.case === "new_thread_mention" && !wasNewlyCreated ? "mid_thread_mention" : parsed.case;

  // Fire-and-forget prompt to the agent, just like webchat.ts.
  void fetch(`${AGENT_ROUTER_BASE_URL}${agentPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "iterate:agent:prompt-added", message }),
  }).catch((error) => {
    logger.error(`[slack] failed to post prompt for thread_ts=${threadTs}`, error);
  });

  return c.json({
    success: true,
    queued: true,
    created: wasNewlyCreated,
    case: responseCase,
    eventId,
    requestId,
  });
});

/**
 * Receives `iterate:agent-updated` events from the agent change callback system.
 * See webchat.ts for the full architecture diagram.
 *
 * When the agent is working, we add an emoji reaction and set the thread status.
 * When the agent goes idle (`isWorking: false`), we remove the emoji and clear
 * the thread status, then drop the context from our in-memory map.
 */
slackRouter.post("/agent-change-callback", async (c) => {
  const parsed = AgentUpdatedEvent.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const { payload } = parsed.data;
  const slackContext = slackThreadContextByAgentPath.get(payload.path);
  if (!slackContext) {
    return c.json({ success: true, ignored: true });
  }

  if (payload.isWorking) {
    await acknowledge(slackContext);
    await setThreadStatus(slackContext, payload.shortStatus || "Working");
    return c.json({ success: true });
  }

  // Agent went idle — remove emoji and clear status.
  await unacknowledge(slackContext);
  slackThreadContextByAgentPath.delete(payload.path);
  return c.json({ success: true });
});

// ──────────────────── Slack API helpers (shelling out) ──────────────────────
//
// We call the Slack API by shelling out to `iterate tool slack` rather than
// using the Slack SDK directly. This is a workaround for an env-var / NFAR
// issue on the daemon: the Slack SDK requires credentials that are available
// to the `iterate` CLI but not easily injected into the daemon process.

async function acknowledge(context: SlackThreadContext): Promise<void> {
  try {
    await runSlackCommand(
      `await slack.reactions.add(${JSON.stringify({
        channel: context.channel,
        timestamp: context.emojiTimestamp,
        name: context.emoji,
      })})`,
      context.requestId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already_reacted")) {
      logger.error("[slack-callback] acknowledge failed", { context, error: message });
    }
  }
}

/**
 * Remove the emoji reaction and clear the thread status.
 * Shells out to `iterate tool slack` — see comment above for why.
 */
async function unacknowledge(context: SlackThreadContext): Promise<void> {
  try {
    await runSlackCommand(
      `await slack.reactions.remove(${JSON.stringify({
        channel: context.channel,
        timestamp: context.emojiTimestamp,
        name: context.emoji,
      })})`,
      context.requestId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("no_reaction")) {
      logger.error("[slack-callback] unacknowledge failed", { context, error: message });
    }
  }

  await setThreadStatus(context, "");
}

/** Set the Slack assistant thread status. Calls straight through to the Slack API. */
async function setThreadStatus(context: SlackThreadContext, status: string): Promise<void> {
  try {
    await runSlackCommand(
      `await slack.assistant.threads.setStatus(${JSON.stringify({
        channel_id: context.channel,
        thread_ts: context.threadTs,
        status,
      })})`,
      context.requestId,
    );
  } catch (error) {
    logger.error("[slack-callback] setStatus failed", {
      context,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Execute a Slack API call by shelling out to the `iterate` CLI.
 *
 * We shell out rather than using the Slack SDK directly because of a known
 * env-var / NFAR issue on the daemon that prevents initializing the SDK.
 * The `iterate` CLI has access to the required Slack credentials.
 */
async function runSlackCommand(code: string, requestId?: string): Promise<void> {
  const result = await x("iterate", ["tool", "slack", code], { throwOnError: false });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Exit code ${result.exitCode}`);
  }

  logger.log("[slack-callback] ran slack command", {
    requestId,
    preview: code.slice(0, 80),
  });
}

// ──────────────────────────── Parsing / routing ─────────────────────────────

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
  return `/slack/ts-${sanitizeThreadId(threadTs)}`;
}

// ────────────────────────── Event storage ────────────────────────────────────

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

// ────────────────────────── Message formatting ──────────────────────────────

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
  const agentPath = getAgentPath(threadTs);

  return [
    `[Agent Path: ${agentPath}] New Slack thread started.`,
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
  const agentPath = getAgentPath(threadTs);

  const lines = [
    `[Agent Path: ${agentPath}] You've been @mentioned in thread ${threadTs}.`,
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

/**
 * Format an FYI message — a message posted in a thread where the bot was
 * previously @mentioned, but this particular message does NOT @mention the bot.
 * We still forward it to the agent as context ("for your information").
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
