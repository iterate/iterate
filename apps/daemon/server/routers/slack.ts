/**
 * Slack Webhook Router
 *
 * Handles incoming Slack webhooks forwarded from the OS backend.
 * One agent per Slack thread, keyed by thread_ts.
 *
 * Flow:
 *   1. OS worker receives Slack event, forwards to POST /webhook
 *   2. We parse & classify (mention / FYI / reaction / ignored)
 *   2.5. We intercept agent commands (primary: !debug) before agent forwarding
 *   3. For mentions: immediately fire-and-forget eyes emoji, then getOrCreateAgent
 *      For FYI/reactions: getAgent (skip if none), then forward to existing agent
 *   4. If agent is newly created, subscribe to agent-change callbacks
 *   5. Fire-and-forget prompt to the agent via /api/agents/:path
 *   6. Agent-change callback fires as agent works:
 *      - isWorking=true  → set thread status (debounced + deduped)
 *      - isWorking=false → remove emoji, clear thread status
 *
 * Emoji lifecycle:
 *   The "deterministic" emoji (eyes) is sent as early as possible in mention
 *   webhooks. For FYI/reaction events we forward to the agent but do not add
 *   deterministic emoji.
 *
 *   For mentions,
 *   this happens *before* getOrCreateAgent, which can be slow (it may block
 *   creating an OpenCode session). The context (channel, timestamp, emoji name)
 *   is stored in `slackThreadContextByAgentPath` so the agent-change callback
 *   can remove the reaction when the agent goes idle.
 *
 *   Only one deterministic emoji is tracked per agentPath at a time. If another
 *   mention arrives before idle, we keep existing context and skip adding a
 *   second deterministic eyes emoji.
 *
 * Staleness handling:
 *   Slack Web API calls can be slow. Multiple agent-change callbacks run
 *   concurrently, each awaiting Slack API responses.
 *   When isWorking=false arrives, it deletes the context from the map
 *   BEFORE running cleanup. In-flight isWorking=true callbacks detect this
 *   via a reference check after each await and bail if the context changed.
 *   A delayed retry (5s) catches any stragglers that re-set status during
 *   the cleanup window.
 *
 * Structurally symmetric with webchat.ts and email.ts — if you change the
 * pattern in one, update the others to match.
 */
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { WebClient } from "@slack/web-api";
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
import { runAgentCommand } from "../utils/agent-commands.ts";

const logger = console;

export const slackRouter = new Hono();

/**
 * Per-agent Slack thread context stored in memory, keyed by agent path.
 *
 * Set: message webhooks establish a context cycle for status updates.
 *      Mentions additionally add deterministic eyes emoji.
 *      If an active entry already exists, we keep it and avoid re-adding emoji.
 * Cleared: agent-change callback with `isWorking: false` marks closing, clears
 *          emoji + status, then removes the entry from the map if it is still
 *          the same cycle.
 */
type SlackThreadContext = {
  channel: string;
  threadTs: string;
  /** The `ts` of the Slack message we reacted to (if deterministic emoji was added). */
  emojiTimestamp?: string;
  /** The emoji name we added (e.g. "eyes"), if any. */
  emoji?: string;
  /** Local creation timestamp used to ignore stale agent callbacks. */
  createdAtMs: number;
  requestId?: string;
  /** Tracks the in-flight reactions.add call so remove waits and avoids no_reaction races. */
  addEmojiPromise: Promise<void>;
  /** Cycle guard to avoid stale async callbacks mutating a newer context. */
  cycleId: string;
  /** True while idle cleanup is running. */
  closing: boolean;
  /** Fingerprint of last status payload sent to Slack. */
  lastStatusKey: string;
  /** Debounced timer for status updates while agent is working. */
  statusTimer?: ReturnType<typeof setTimeout>;
};

const slackThreadContextByAgentPath = new Map<string, SlackThreadContext>();

/**
 * Guards against TOCTOU races in storeEvent: tracks Slack event IDs currently
 * being inserted so concurrent requests with the same event_id don't both insert.
 */
const inflightEventIds = new Set<string>();

