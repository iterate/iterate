// @ts-nocheck

import { createHash } from "crypto";
import type { SlackEvent } from "@slack/types";
import * as R from "remeda";
import { serverTrpc } from "../legacy-agent/trpc/trpc.ts";
import type { SlackWebhookPayload } from "./slack.types.ts";
import { shouldIncludeEventInConversation } from "./slack-filters.ts";

export function getMentionedExternalUserIds(body: string) {
  const mentionRegex = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
  const matches = Array.from(body.matchAll(mentionRegex));
  return matches.map((match) => match[1]);
}

export function isBotMentionedInMessage(
  slackEvent: { user?: string; text?: string; type: string },
  botUserId: string,
): boolean {
  // Skip messages from the bot itself - they shouldn't be treated as mentions
  if ("user" in slackEvent && slackEvent.user === botUserId) {
    return false;
  }

  if (slackEvent.type === "message") {
    if ("text" in slackEvent && slackEvent.text) {
      return getMentionedExternalUserIds(slackEvent.text).includes(botUserId);
    }
  }
  return false;
}

export async function getThreadId(slackEvent: SlackEvent) {
  if (slackEvent.type === "message") {
    return "thread_ts" in slackEvent ? slackEvent.thread_ts : slackEvent.ts;
  }
  if (slackEvent.type === "app_mention") {
    return slackEvent.thread_ts;
  }
  if (slackEvent.type === "reaction_added" || slackEvent.type === "reaction_removed") {
    return await serverTrpc.platform.integrations.slack.getThreadTsForMessage.query({
      messageTs: slackEvent.item.ts,
    });
  }

  return null;
}

export async function getMessageMetadata(slackEvent: SlackEvent) {
  switch (slackEvent.type) {
    case "app_mention":
    case "message": {
      const threadTs =
        "thread_ts" in slackEvent && slackEvent.thread_ts ? slackEvent.thread_ts : slackEvent.ts;
      return {
        channel: slackEvent.channel,
        threadTs: threadTs,
        messageTs: slackEvent.ts,
      };
    }
    case "reaction_added":
    case "reaction_removed": {
      const threadTs = await getThreadId(slackEvent);

      return {
        channel: slackEvent.item.channel,
        threadTs: threadTs || slackEvent.item.ts,
        messageTs: slackEvent.item.ts,
      };
    }
    default:
      return null;
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

export async function handleChannelJoinedEvent(params: { channelId: string; botUserId: string }) {
  const { channelId, botUserId } = params;

  try {
    const messagesResult = await serverTrpc.platform.integrations.slack.getChannelHistory.query({
      channel: channelId,
      limit: 2,
    });

    if (messagesResult.messages && messagesResult.messages.length > 0) {
      const threadsWithMentions = R.groupBy(messagesResult.messages, (m) => m.thread_ts || m.ts);

      for (const [threadTs, threadMessages] of Object.entries(threadsWithMentions)) {
        const messageWithBotMention = threadMessages.find(
          (msg) => msg.type === "message" && isBotMentionedInMessage(msg, botUserId),
        );

        if (messageWithBotMention) {
          const priorMessages = threadMessages
            .map(
              (msg) =>
                `[${msg.ts}] ${msg.user ? `<@${msg.user}>` : "Unknown"}: ${msg.text || "(no text)"}`,
            )
            .join("\n");

          await serverTrpc.platform.integrations.slack.joinThreadWithAgent.mutate({
            channel: channelId,
            threadTs,
            reactToTsOverride: messageWithBotMention.ts,
            eventsToAdd: [
              {
                type: "CORE:LLM_INPUT_ITEM",
                data: {
                  type: "message",
                  role: "developer",
                  content: [
                    {
                      type: "input_text",
                      text: `Go ahead and engage with this conversation. Prior messages: ${priorMessages}`,
                    },
                  ],
                },
                triggerLLMRequest: true,
              },
            ],
          });
        }
      }

      const joinedThreadsCount = Object.entries(threadsWithMentions).filter(([_, messages]) =>
        messages.some((msg) => msg.type === "message" && isBotMentionedInMessage(msg, botUserId)),
      ).length;

      if (joinedThreadsCount > 0) {
        console.log(
          `[SlackAgent] Joined ${joinedThreadsCount} threads after channel_joined event in channel ${channelId}`,
        );
      }
    }
  } catch (error) {
    console.error(`[SlackAgent] Error handling channel_joined event:`, error);
  }
}

export async function reactToSlackWebhook(slackWebhookPayload: SlackWebhookPayload) {
  const botUserId = extractBotUserIdFromAuthorizations(slackWebhookPayload);

  if (!botUserId || !slackWebhookPayload.event) {
    return;
  }

  const messageMetadata = await getMessageMetadata(slackWebhookPayload.event);
  if (!messageMetadata) {
    return;
  }

  const shouldInclude = shouldIncludeEventInConversation(slackWebhookPayload.event, botUserId);

  if (shouldInclude && slackWebhookPayload.event.type === "message") {
    if (messageMetadata.channel && messageMetadata.messageTs) {
      const isMentioned = isBotMentionedInMessage(slackWebhookPayload.event, botUserId);

      if (isMentioned) {
        await serverTrpc.platform.integrations.slack.addSlackReaction
          .mutate({
            channel: messageMetadata.channel,
            timestamp: messageMetadata.messageTs,
            name: "eyes",
          })
          .then(
            () => console.log("[SlackAgent] Added eyes reaction"),
            (error) => console.error("[SlackAgent] Failed to add eyes reaction", error),
          );
      }
    }
  }
}
