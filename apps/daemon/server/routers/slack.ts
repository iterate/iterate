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
 *      For FYI: getAgent (skip if none), then fire-and-forget thinking_face emoji
 *      For reactions: getAgent (skip if none), then fire-and-forget eyes emoji
 *   4. If agent is newly created, subscribe to agent-change callbacks
 *   5. Fire-and-forget prompt to the agent via /api/agents/:path
 *   6. Agent-change callback fires as agent works:
 *      - isWorking=true  → ensure emoji is on, set thread status
 *      - isWorking=false → remove emoji, clear thread status
 *
 * Emoji lifecycle:
 *   The "deterministic" emoji (eyes for mentions/reactions, thinking_face for
 *   FYI) is sent as early as possible in the webhook handler — for mentions
 *   this happens *before* getOrCreateAgent, which can be slow (it may block
 *   creating an OpenCode session). The context (channel, timestamp, emoji name)
 *   is stored in `slackThreadContextByAgentPath` so the agent-change callback
 *   can remove the reaction when the agent goes idle.
 *
 *   Only one emoji is tracked per agentPath at a time. If a second webhook
 *   arrives for the same thread while an emoji is still pending, the new
 *   webhook REPLACES the old context (cleaning up the old emoji) to prevent
 *   stale contexts from blocking cleanup of the new emoji.
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
 * Set: webhook handler adds the deterministic emoji (eyes / thinking_face)
 *       and stores channel + timestamp here so we know what to clean up.
 *       If an entry already exists (stale from a previous interaction), the
 *       new webhook REPLACES it and fire-and-forget removes the old emoji.
 * Cleared: agent-change callback with `isWorking: false` deletes the entry
 *          from the map (immediately, before cleanup), then removes the emoji
 *          and clears thread status. In-flight callbacks detect the deletion
 *          via reference check and bail.
 */
type SlackThreadContext = {
  channel: string;
  threadTs: string;
  /** The `ts` of the Slack message we reacted to (so we can remove the reaction later). */
  emojiTimestamp: string;
  /** The emoji name we added (e.g. "eyes", "thinking_face"). */
  emoji: string;
  requestId?: string;
  /** Tracks the in-flight reactions.add call so remove waits and avoids no_reaction races. */
  acknowledgePromise?: Promise<void>;
};

const slackThreadContextByAgentPath = new Map<string, SlackThreadContext>();

/**
 * Guards against TOCTOU races in storeEvent: tracks Slack event IDs currently
 * being inserted so concurrent requests with the same event_id don't both insert.
 */
const inflightEventIds = new Set<string>();

const AGENT_CHANGE_DEBOUNCE_MS = 200;