const STATUS_DEBOUNCE_MS = 200;

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
      updatedAt: z.string().optional(),
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
 *   5. For @mentions, ensure one active deterministic emoji context.
 *   6. Fire-and-forget fetch to AGENT_ROUTER_BASE_URL + agentPath.
 */
slackRouter.post("/webhook", async (c) => {
  const requestId = c.req.header("x-iterate-request-id") ?? `daemon-${nanoid(10)}`;
  const payload = (await c.req.json()) as SlackWebhookPayload;
  const slackEventId = payload.event_id;

  const { eventId, isDuplicate } = await storeEvent(payload, slackEventId);
  if (isDuplicate) {
    return c.json({ success: true, message: "Duplicate event", eventId, requestId });
  }

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
  const messageTs = event.ts || threadTs;

  // For @mentions, start a context cycle and add eyes immediately.
  if (isMention) {
    ensureSlackThreadContext({
      agentPath,
      channel: event.channel || "",
      threadTs,
      emojiTimestamp: messageTs,
      emoji: "eyes",
      requestId,
    });
  }

  let wasNewlyCreated = false;
  let agent: Awaited<ReturnType<typeof caller.getAgent>> = null;

  if (isMention) {
    // Mentions always get-or-create an agent, matching the webchat pattern.
    const result = await caller.getOrCreateAgent({ agentPath, createWithEvents: [] });
    wasNewlyCreated = result.wasNewlyCreated;
    agent = result.agent;
  } else {
    // FYI messages (no @mention) in a thread — only forward if an agent already exists.
    agent = await caller.getAgent({ path: agentPath });
    if (!agent) {
      return c.json({
        success: true,
        message: "Ignored: no mention and no existing agent",
        eventId,
        requestId,
      });
    }

    // FYI messages start a fresh status cycle but do not add deterministic emoji.
    ensureSlackThreadContext({
      agentPath,
      channel: event.channel || "",
      threadTs,
      requestId,
    });
  }

  if (!agent) {
    return c.json({
      success: true,
      message: "Ignored: no resolved agent",
      eventId,
      requestId,
    });
  }

  // Commands are agent-scoped. If no agent exists, callers should return early above.
  const commandResult = await runAgentCommand({
    message: event.text || "",
    agentPath,
    agent,
  });

  if (commandResult) {
    if (wasNewlyCreated) {
      void caller.subscribeToAgentChanges({
        agentPath,
        callbackUrl: SLACK_AGENT_CHANGE_CALLBACK_URL,
      });
    }

    // Command interceptions do not forward prompts to the agent, so there is no
    // agent lifecycle callback to clean up any tracked deterministic emoji.
    const slackContext = slackThreadContextByAgentPath.get(agentPath);
    if (slackContext) {
      await cleanupSlackThreadContext(agentPath, slackContext);
    }

    const channel = event.channel || "";
    if (!channel) {
      return c.json({
        success: true,
        message: "Ignored: command message missing channel",
        case: `${commandResult.command}_command`,
        eventId,
        requestId,
      });
    }

    await postSlackThreadMessage({
      channel,
      threadTs,
      text: commandResult.resultMarkdown,
      requestId,
    });

    return c.json({
      success: true,
      queued: false,
      created: wasNewlyCreated,
      case: `${commandResult.command}_command`,
      eventId,
      requestId,
    });
  }

  // Subscribe to agent-change callbacks once, when the agent is first created.
  if (wasNewlyCreated) {
    void caller.subscribeToAgentChanges({
      agentPath,
      callbackUrl: SLACK_AGENT_CHANGE_CALLBACK_URL,
    });
  }

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
 *
 * This callback manages the thread status while the agent works and
 * cleans up when it goes idle:
 *   - isWorking=true  → debounce + dedupe thread status updates
 *   - isWorking=false → remove tracked emoji, clear thread status, delete context from map
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

  const eventUpdatedAtMs = parseUpdatedAtMs(payload.updatedAt);
  if (eventUpdatedAtMs !== null && eventUpdatedAtMs < slackContext.createdAtMs) {
    return c.json({ success: true, ignored: true, stale: true });
  }

  if (payload.isWorking) {
    scheduleThreadStatusUpdate(payload.path, slackContext, payload.shortStatus || "Working");
    return c.json({ success: true, scheduled: true, debounceMs: STATUS_DEBOUNCE_MS });
  }

  await cleanupSlackThreadContext(payload.path, slackContext);
  return c.json({ success: true });
});

