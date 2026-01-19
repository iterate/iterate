/**
 * Slack Webhook Router
 *
 * Handles incoming Slack webhooks forwarded from the OS backend.
 * Creates/reuses agents per Slack thread and sends formatted messages.
 * Uses the harness system for SDK-based session management.
 */
import { Hono } from "hono";
import { getAgent, createAgent, appendToAgent } from "../services/agent-manager.ts";

const logger = console;

// Working directory for agents - uses ITERATE_REPO env var with fallback to sandbox path
const ITERATE_REPO = process.env.ITERATE_REPO || "/home/iterate/src/github.com/iterate/iterate";

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
  const messageInfo = parseSlackPayload(payload);

  // Ignore bot messages
  if (messageInfo.isBotMessage) {
    return c.json({ success: true, message: "Ignored: bot message" });
  }

  // Ignore messages without bot authorization
  if (!messageInfo.botUserId) {
    return c.json({ success: true, message: "Ignored: no bot user recipient" });
  }

  try {
    const existingAgent = await getAgent(agentSlug);
    const isMention = messageInfo.isBotMentioned;

    // Case 1: @mention - create agent if needed and send with CLI instructions
    if (isMention) {
      let agent = existingAgent;
      let wasCreated = false;

      if (!agent) {
        agent = await createAgent({
          slug: agentSlug,
          harnessType: "opencode",
          workingDirectory: ITERATE_REPO,
        });
        wasCreated = true;
      }

      const message = formatMentionMessage(messageInfo, threadTs!);
      await appendToAgent(agent, message);

      return c.json({ success: true, agentSlug, created: wasCreated });
    }

    // Case 2: No @mention but agent exists - send FYI message
    if (existingAgent) {
      const message = formatFyiMessage(messageInfo, threadTs!);
      await appendToAgent(existingAgent, message);

      return c.json({ success: true, agentSlug, created: false, fyi: true });
    }

    // Case 3: No @mention and no agent - ignore
    return c.json({ success: true, message: "Ignored: no mention and no existing agent" });
  } catch (error) {
    logger.error("[Slack Webhook] Failed to handle webhook", error);
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

interface SlackMessageInfo {
  user: string | undefined;
  channel: string | undefined;
  text: string | undefined;
  botUserId: string | undefined;
  isBotMessage: boolean;
  isBotMentioned: boolean;
}

function parseSlackPayload(payload: unknown): SlackMessageInfo {
  const p = payload as Record<string, unknown>;
  const event = p.event as Record<string, unknown> | undefined;

  const botUserId = (
    p as Pick<typeof _examplePayload_newMessage, "authorizations">
  )?.authorizations?.find((a) => a.is_bot)?.user_id;

  const isBotMessage = !!(payload as typeof _examplePayload_botResponseEcho).event?.bot_profile;

  const user = event?.user as string | undefined;
  const channel = event?.channel as string | undefined;
  const text = event?.text as string | undefined;

  const isBotMentioned = botUserId ? JSON.stringify(event).includes(botUserId) : false;

  return { user, channel, text, botUserId, isBotMessage, isBotMentioned };
}

function formatMentionMessage(info: SlackMessageInfo, threadTs: string): string {
  const userPart = info.user ? `<@${info.user}>` : "unknown";
  const channelPart = info.channel || "unknown channel";
  const textPart = info.text || "(no text)";

  return [
    `New Slack message from ${userPart} in ${channelPart}: ${textPart}`,
    "",
    `Before responding, use the following CLI command to reply to the message:`,
    `\`iterate tool send-slack-message --channel ${channelPart} --thread-ts ${threadTs} --message "<your response here>"\` `,
  ].join("\n");
}

function formatFyiMessage(info: SlackMessageInfo, threadTs: string): string {
  const userPart = info.user ? `<@${info.user}>` : "unknown";
  const channelPart = info.channel || "unknown channel";
  const textPart = info.text || "(no text)";

  return [
    `FYI, there was another message in this Slack thread from ${userPart} in ${channelPart}: ${textPart}`,
    "",
    `If you are SURE this is a direct question to you, you can use the CLI to reply:`,
    `\`iterate tool slack 'await slack.chat.postMessage({
      channel: "${channelPart}",
      thread_ts: "${threadTs}",
      text: "<your response here>",
    })'`,
  ].join("\n");
}

const _examplePayload_newMessage = {
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
const _examplePayload_botResponseEcho = {
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
