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
 *
 * Backslash commands (handled directly, not forwarded to agent):
 * - \debug - Returns agent session link for debugging
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
  KnownBlock,
} from "@slack/types";
import { z } from "zod/v4";
import { x } from "tinyexec";
import { getAgent, createAgent, appendToAgent } from "../services/agent-manager.ts";
import type { AppendParams } from "../agents/types.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { getCustomerRepoPath } from "../trpc/platform.ts";
import { withSpan } from "../utils/otel.ts";
import { buildJaegerTraceUrl, buildLogsSearchUrl } from "../utils/observability-links.ts";

const logger = console;

type RequestCorrelation = {
  requestId: string;
  traceparent: string | null;
  forwardedSlackEventId: string | null;
};

/**
 * Run a slack command via the iterate CLI.
 * The CLI loads env vars from ~/.iterate/.env (including proxy settings and SLACK_BOT_TOKEN).
 */
async function runSlackCommand(code: string, requestId?: string): Promise<void> {
  logger.log("[slack] runSlackCommand", {
    requestId,
    preview: code.slice(0, 80) + "...",
  });
  const result = await x("iterate", ["tool", "slack", code], { throwOnError: false });
  logger.log("[slack] CLI result", {
    requestId,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 200),
    stderr: result.stderr.slice(0, 200),
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Exit code ${result.exitCode}`);
  }
}

/**
 * Build the acknowledge/unacknowledge/setStatus callbacks for a Slack thread.
 *
 * - `acknowledge`: adds an emoji reaction to `emojiTimestamp`
 * - `unacknowledge`: removes that emoji and clears the thread status
 * - `setStatus`: updates the assistant thread status (max ~30 chars)
 */
function createSlackCallbacks(params: {
  channel: string;
  threadTs: string;
  /** Message timestamp to add/remove the emoji on (often `event.ts`, sometimes `threadTs`) */
  emojiTimestamp: string;
  emoji: string;
  requestId?: string;
}): Pick<AppendParams, "acknowledge" | "unacknowledge" | "setStatus"> {
  const { channel, threadTs, emojiTimestamp, emoji, requestId } = params;

  return {
    acknowledge: async () => {
      try {
        await runSlackCommand(
          `await slack.reactions.add(${JSON.stringify({ channel, timestamp: emojiTimestamp, name: emoji })})`,
          requestId,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes("already_reacted")) {
          logger.error(`[slack] Failed to add :${emoji}:`, {
            error,
            channel,
            timestamp: emojiTimestamp,
            requestId,
          });
        }
      }
    },

    unacknowledge: async () => {
      try {
        await runSlackCommand(
          `await slack.reactions.remove(${JSON.stringify({ channel, timestamp: emojiTimestamp, name: emoji })})`,
          requestId,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes("no_reaction")) {
          logger.error(`[slack] Failed to remove :${emoji}:`, {
            error,
            channel,
            timestamp: emojiTimestamp,
            requestId,
          });
        }
      }
      // Clear thread status
      try {
        await runSlackCommand(
          `await slack.assistant.threads.setStatus(${JSON.stringify({ channel_id: channel, thread_ts: threadTs, status: "" })})`,
          requestId,
        );
      } catch {
        // Non-critical
      }
    },

    setStatus: async (
      status: string,
      { input }: { tool: string; input: Record<string, unknown> },
    ) => {
      // Skip — the agent is already talking to Slack directly via this tool call
      const command = typeof input.command === "string" ? input.command : "";
      if (command.includes("iterate tool slack")) return;
      try {
        await runSlackCommand(
          `await slack.assistant.threads.setStatus(${JSON.stringify({ channel_id: channel, thread_ts: threadTs, status })})`,
          requestId,
        );
      } catch (error) {
        logger.error(`[slack] Failed to set thread status:`, { error, requestId });
      }
    },
  };
}

export const slackRouter = new Hono();

// Middleware to log request and response bodies
slackRouter.use("*", async (c, next) => {
  const reqBody = await c.req.raw.clone().text();
  console.log(`[daemon/slack] REQ ${c.req.method} ${c.req.path}`, reqBody);

  await next();

  const resBody = await c.res.clone().text();
  console.log(`[daemon/slack] RES ${c.res.status}`, resBody);
});

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

/**
 * Environment variables required for building session URLs.
 * Will throw if any are missing - this indicates a misconfiguration.
 */
const SessionEnv = z.object({
  ITERATE_OS_BASE_URL: z.string(),
  ITERATE_ORG_SLUG: z.string(),
  ITERATE_PROJECT_SLUG: z.string(),
  ITERATE_MACHINE_ID: z.string(),
  ITERATE_CUSTOMER_REPO_PATH: z.string(),
});

/**
 * Build the terminal URL with opencode attach command pre-filled.
 */
function buildAgentSessionUrl(sessionId: string): string {
  const env = SessionEnv.parse(process.env);

  const command = `opencode attach 'http://localhost:4096' --session ${sessionId} --dir ${env.ITERATE_CUSTOMER_REPO_PATH}`;
  const proxyUrl = `${env.ITERATE_OS_BASE_URL}/org/${env.ITERATE_ORG_SLUG}/proj/${env.ITERATE_PROJECT_SLUG}/${env.ITERATE_MACHINE_ID}/proxy/3000`;

  return `${proxyUrl}/terminal?${new URLSearchParams({ command, autorun: "true" })}`;
}

/**
 * Backslash command response type.
 */
interface BackslashCommandResponse {
  text: string;
  blocks?: KnownBlock[];
}

/**
 * Parameters passed to backslash command handlers.
 */
interface BackslashCommandParams {
  channel: string;
  threadTs: string;
  agentSlug: string | null;
  existingAgent: Awaited<ReturnType<typeof getAgent>>;
}

/**
 * Backslash command handler function type.
 */
type BackslashCommandHandler = (
  params: BackslashCommandParams,
) => Promise<BackslashCommandResponse>;

/**
 * Registry of backslash commands.
 * Add new commands here - they will be automatically detected and handled.
 */
const backslashCommands = {
  debug: async ({ agentSlug, existingAgent }): Promise<BackslashCommandResponse> => {
    if (!existingAgent) {
      return {
        text: "No agent found for this thread. Start a conversation by @mentioning the bot first.",
      };
    }

    const sessionId = existingAgent.harnessSessionId;
    if (!sessionId) {
      return {
        text: `Agent exists (${agentSlug}) but has no session ID.`,
      };
    }

    const sessionUrl = buildAgentSessionUrl(sessionId);

    return {
      text: `Agent: ${agentSlug}\nSession: ${sessionId}\n<${sessionUrl}|Attach to agent session>`,
      blocks: [
        {
          type: "section" as const,
          text: {
            type: "mrkdwn" as const,
            text: `*Agent:* \`${agentSlug}\`\n*Session:* \`${sessionId}\``,
          },
        },
        {
          type: "actions" as const,
          elements: [
            {
              type: "button" as const,
              text: { type: "plain_text" as const, text: "Open Agent Session", emoji: true },
              url: sessionUrl,
              action_id: "open_agent_session",
            },
          ],
        },
      ],
    };
  },
} satisfies Record<string, BackslashCommandHandler>;

