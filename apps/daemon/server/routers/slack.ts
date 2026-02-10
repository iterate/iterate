/**
 * Slack Webhook Router
 *
 * Handles incoming Slack webhooks forwarded from the OS backend.
 * Routes per Slack thread and forwards formatted messages.
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
import { activeAgentExists, sendToAgentGateway } from "../utils/agent-gateway.ts";
import { trpcRouter } from "../trpc/router.ts";

const logger = console;

export const slackRouter = new Hono();

// [[Explain what this is for]]
type SlackAgentContext = {
  channel: string;
  threadTs: string;
  emojiTimestamp: string;
  emoji: string;
  requestId?: string;
};

const slackContextByAgentPath = new Map<string, SlackAgentContext>();
const DAEMON_PORT = process.env.PORT || "3001";
const slackCallbackUrl = `http://localhost:${DAEMON_PORT}/api/integrations/slack/agent-change-callback`;

// [[why can we not use the schema / type from the actual router? ]]
const AgentChangePayload = z.object({
  path: z.string(),
  shortStatus: z.string(),
  isWorking: z.boolean(),
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

slackRouter.post("/webhook", async (c) => {
  const requestId = c.req.header("x-iterate-request-id") ?? `daemon-${nanoid(10)}`;
  const payload = (await c.req.json()) as SlackWebhookPayload;
  const slackEventId = payload.event_id;

  const eventId = await storeEvent(payload, slackEventId);
  const parsed = parseWebhookPayload(payload);

  if (parsed.case === "ignored") {
    return c.json({ success: true, message: parsed.reason, eventId, requestId });
  }

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

// [[I'll explain briefly that this gets called by the agent tRPC router whenever anything changes. ]]
slackRouter.post("/agent-change-callback", async (c) => {
  const parsed = AgentChangePayload.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const payload = parsed.data;
  const context = slackContextByAgentPath.get(payload.path);
  if (!context) {
    return c.json({ success: true, ignored: true });
  }

  if (payload.isWorking) {
    await acknowledge(context);
    await setThreadStatus(context, payload.shortStatus || "Working");
    return c.json({ success: true });
  }

  await unacknowledge(context);
  slackContextByAgentPath.delete(payload.path);
  await trpcRouter.createCaller({}).unsubscribeFromAgentChanges({
    agentPath: payload.path,
    callbackUrl: slackCallbackUrl,
  });
  return c.json({ success: true });
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
  if (isParsedReaction(parsed)) {
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

    const message = formatReactionMessage(parsed.event, parsed.case, threadTs, eventId);
    // [[This is terrible (nameing, at least) - it should be clear thisis just a fetcher. it should be really clear that this is just a fetch!]]
    await sendToAgentGateway(agentPath, { type: "prompt", message });
    await registerSlackAgentChangeContext({
      agentPath,
      channel: parsed.channel,
      threadTs,
      emojiTimestamp: threadTs,
      emoji: "eyes",
      requestId,
    });
    return;
  }

  const messageParsed = parsed;
  const { event, threadTs } = messageParsed;
  const agentPath = getAgentPath(threadTs);
  const hasAgent = precomputedHasAgent ?? (await activeAgentExists(agentPath));

  if (messageParsed.case === "new_thread_mention") {
    const messageTs = event.ts || threadTs;
    const message = hasAgent
      ? formatMidThreadMentionMessage(event, threadTs, eventId)
      : formatNewThreadMentionMessage(event, threadTs, eventId);
    await sendToAgentGateway(agentPath, { type: "prompt", message });
    await registerSlackAgentChangeContext({
      agentPath,
      channel: event.channel || "",
      threadTs,
      emojiTimestamp: messageTs,
      emoji: "eyes",
      requestId,
    });
    return;
  }

  if (messageParsed.case === "mid_thread_mention") {
    const messageTs = event.ts || threadTs;
    const message = formatMidThreadMentionMessage(event, threadTs, eventId);
    await sendToAgentGateway(agentPath, { type: "prompt", message });
    await registerSlackAgentChangeContext({
      agentPath,
      channel: event.channel || "",
      threadTs,
      emojiTimestamp: messageTs,
      emoji: "eyes",
      requestId,
    });
    return;
  }

  // [[ Explain what this is about  / when it would happen ]]
  if (messageParsed.case === "fyi_message") {
    if (!hasAgent) {
      logger.log("[Slack Webhook] Ignored FYI: no existing agent", { eventId, requestId });
      return;
    }

    const message = formatFyiMessage(event, threadTs, eventId);
    await sendToAgentGateway(agentPath, { type: "prompt", message });
    await registerSlackAgentChangeContext({
      agentPath,
      channel: event.channel || "",
      threadTs,
      emojiTimestamp: threadTs,
      emoji: "thinking_face",
      requestId,
    });
    return;
  }
}

async function registerSlackAgentChangeContext(params: {
  agentPath: string;
  channel: string;
  threadTs: string;
  emojiTimestamp: string;
  emoji: string;
  requestId?: string;
}): Promise<void> {
  slackContextByAgentPath.set(params.agentPath, {
    channel: params.channel,
    threadTs: params.threadTs,
    emojiTimestamp: params.emojiTimestamp,
    emoji: params.emoji,
    requestId: params.requestId,
  });

  await trpcRouter.createCaller({}).subscribeToAgentChanges({
    agentPath: params.agentPath,
    callbackUrl: slackCallbackUrl,
  });
}

async function acknowledge(context: SlackAgentContext): Promise<void> {
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

// [[ Explain a bit what this is about and that we're shelling out: because of some weird env var issue on the daemon that we didn't yet want to fix ]]
async function unacknowledge(context: SlackAgentContext): Promise<void> {
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

async function setThreadStatus(context: SlackAgentContext, status: string): Promise<void> {
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

// [[ Explain we're shelling out because of some weird NFAR issue.  ]]
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
