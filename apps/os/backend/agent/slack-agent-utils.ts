import { createHash } from "node:crypto";
import type { SlackEvent } from "@slack/types";
import { eq, asc } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import { slackWebhookEvent } from "../db/schema.ts";
import type { SlackWebhookPayload } from "./slack.types";

export function getMentionedExternalUserIds(body: string) {
  const mentionRegex = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
  const matches = Array.from(body.matchAll(mentionRegex));
  return matches.map((match) => match[1]);
}

export function isBotMentionedInMessage(
  slackEvent: { user?: string; text?: string; type?: string },
  botUserId: string,
): boolean {
  // Skip messages from the bot itself - they shouldn't be treated as mentions
  if ("user" in slackEvent && slackEvent.user === botUserId) {
    return false;
  }

  // app_mention events are always mentions of the bot
  if (slackEvent.type === "app_mention") {
    return true;
  }

  // For message events, check if the text contains a mention
  if (slackEvent.type === "message") {
    if ("text" in slackEvent && slackEvent.text) {
      return getMentionedExternalUserIds(slackEvent.text).includes(botUserId);
    }
  }
  return false;
}

export async function getMessageMetadata(
  slackEvent: SlackEvent,
  db: DB,
): Promise<{
  channel: string | undefined;
  threadTs: string | undefined;
  ts: string | undefined;
}> {
  const ts = extractTs(slackEvent)!;
  switch (slackEvent.type) {
    case "app_mention":
    case "message": {
      let threadTs: string | undefined;
      // case 1: we are inside a thread, so thread_ts is specified
      if ("thread_ts" in slackEvent && slackEvent.thread_ts) {
        threadTs = slackEvent.thread_ts;
      }
      // case 2: an event happened to a message, and thread_ts is specified on that message
      if (
        "message" in slackEvent &&
        "thread_ts" in slackEvent.message &&
        slackEvent.message.thread_ts
      ) {
        threadTs = slackEvent.message.thread_ts;
      }
      // case 3: no thread_ts is specified, so it's a thread starter, and we use the ts of the message itself
      if (!threadTs) {
        threadTs = ts;
      }
      return {
        channel: slackEvent.channel,
        threadTs: threadTs,
        ts: ts,
      };
    }
    case "reaction_added":
    case "reaction_removed": {
      const parentMessageTs = slackEvent.item.ts;
      const parentMessage = await db
        .select({ threadTs: slackWebhookEvent.thread_ts, ts: slackWebhookEvent.ts })
        .from(slackWebhookEvent)
        .where(eq(slackWebhookEvent.ts, parentMessageTs))
        .orderBy(asc(slackWebhookEvent.ts))
        .limit(1);
      if (parentMessage.length === 0) {
        return {
          channel: slackEvent.item.channel,
          threadTs: undefined,
          ts: undefined,
        };
      }
      const threadTs = parentMessage[0].threadTs || parentMessage[0].ts;

      return {
        channel: slackEvent.item.channel,
        threadTs: threadTs || undefined,
        ts: ts,
      };
    }
    default:
      return {
        channel: extractChannelId(slackEvent),
        threadTs: "thread_ts" in slackEvent ? slackEvent.thread_ts : ts,
        ts: undefined,
      };
  }
}

export function slackWebhookEventToIdempotencyKey(
  payload: SlackWebhookPayload | undefined,
): string {
  if (!payload || !payload.event) {
    return "";
  }
  const { token: _, ...payloadWithoutToken } = payload;
  const sortObjectKeys = (obj: any): any => {
    if (obj === null || typeof obj !== "object") {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(sortObjectKeys);
    }
    return Object.keys(obj)
      .sort()
      .reduce((sorted: any, key) => {
        sorted[key] = sortObjectKeys(obj[key]);
        return sorted;
      }, {});
  };
  const sortedPayload = sortObjectKeys(payloadWithoutToken);
  const hash = createHash("sha256").update(JSON.stringify(sortedPayload)).digest("hex");
  return `slack-webhook-${hash}`;
}

/**
 * Generates an idempotency key for Slack webhook events to prevent double-logging
 * duplicative webhooks. This is necessary because we sometimes receive duplicate
 * webhooks from Slack for unknown reasons.
 *
 * The function creates a hash of the webhook payload excluding the top-level "token"
 * property, which can vary between duplicate webhooks.
 */
/**
 * Extracts the bot user ID from a Slack webhook payload's authorizations field.
 * According to the Slack Events API documentation, the authorizations field contains
 * one installation of the app that the event is visible to, with is_bot indicating
 * whether it's a bot user.
 */
export function extractBotUserIdFromAuthorizations(
  payload: SlackWebhookPayload,
): string | undefined {
  const botAuthorization = payload.authorizations?.find((auth) => auth.is_bot);
  return botAuthorization?.user_id;
}

export function shouldUnfurlSlackMessage(params: {
  text: string;
  unfurl: "never" | "auto" | "all" | undefined;
}): boolean {
  const { text, unfurl } = params;

  if (unfurl === "never") {
    return false;
  }

  if (unfurl === "all") {
    return true;
  }

  const links = text.match(/https?:\/\/[^\s|]+/g) ?? [];
  const hasOsIterateLink = links.some((link) => {
    try {
      return new URL(link).hostname === "os.iterate.com";
    } catch {
      return false;
    }
  });

  if (hasOsIterateLink) {
    return false;
  }

  const preference = unfurl ?? "auto";
  return preference === "auto" && links.length === 1;
}

export const extractUserId = (event: SlackEvent): string | undefined => {
  if (!("user" in event)) {
    return undefined;
  }
  const user = event.user;
  if (typeof user === "string") {
    return user;
  }
  if (user && typeof user === "object" && "id" in user && typeof user.id === "string") {
    return user.id;
  }
  return undefined;
};

export const extractChannelId = (event: SlackEvent): string | undefined => {
  if (!("channel" in event)) {
    return undefined;
  }
  const channel = event.channel;
  if (typeof channel === "string") {
    return channel;
  }
  if (channel && typeof channel === "object" && "id" in channel && typeof channel.id === "string") {
    return channel.id;
  }
  return undefined;
};

export const extractTs = (event: SlackEvent): string | undefined => {
  let ts: string | undefined = undefined;
  if ("ts" in event) {
    ts = event.ts;
  }
  if (!ts && "event_ts" in event) {
    ts = event.event_ts;
  }
  return ts;
};