type BackslashCommand = keyof typeof backslashCommands;

/**
 * Regex to detect backslash commands anywhere in the message.
 * Built dynamically from the command registry.
 */
const backslashCommandRegex = new RegExp(
  `\\\\(${Object.keys(backslashCommands).join("|")})\\b`,
  "i",
);

/**
 * Parse a backslash command from message text.
 * Returns undefined if no command found.
 */
function parseBackslashCommand(text: string): BackslashCommand | undefined {
  // Remove bot mention before checking
  const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const match = cleanText.match(backslashCommandRegex);
  return match?.[1].toLowerCase() as BackslashCommand | undefined;
}

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
  const correlation: RequestCorrelation = {
    requestId: c.req.header("x-iterate-request-id") ?? `daemon-${nanoid(10)}`,
    traceparent: c.req.header("traceparent") ?? null,
    forwardedSlackEventId: c.req.header("x-slack-event-id") ?? null,
  };

  const payload = (await c.req.json()) as SlackWebhookPayload;
  const slackEventId = payload.event_id;

  logger.log("[daemon/slack] Received payload", { correlation, slackEventId, payload });

  if (correlation.forwardedSlackEventId && slackEventId) {
    if (correlation.forwardedSlackEventId !== slackEventId) {
      logger.warn("[Slack Webhook] Header/body Slack event mismatch", {
        correlation,
        slackEventId,
      });
    }
  }

  return withSpan(
    "daemon.slack.webhook",
    {
      attributes: {
        "messaging.system": "slack",
        "messaging.operation": "process",
        "iterate.request_id": correlation.requestId,
        "slack.event_id": slackEventId ?? "unknown",
      },
    },
    async (span) => {
      const traceUrl = buildJaegerTraceUrl(span.spanContext().traceId);
      const logsUrl = buildLogsSearchUrl(correlation.requestId);
      if (traceUrl) span.setAttribute("iterate.link.trace_url", traceUrl);
      if (logsUrl) span.setAttribute("iterate.link.log_url", logsUrl);

      const eventId = await withSpan(
        "daemon.slack.store_event",
        {
          attributes: {
            "iterate.request_id": correlation.requestId,
            "slack.event_id": slackEventId ?? "unknown",
          },
        },
        async () => storeEvent(payload, slackEventId),
      );

      const parsed = parseWebhookPayload(payload);
      if (parsed.case === "ignored") {
        span.setAttribute("daemon.result", "ignored");
        return c.json({
          success: true,
          message: parsed.reason,
          eventId,
          requestId: correlation.requestId,
        });
      }

      if (parsed.case === "reaction_added" || parsed.case === "reaction_removed") {
        const threadTs = await lookupThreadTsForMessage(parsed.channel, parsed.itemTs);
        if (!threadTs) {
          return c.json({
            success: true,
            message: "Ignored: could not find thread for reacted message",
            eventId,
            requestId: correlation.requestId,
          });
        }

        const { agent: existingAgent, agentSlug } = await findAgentForThread(
          parsed.channel,
          threadTs,
        );
        if (!existingAgent) {
          return c.json({
            success: true,
            message: "Ignored: no agent for this thread",
            eventId,
            requestId: correlation.requestId,
          });
        }

        const message = formatReactionMessage(parsed.event, parsed.case, threadTs, eventId);
        const { setStatus } = createSlackCallbacks({
          channel: parsed.channel,
          threadTs,
          emojiTimestamp: threadTs,
          emoji: "eyes",
          requestId: correlation.requestId,
        });
        await appendToAgent(existingAgent, message, {
          workingDirectory: await getCustomerRepoPath(),
          acknowledge: async () =>
            logger.log(`[slack] Processing reaction in ${parsed.channel}/${threadTs}`),
          unacknowledge: async () =>
            logger.log(`[slack] Finished processing reaction in ${parsed.channel}/${threadTs}`),
          setStatus,
        });
        span.setAttribute("daemon.result", parsed.case);
        return c.json({
          success: true,
          agentSlug,
          created: false,
          case: parsed.case,
          eventId,
          requestId: correlation.requestId,
        });
      }

      const { event, threadTs } = parsed as ParsedMessage;
      const channel = event.channel || "";
      const messageText = event.text || "";
      const { agent: existingAgent, agentSlug } = await findAgentForThread(channel, threadTs);

      const commandName = parseBackslashCommand(messageText);
      if (commandName) {
        const handler = backslashCommands[commandName];
        const response = await handler({ channel, threadTs, agentSlug, existingAgent });

        await withSpan(
          "daemon.slack.post_message",
          {
            attributes: {
              "iterate.request_id": correlation.requestId,
              "slack.channel": channel,
              "slack.thread_ts": threadTs,
            },
          },
          async () =>
            slackPostMessage(
              {
                channel,
                thread_ts: threadTs,
                text: response.text,
                blocks: response.blocks,
              },
              correlation.requestId,
            ),
        );

        span.setAttribute("daemon.result", "backslash_command");
        return c.json({
          success: true,
          case: "backslash_command",
          command: commandName,
          eventId,
          requestId: correlation.requestId,
        });
      }

      if (parsed.case === "new_thread_mention") {
        const workingDirectory = await getCustomerRepoPath();
        if (existingAgent) {
          const message = formatMidThreadMentionMessage(event, threadTs, eventId, agentSlug);
          const callbacks = createSlackCallbacks({
            channel,
            threadTs,
            emojiTimestamp: event.ts,
            emoji: "eyes",
            requestId: correlation.requestId,
          });
          await appendToAgent(existingAgent, message, { workingDirectory, ...callbacks });
          span.setAttribute("daemon.result", "mid_thread_mention");
          return c.json({
            success: true,
            agentSlug,
            created: false,
            case: "mid_thread_mention",
            eventId,
            requestId: correlation.requestId,
          });
        }

        const newAgentSlug = `slack-${sanitizeThreadId(threadTs)}`;
        const agent = await createAgent({
          slug: newAgentSlug,
          harnessType: "opencode",
          workingDirectory,
          initialPrompt: `[Agent slug: ${newAgentSlug}]\n[Source: slack]\n[Thread: ${channel}/${threadTs}]`,
        });

        const message = formatNewThreadMentionMessage(event, threadTs, eventId, newAgentSlug);
        const callbacks = createSlackCallbacks({
          channel,
          threadTs,
          emojiTimestamp: event.ts,
          emoji: "eyes",
          requestId: correlation.requestId,
        });
        await appendToAgent(agent, message, { workingDirectory, ...callbacks });
        span.setAttribute("daemon.result", "new_thread_mention");
        return c.json({
          success: true,
          agentSlug: newAgentSlug,
          created: true,
          case: "new_thread_mention",
          eventId,
          requestId: correlation.requestId,
        });
      }

      if (parsed.case === "mid_thread_mention") {
        let agent = existingAgent;
        let wasCreated = false;
        let finalAgentSlug = agentSlug;
        const workingDirectory = await getCustomerRepoPath();

        if (!agent) {
          finalAgentSlug = `slack-${sanitizeThreadId(threadTs)}`;
          agent = await createAgent({
            slug: finalAgentSlug,
            harnessType: "opencode",
            workingDirectory,
            initialPrompt: `[Agent slug: ${finalAgentSlug}]\n[Source: slack]\n[Thread: ${channel}/${threadTs}]`,
          });
          wasCreated = true;
        }

        const message = formatMidThreadMentionMessage(event, threadTs, eventId, finalAgentSlug);
        const callbacks = createSlackCallbacks({
          channel,
          threadTs,
          emojiTimestamp: event.ts,
          emoji: "eyes",
          requestId: correlation.requestId,
        });
        await appendToAgent(agent, message, { workingDirectory, ...callbacks });
        span.setAttribute("daemon.result", "mid_thread_mention");
        return c.json({
          success: true,
          agentSlug: finalAgentSlug,
          created: wasCreated,
          case: "mid_thread_mention",
          eventId,
          requestId: correlation.requestId,
        });
      }

      if (parsed.case === "fyi_message") {
        if (!existingAgent) {
          span.setAttribute("daemon.result", "ignored_no_agent");
          return c.json({
            success: true,
            message: "Ignored: no mention and no existing agent",
            eventId,
            requestId: correlation.requestId,
          });
        }

        const message = formatFyiMessage(event, threadTs, eventId);
        const callbacks = createSlackCallbacks({
          channel,
          threadTs,
          emojiTimestamp: threadTs,
          emoji: "thinking_face",
          requestId: correlation.requestId,
        });
        await appendToAgent(existingAgent, message, {
          workingDirectory: await getCustomerRepoPath(),
          ...callbacks,
        });
        span.setAttribute("daemon.result", "fyi_message");
        return c.json({
          success: true,
          agentSlug,
          created: false,
          case: "fyi_message",
          eventId,
          requestId: correlation.requestId,
        });
      }

      return c.json({ error: "Unknown message case" }, 500);
    },
  ).catch((error) => {
    logger.error("[Slack Webhook] Failed to handle webhook", { error, correlation });
    return c.json({ error: "Internal server error" }, 500);
  });
});

