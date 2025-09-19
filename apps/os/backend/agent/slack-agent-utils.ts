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
      const threadTs =
        "thread_ts" in slackEvent && slackEvent.thread_ts ? slackEvent.thread_ts : ts;
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

export async function handleChannelJoinedEvent(_params: { channelId: string; botUserId: string }) {
  throw new Error("Not implemented");
  // const { channelId, botUserId } = params;
  // try {
  //   const messagesResult = await serverTrpc.platform.integrations.slack.getChannelHistory.query({
  //     channel: channelId,
  //     limit: 2,
  //   });

  //   if (messagesResult.messages && messagesResult.messages.length > 0) {
  //     const threadsWithMentions = R.groupBy(messagesResult.messages, (m) => m.thread_ts || m.ts);

  //     for (const [threadTs, threadMessages] of Object.entries(threadsWithMentions)) {
  //       const messageWithBotMention = threadMessages.find(
  //         (msg) => msg.type === "message" && isBotMentionedInMessage(msg, botUserId),
  //       );

  //       if (messageWithBotMention) {
  //         const priorMessages = threadMessages
  //           .map(
  //             (msg) =>
  //               `[${msg.ts}] ${msg.user ? `<@${msg.user}>` : "Unknown"}: ${msg.text || "(no text)"}`,
  //           )
  //           .join("\n");

  //         await serverTrpc.platform.integrations.slack.joinThreadWithAgent.mutate({
  //           channel: channelId,
  //           threadTs,
  //           reactToTsOverride: messageWithBotMention.ts,
  //           eventsToAdd: [
  //             {
  //               type: "CORE:LLM_INPUT_ITEM",
  //               data: {
  //                 type: "message",
  //                 role: "developer",
  //                 content: [
  //                   {
  //                     type: "input_text",
  //                     text: `Go ahead and engage with this conversation. Prior messages: ${priorMessages}`,
  //                   },
  //                 ],
  //               },
  //               triggerLLMRequest: true,
  //             },
  //           ],
  //         });
  //       }
  //     }

  //     const joinedThreadsCount = Object.entries(threadsWithMentions).filter(([_, messages]) =>
  //       messages.some((msg) => msg.type === "message" && isBotMentionedInMessage(msg, botUserId)),
  //     ).length;

  //     if (joinedThreadsCount > 0) {
  //       console.log(
  //         `[SlackAgent] Joined ${joinedThreadsCount} threads after channel_joined event in channel ${channelId}`,
  //       );
  //     }
  //   }
  // } catch (error) {
  //   console.error(`[SlackAgent] Error handling channel_joined event:`, error);
  // }
}

/**
 * Determines if a Slack event should be included in the agent's conversation context.
 * This is called within the reducer when processing SLACK:WEBHOOK_EVENT_RECEIVED events
 * to decide whether the event should be added to inputItems for LLM processing.
 *
 * Uses exhaustive matching to ensure all event types are explicitly handled.
 *
 * @param slackEvent The Slack event to check
 * @param botUserId The bot's user ID to filter out its own messages
 * @returns true if the event should be added to inputItems, false if it should be skipped
 */
export function shouldIncludeEventInConversation(
  slackEvent: SlackEvent | undefined,
  botUserId: string | undefined,
): boolean {
  if (!slackEvent) {
    return false;
  }

  // Filter out events from the bot itself
  if (botUserId && "user" in slackEvent && slackEvent.user === botUserId) {
    return false;
  }

  // Exhaustive switch on event types
  switch (slackEvent.type) {
    // ===== Currently included event types =====
    case "message": {
      const messageEvent = slackEvent as any;
      // Skip certain message subtypes (except file_share)
      if (messageEvent.subtype && messageEvent.subtype !== "file_share") {
        return false;
      }
      return true;
    }

    case "reaction_added":
    case "reaction_removed":
      // Reactions are included in context but don't trigger LLM computation
      return true;

    // ===== Event types we explicitly choose to ignore =====
    // User/member events - too noisy, not conversational
    case "user_change":
    case "member_joined_channel":
    case "member_left_channel":
      return false;

    // Channel management events - administrative, not conversational
    case "channel_created":
    case "channel_deleted":
    case "channel_rename":
    case "channel_archive":
    case "channel_unarchive":
    case "channel_history_changed":
    case "channel_shared":
    case "channel_unshared":
      return false;

    // File events (except file_share within messages)
    case "file_created":
    case "file_change":
    case "file_deleted":
    case "file_public":
    case "file_shared":
    case "file_unshared":
      return false;

    // App/bot lifecycle events
    case "app_mention":
      // TODO: Consider including app_mention in the future for direct bot mentions
      return false;
    case "app_home_opened":
    case "app_installed":
    case "app_uninstalled":
    case "app_requested":
    case "app_deleted":
      return false;

    // Team/workspace events
    case "team_join":
    case "team_rename":
    case "team_domain_change":
      return false;

    // DM/Group events
    case "im_created":
    case "im_open":
    case "im_close":
    case "im_history_changed":
    case "group_left":
    case "group_open":
    case "group_close":
    case "group_archive":
    case "group_unarchive":
    case "group_rename":
    case "group_history_changed":
      return false;

    // Message metadata events
    case "message_metadata_posted":
    case "message_metadata_updated":
    case "message_metadata_deleted":
      return false;

    // Pin events
    case "pin_added":
    case "pin_removed":
      return false;

    // Star events
    case "star_added":
    case "star_removed":
      return false;

    // Presence/DND events
    case "dnd_updated":
    case "dnd_updated_user":
      return false;

    // Emoji events
    case "emoji_changed":
      return false;

    // Subteam (user group) events
    case "subteam_created":
    case "subteam_updated":
    case "subteam_members_changed":
    case "subteam_self_added":
    case "subteam_self_removed":
      return false;

    // Workflow events
    case "workflow_published":
    case "workflow_unpublished":
    case "workflow_deleted":
    case "workflow_step_deleted":
    case "workflow_step_execute":
      return false;

    // OAuth/permission events
    case "tokens_revoked":
      return false;

    // Link sharing events
    case "link_shared":
      // TODO: Consider including link_shared for URL unfurling in the future
      return false;

    // Call events
    case "call_rejected":
      return false;

    // Shared channel events
    case "shared_channel_invite_accepted":
    case "shared_channel_invite_approved":
    case "shared_channel_invite_declined":
    case "shared_channel_invite_received":
      return false;

    // Grid migration events
    case "grid_migration_started":
    case "grid_migration_finished":
      return false;

    // Default case for exhaustive checking
    default: {
      // TypeScript's exhaustive check - if this line has an error, it means
      // there are unhandled event types that should be explicitly handled above
      const unhandledEvent: SlackEvent = slackEvent;
      console.warn(`Unhandled Slack event type: ${unhandledEvent.type}`);

      // For now, ignore any unhandled event types
      // When new event types are added to @slack/types, they'll appear here
      // and we can decide whether to include them in conversations
      return false;
    }
  }
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