const latestAgentUpdateByPath = new Map<string, { shortStatus: string; isWorking: boolean }>();
const agentChangeTimerByPath = new Map<string, ReturnType<typeof setTimeout>>();

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

    // Send eyes emoji immediately and track context for cleanup when agent goes idle.
    // Always replace any existing context — stale contexts from a previous interaction
    // must not block new emoji tracking (causes emoji/status to persist after idle).
    const oldReactionCtx = slackThreadContextByAgentPath.get(agentPath);
    const ctx: SlackThreadContext = {
      channel: parsed.channel,
      threadTs,
      emojiTimestamp: threadTs,
      emoji: "eyes",
      requestId,
    };
    slackThreadContextByAgentPath.set(agentPath, ctx);
    const addReactionPromise = addReaction(ctx);
    ctx.acknowledgePromise = addReactionPromise;
    if (oldReactionCtx) void removeReaction(oldReactionCtx);
    void addReactionPromise;

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

  // For @mentions, send the eyes emoji reaction immediately — before getOrCreateAgent
  // which can be slow (it blocks waiting for an OpenCode session to be created).
  // The user should see the reaction ~instantly as confirmation we received their message.
  // Always replace any existing context to avoid stale contexts blocking cleanup.
  if (isMention) {
    const oldMentionCtx = slackThreadContextByAgentPath.get(agentPath);
    const ctx: SlackThreadContext = {
      channel: event.channel || "",
      threadTs,
      emojiTimestamp: messageTs,
      emoji: "eyes",
      requestId,
    };
    slackThreadContextByAgentPath.set(agentPath, ctx);
    const addReactionPromise = addReaction(ctx);
    ctx.acknowledgePromise = addReactionPromise;
    if (oldMentionCtx) void removeReaction(oldMentionCtx);
    void addReactionPromise;
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

    // FYI in a thread with an existing agent — send thinking_face immediately.
    // Always replace any existing context to avoid stale contexts blocking cleanup.
    const oldFyiCtx = slackThreadContextByAgentPath.get(agentPath);
    const fyiCtx: SlackThreadContext = {
      channel: event.channel || "",
      threadTs,
      emojiTimestamp: messageTs,
      emoji: "thinking_face",
      requestId,
    };
    slackThreadContextByAgentPath.set(agentPath, fyiCtx);
    const addReactionPromise = addReaction(fyiCtx);
    fyiCtx.acknowledgePromise = addReactionPromise;
    if (oldFyiCtx) void removeReaction(oldFyiCtx);
    void addReactionPromise;
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
      slackThreadContextByAgentPath.delete(agentPath);
      await removeReaction(slackContext);
      await setThreadStatus(slackContext, "");
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
 * The deterministic emoji (eyes/thinking_face) was already added by the webhook
 * handler. This callback manages the thread status while the agent works and
 * cleans up when it goes idle:
 *   - isWorking=true  → re-affirm emoji (no-op if already_reacted), set thread status
 *   - isWorking=false → remove emoji, clear thread status, delete context from map
 */
slackRouter.post("/agent-change-callback", async (c) => {
  const parsed = AgentUpdatedEvent.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const { payload } = parsed.data;
  latestAgentUpdateByPath.set(payload.path, {
    shortStatus: payload.shortStatus,
    isWorking: payload.isWorking,
  });

  // Debounce per agent path: Slack can get spammy update bursts (typing/thinking/etc).
  // This endpoint should return fast; the debounced handler does the Slack API calls.
  const existingTimer = agentChangeTimerByPath.get(payload.path);
  if (existingTimer) clearTimeout(existingTimer);

  agentChangeTimerByPath.set(
    payload.path,
    setTimeout(() => {
      agentChangeTimerByPath.delete(payload.path);
      void handleDebouncedAgentChange(payload.path);
    }, AGENT_CHANGE_DEBOUNCE_MS),
  );

  return c.json({ success: true, debounced: true, debounceMs: AGENT_CHANGE_DEBOUNCE_MS });
});

async function handleDebouncedAgentChange(agentPath: string): Promise<void> {
  const latest = latestAgentUpdateByPath.get(agentPath);
  if (!latest) return;

  const slackContext = slackThreadContextByAgentPath.get(agentPath);
  if (!slackContext) return;

  if (latest.isWorking) {
    // Capture context reference to detect staleness across awaits.
    const capturedContext = slackContext;

    await addReaction(capturedContext);
    if (slackThreadContextByAgentPath.get(agentPath) !== capturedContext) return;

    await setThreadStatus(capturedContext, latest.shortStatus || "Working");
    return;
  }

  // Agent went idle — remove emoji and clear status.
  latestAgentUpdateByPath.delete(agentPath);

  // Delete from map FIRST so:
  //   1. New webhooks can create fresh context immediately
  //   2. In-flight callbacks detect staleness after their next await
  slackThreadContextByAgentPath.delete(agentPath);
  await removeReaction(slackContext);
  await setThreadStatus(slackContext, "");

  // Belt-and-suspenders: retry cleanup after a delay. In-flight callbacks that
  // started before the delete may re-add the emoji or re-set status during the window.
  setTimeout(() => {
    if (!slackThreadContextByAgentPath.has(agentPath)) {
      void (async () => {
        await removeReaction(slackContext);
        await setThreadStatus(slackContext, "");
      })();
    }
  }, 5000);
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
  await context.acknowledgePromise;
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