const slackPostMessage = async (
  params: Parameters<import("@slack/web-api").WebClient["chat"]["postMessage"]>[0],
  requestId?: string,
) => {
  await runSlackCommand(`await slack.chat.postMessage(${JSON.stringify(params)})`, requestId);
};

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
 * Sanitize Slack timestamp for use as slug.
 * Slack timestamps: "1234567890.123456" → "1234567890-123456"
 */
function sanitizeThreadId(ts: string): string {
  return ts.replace(/\./g, "-");
}

/**
 * Find the agent for a Slack thread using the slack-{thread_ts} naming convention.
 */
async function findAgentForThread(
  _channel: string,
  threadTs: string,
): Promise<{ agent: Awaited<ReturnType<typeof getAgent>>; agentSlug: string }> {
  const threadId = sanitizeThreadId(threadTs);
  const agentSlug = `slack-${threadId}`;
  const agent = await getAgent(agentSlug);
  return { agent, agentSlug };
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
 * Format file attachments for agent messages.
 * Includes private_url when available for curl downloads.
 */
function formatFileLines(files: GenericMessageEvent["files"] | AppMentionEvent["files"]): string[] {
  if (!files) return [];
  return files.map((file) => {
    if ("url_private" in file) return `File url_private: ${file.url_private}`;
    return `File id: ${file.id}`;
  });
}

/**
 * Format message for a new thread @mention.
 * This is a fresh conversation - provide full context.
 */
function formatNewThreadMentionMessage(
  event: AppMentionEvent | GenericMessageEvent,
  threadTs: string,
  eventId: string,
  agentSlug: string,
): string {
  const user = event.user ? `<@${event.user}>` : "unknown";
  const channel = event.channel || "unknown";
  const text = event.text || "(no text)";

  return [
    `[Agent: ${agentSlug}] New Slack thread started.`,
    `Refer to SLACK.md for how to respond via \`iterate tool slack\`.`,
    "",
    `From: ${user}`,
    `Message: ${text}`,
    ...formatFileLines(event.files),
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
  agentSlug: string,
): string {
  const user = event.user ? `<@${event.user}>` : "unknown";
  const channel = event.channel || "unknown";
  const text = event.text || "(no text)";
  const messageTs = event.ts || threadTs;

  const lines = [
    `[Agent: ${agentSlug}] You've been @mentioned in thread ${threadTs}.`,
    `Refer to SLACK.md for how to respond via \`iterate tool slack\`.`,
    "",
    `From: ${user}`,
    `Message: ${text}`,
    ...formatFileLines(event.files),
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
    ...formatFileLines(event.files),
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
