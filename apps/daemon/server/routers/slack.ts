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
  const threadTs = extractThreadTs(payload);
  const threadId = threadTs && sanitizeThreadId(threadTs);
  if (!threadId) {
    return c.json({ error: "Could not extract thread_id from payload" }, 400);
  }

  const agentSlug = `slack-${threadId}`;
  const formattedMessageResult = formatSlackMessage(payload);

  if (formattedMessageResult.result === "ignore") {
    return c.json({
      success: true,
      message: `Ignored slack webhook: ${formattedMessageResult.message}`,
    });
  }

  try {
    // Get or create agent using harness system
    const result = await getOrCreateAgent({
      slug: agentSlug,
      harnessType: "opencode",
      workingDirectory: ITERATE_REPO,
    });

    // Send message via SDK (for both new and existing agents)
    await appendToAgent(result.agent, formattedMessageResult.message);

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
function extractThreadTs(payload: unknown): string | null {
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
    return event.thread_ts;
  }

  // Otherwise use the message's own timestamp
  // This becomes the thread_ts for future replies
  if (event.ts && typeof event.ts === "string") {
    return event.ts;
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

function extractBotUserRecipientId(payload: unknown) {
  const p = payload as Pick<typeof examplePayload_newMessage, "authorizations">;
  const botUserId = p?.authorizations?.find((a) => a.is_bot)?.user_id;
  return botUserId;
}

function formatSlackMessage(payload: unknown): { result: "ignore" | "send"; message: string } {
  const threadTs = extractThreadTs(payload);
  const p = payload as Record<string, unknown>;
  const event = p.event as Record<string, unknown> | undefined;

  if (!event) return { result: "ignore", message: "no event??" };

  const botUserRecipient = extractBotUserRecipientId(payload);
  if (!botUserRecipient) return { result: "ignore", message: "no bot user recipient" };

  if ((payload as typeof examplePayload_botResponseEcho).event.bot_profile) {
    return { result: "ignore", message: "this is a bot message" };
  }

  if (!JSON.stringify(event).includes(botUserRecipient)) {
    return { result: "ignore", message: "bot was not @ mentioned" };
  }

  const user = event.user as string | undefined;
  const channel = event.channel as string | undefined;
  const text = event.text as string | undefined;

  const userPart = user ? `<@${user}>` : "unknown";
  const channelPart = channel || "unknown channel";
  const textPart = text || "(no text)";

  const lines = [
    `New Slack message from ${userPart} in ${channelPart}: ${textPart}`,
    "",
    `Before responding, use the following CLI command to reply to the message:`,
    `\`iterate tool send-slack-message --channel ${channelPart} --thread-ts ${threadTs} --message "<your response here>"\` `,
  ];

  return { result: "send", message: lines.join("\n") };
}

const examplePayload_newMessage = {
  token: "OEdw6XpFLUAfJcE5HsGiIUT9",
  team_id: "T0675PSN873",
  api_app_id: "A09A308RAT0",
  event: {
    type: "app_mention",
    user: "U099JH9TAF2",
    ts: "1768573695.379969",
    client_msg_id: "b6512af0-40d6-4315-84ea-a5a88295ef50",
    text: "<@U09A56SNV9A> what is 2+2",
    team: "T0675PSN873",
    blocks: [
      {
        type: "rich_text",
        block_id: "wA8vk",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "user", user_id: "U09A56SNV9A" },
              { type: "text", text: " what is 2+2" },
            ],
          },
        ],
      },
    ],
    channel: "C09B4EGQT7E",
    event_ts: "1768573695.379969",
  },
  type: "event_callback",
  event_id: "Ev0A94C111L6",
  event_time: 1768573695,
  authorizations: [
    {
      enterprise_id: null,
      team_id: "T0675PSN873",
      user_id: "U09A56SNV9A",
      is_bot: true,
      is_enterprise_install: false,
    },
  ],
  is_ext_shared_channel: false,
  event_context:
    "4-eyJldCI6ImFwcF9tZW50aW9uIiwidGlkIjoiVDA2NzVQU044NzMiLCJhaWQiOiJBMDlBMzA4UkFUMCIsImNpZCI6IkMwOUI0RUdRVDdFIn0",
};
const examplePayload_botResponseEcho = {
  token: "OEdw6XpFLUAfJcE5HsGiIUT9",
  team_id: "T0675PSN873",
  context_team_id: "T0675PSN873",
  context_enterprise_id: null,
  api_app_id: "A09A308RAT0",
  event: {
    type: "message",
    user: "U09A56SNV9A",
    ts: "1768573701.097949",
    bot_id: "B09A56SNH1A",
    app_id: "A09A308RAT0",
    text: "4",
    team: "T0675PSN873",
    bot_profile: {
      id: "B09A56SNH1A",
      deleted: false,
      name: "(mmkal local) Iterate",
      updated: 1755012483,
      app_id: "A09A308RAT0",
      user_id: "U09A56SNV9A",
      icons: {
        image_36: "https://a.slack-edge.com/80588/img/plugins/app/bot_36.png",
        image_48: "https://a.slack-edge.com/80588/img/plugins/app/bot_48.png",
        image_72: "https://a.slack-edge.com/80588/img/plugins/app/service_72.png",
      },
      team_id: "T0675PSN873",
    },
    thread_ts: "1768573695.379969",
    parent_user_id: "U099JH9TAF2",
    blocks: [
      {
        type: "rich_text",
        block_id: "KLXqF",
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "4" }] }],
      },
    ],
    channel: "C09B4EGQT7E",
    event_ts: "1768573701.097949",
    channel_type: "channel",
  },
  type: "event_callback",
  event_id: "Ev0A94C0QY78",
  event_time: 1768573701,
  authorizations: [
    {
      enterprise_id: null,
      team_id: "T0675PSN873",
      user_id: "U09A56SNV9A",
      is_bot: true,
      is_enterprise_install: false,
    },
  ],
  is_ext_shared_channel: false,
  event_context:
    "4-eyJldCI6Im1lc3NhZ2UiLCJ0aWQiOiJUMDY3NVBTTjg3MyIsImFpZCI6IkEwOUEzMDhSQVQwIiwiY2lkIjoiQzA5QjRFR1FUN0UifQ",
};
