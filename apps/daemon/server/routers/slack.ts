/**
 * Slack Webhook Router
 *
 * Handles incoming Slack webhooks forwarded from the OS backend.
 * Creates/reuses agents per Slack thread and sends formatted messages.
 * Uses the harness system for SDK-based session management.
 */
import { Hono } from "hono";
import { getOrCreateAgent, appendToAgent } from "../services/agent-manager.ts";

// Simple structured logger for daemon
const logger = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: "info", msg, ...data })),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: "error", msg, ...data })),
};

// Working directory for agents - root of iterate repo
const ITERATE_REPO = "/root/src/github.com/iterate/iterate";

export const slackRouter = new Hono();

slackRouter.post("/webhook", async (c) => {
  const payload = await c.req.json();

  // Extract thread ID from payload
  const threadId = extractThreadId(payload);
  if (!threadId) {
    return c.json({ error: "Could not extract thread_id from payload" }, 400);
  }

  const agentSlug = `slack-${threadId}`;
  const formattedMessage = formatSlackMessage(payload);

  try {
    // Get or create agent using harness system
    const result = await getOrCreateAgent({
      slug: agentSlug,
      harnessType: "opencode",
      workingDirectory: ITERATE_REPO,
    });

    // Send message via SDK (for both new and existing agents)
    await appendToAgent(result.agent, formattedMessage);

    return c.json({
      success: true,
      agentSlug,
      created: result.wasCreated,
    });
  } catch (error) {
    logger.error("[Slack Webhook] Failed to handle webhook", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Extract thread_id from Slack webhook payload.
 *
 * Priority:
 * 1. event.thread_ts - If this is a reply in a thread
 * 2. event.ts - The message timestamp (becomes thread_ts for replies)
 *
 * Thread IDs look like: "1234567890.123456"
 * We sanitize them to "1234567890-123456" for valid slug format.
 */
function extractThreadId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const p = payload as Record<string, unknown>;
  const event = p.event as Record<string, unknown> | undefined;

  if (!event) {
    return null;
  }

  // If it's a reply, use the thread_ts (parent message timestamp)
  if (event.thread_ts && typeof event.thread_ts === "string") {
    return sanitizeThreadId(event.thread_ts);
  }

  // Otherwise use the message's own timestamp
  // This becomes the thread_ts for future replies
  if (event.ts && typeof event.ts === "string") {
    return sanitizeThreadId(event.ts);
  }

  return null;
}

/**
 * Sanitize Slack timestamp for use as slug.
 * Slack timestamps: "1234567890.123456" → "1234567890-123456"
 */
function sanitizeThreadId(ts: string): string {
  return ts.replace(/\./g, "-");
}

/**
 * Format Slack webhook payload into a human-readable message.
 * Format: "New Slack message from <@user> in channel: {text}"
 */
function formatSlackMessage(payload: unknown): string {
  const p = payload as Record<string, unknown>;
  const event = p.event as Record<string, unknown> | undefined;

  if (!event) {
    return JSON.stringify(payload);
  }

  const user = event.user as string | undefined;
  const channel = event.channel as string | undefined;
  const text = event.text as string | undefined;

  const userPart = user ? `<@${user}>` : "unknown";
  const channelPart = channel || "unknown channel";
  const textPart = text || "(no text)";
  let ts = "";
  let threadTs = "";
  JSON.stringify(event, (key, value) => {
    if (key === "ts") {
      ts = value as string;
    }
    if (key === "thread_ts") {
      threadTs = value as string;
    }
    return value;
  });

  return [
    `New Slack message from ${userPart} in ${channelPart}: ${textPart}`,
    "",
    `Before responding, use the following CLI command to reply to the message:`,
    `\`iterate tools send-slack-message --channel ${channelPart} --thread-ts ${threadTs || ts} --message "<your response here>"\` `,
  ].join("\n");
}