function ensureSlackThreadContext(params: {
  agentPath: string;
  channel: string;
  threadTs: string;
  emojiTimestamp?: string;
  emoji?: string;
  requestId?: string;
}): void {
  const existing = slackThreadContextByAgentPath.get(params.agentPath);
  if (existing && !existing.closing) {
    return;
  }

  const context: SlackThreadContext = {
    channel: params.channel,
    threadTs: params.threadTs,
    emojiTimestamp: params.emojiTimestamp,
    emoji: params.emoji,
    createdAtMs: Date.now(),
    requestId: params.requestId,
    addEmojiPromise: Promise.resolve(),
    cycleId: `slk-${nanoid(8)}`,
    closing: false,
    lastStatusKey: "",
  };

  slackThreadContextByAgentPath.set(params.agentPath, context);
  if (context.emoji && context.emojiTimestamp) {
    const addEmojiPromise = addReaction(context);
    context.addEmojiPromise = addEmojiPromise;
    void addEmojiPromise;
  }
}

function scheduleThreadStatusUpdate(
  agentPath: string,
  context: SlackThreadContext,
  rawStatus: string,
): void {
  if (context.closing) return;

  const statusPayload = toSlackStatus(rawStatus);
  const statusKey = JSON.stringify(statusPayload);
  if (statusKey === context.lastStatusKey) return;

  if (context.statusTimer) clearTimeout(context.statusTimer);
  const cycleId = context.cycleId;

  context.statusTimer = setTimeout(() => {
    void flushThreadStatusUpdate(agentPath, context, cycleId, rawStatus, statusKey);
  }, STATUS_DEBOUNCE_MS);
}

async function flushThreadStatusUpdate(
  agentPath: string,
  context: SlackThreadContext,
  cycleId: string,
  rawStatus: string,
  statusKey: string,
): Promise<void> {
  if (context.closing) return;
  if (slackThreadContextByAgentPath.get(agentPath)?.cycleId !== cycleId) return;

  await context.addEmojiPromise;
  if (context.closing) return;
  if (slackThreadContextByAgentPath.get(agentPath)?.cycleId !== cycleId) return;

  await setThreadStatus(context, rawStatus);
  context.lastStatusKey = statusKey;
}

async function cleanupSlackThreadContext(
  agentPath: string,
  context: SlackThreadContext,
): Promise<void> {
  if (context.closing) return;
  context.closing = true;
  if (context.statusTimer) clearTimeout(context.statusTimer);
  context.statusTimer = undefined;

  await context.addEmojiPromise;
  await Promise.allSettled([removeReaction(context), setThreadStatus(context, "")]);

  if (slackThreadContextByAgentPath.get(agentPath)?.cycleId === context.cycleId) {
    slackThreadContextByAgentPath.delete(agentPath);
  }
}

// ─────────────────────────── Slack API helpers (SDK) ────────────────────────
//
// We call Slack directly via the Web API client.
//
// Token: use SLACK_BOT_TOKEN (same as CLI tooling).
let slackClient: WebClient | null = null;

function getSlackClient(): WebClient {
  if (slackClient) return slackClient;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN environment variable is required");
  slackClient = new WebClient(token);
  return slackClient;
}

async function addReaction(context: SlackThreadContext): Promise<void> {
  if (!context.emoji || !context.emojiTimestamp) return;

  try {
    await getSlackClient().reactions.add({
      channel: context.channel,
      timestamp: context.emojiTimestamp,
      name: context.emoji,
    });
    logger.log("[slack] addReaction ok", {
      requestId: context.requestId,
      channel: context.channel,
      timestamp: context.emojiTimestamp,
      name: context.emoji,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already_reacted")) {
      logger.error("[slack] addReaction failed", { context, error: message });
    }
  }
}

async function removeReaction(context: SlackThreadContext): Promise<void> {
  if (!context.emoji || !context.emojiTimestamp) return;

  await context.addEmojiPromise;
  try {
    await getSlackClient().reactions.remove({
      channel: context.channel,
      timestamp: context.emojiTimestamp,
      name: context.emoji,
    });
    logger.log("[slack] removeReaction ok", {
      requestId: context.requestId,
      channel: context.channel,
      timestamp: context.emojiTimestamp,
      name: context.emoji,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("no_reaction")) {
      logger.error("[slack] removeReaction failed", { context, error: message });
    }
  }
}

/**
 * Map raw agent shortStatus to a Slack-friendly display status and optional
 * loading_messages array. The shortStatus comes from opencode.ts and may
 * contain emoji prefixes (🤔, ✏️, 🔧).
 */
function toSlackStatus(rawStatus: string): { status: string; loading_messages?: string[] } {
  if (!rawStatus) return { status: "" };

  if (rawStatus.includes("✏️") || rawStatus.toLowerCase().includes("writing")) {
    return { status: "is typing...", loading_messages: [`${rawStatus}...`] };
  }
  if (rawStatus.includes("🤔") || rawStatus.toLowerCase().includes("thinking")) {
    return { status: "is thinking...", loading_messages: [`${rawStatus}...`] };
  }

  // Tool use or generic working status
  return { status: "is working...", loading_messages: [`${rawStatus}...`] };
}

async function setThreadStatus(context: SlackThreadContext, rawStatus: string): Promise<void> {
  const { status, loading_messages } = toSlackStatus(rawStatus);

  try {
    await getSlackClient().apiCall("assistant.threads.setStatus", {
      channel_id: context.channel,
      thread_ts: context.threadTs,
      status,
      ...(loading_messages ? { loading_messages } : {}),
    });
    logger.log("[slack] setThreadStatus ok", {
      requestId: context.requestId,
      channel: context.channel,
      threadTs: context.threadTs,
      status,
    });
  } catch (error) {
    logger.error("[slack] setThreadStatus failed", {
      context,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function postSlackThreadMessage(params: {
  channel: string;
  threadTs: string;
  text: string;
  requestId?: string;
}): Promise<void> {
  try {
    await getSlackClient().chat.postMessage({
      channel: params.channel,
      thread_ts: params.threadTs,
      text: params.text,
    });
    logger.log("[slack] postSlackThreadMessage ok", {
      requestId: params.requestId,
      channel: params.channel,
      threadTs: params.threadTs,
    });
  } catch (error) {
    logger.error("[slack] postSlackThreadMessage failed", {
      requestId: params.requestId,
      channel: params.channel,
      threadTs: params.threadTs,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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

function parseUpdatedAtMs(updatedAt: string | undefined): number | null {
  if (!updatedAt) return null;
  const ms = Date.parse(updatedAt);
  return Number.isNaN(ms) ? null : ms;
}

// ────────────────────────── Event storage ────────────────────────────────────

async function storeEvent(
  payload: SlackWebhookPayload,
  slackEventId?: string,
): Promise<{ eventId: string; isDuplicate: boolean }> {
  if (slackEventId) {
    // In-flight guard: another concurrent request is already processing this event.
    if (inflightEventIds.has(slackEventId)) {
      return { eventId: `dup_${slackEventId}`, isDuplicate: true };
    }
    inflightEventIds.add(slackEventId);
  }

  try {
    if (slackEventId) {
      const existing = await db
        .select()
        .from(schema.events)
        .where(eq(schema.events.externalId, slackEventId))
        .limit(1);
      if (existing[0]) {
        return { eventId: existing[0].id, isDuplicate: true };
      }
    }

    const eventId = `evt_${nanoid(12)}`;
    await db.insert(schema.events).values({
      id: eventId,
      type: "slack:webhook",
      externalId: slackEventId,
      payload: payload as unknown as Record<string, unknown>,
    });

    return { eventId, isDuplicate: false };
  } finally {
    if (slackEventId) inflightEventIds.delete(slackEventId);
  }
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
    "Refer to SLACK.md for how to respond via `iterate tool exec-js`.",
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
    "Refer to SLACK.md for how to respond via `iterate tool exec-js`.",
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
