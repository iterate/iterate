// ------------------------- Event Schemas -------------------------

import z from "zod";
import { exhaustiveMatchingGuard, JSONSerializable } from "../utils/type-helpers.ts";
import { agentCoreBaseEventFields, type CoreReducedState } from "./agent-core-schemas.ts";
import { type SlackWebhookPayload } from "./slack.types.ts";
import { defineAgentCoreSlice } from "./agent-core.ts";
import {
  extractBotUserIdFromAuthorizations,
  isBotMentionedInMessage,
} from "./slack-agent-utils.ts";
import { f, PromptFragment, renderPromptFragment } from "./prompt-fragments.ts";

// SLACK:WEBHOOK_EVENT_RECEIVED
export const slackWebhookEventReceivedFields = {
  type: z.literal("SLACK:WEBHOOK_EVENT_RECEIVED"),
  data: z.object({
    /** The full webhook payload from Slack */
    payload: JSONSerializable,
    /** Whether to update thread IDs based on this webhook */
    updateThreadIds: z.boolean().optional(),
  }),
};

export const SlackWebhookEventReceived = z.object({
  ...agentCoreBaseEventFields,
  ...slackWebhookEventReceivedFields,
});

// SLACK:UPDATE_SLICE_STATE
export const slackUpdateSliceStateFields = {
  type: z.literal("SLACK:UPDATE_SLICE_STATE"),
  data: z.object({
    slackChannelId: z.string().nullable().optional(),
    slackThreadId: z.string().nullable().optional(),
    slackChannel: z
      .object({
        name: z.string(),
        isShared: z.boolean(),
        isExtShared: z.boolean(),
      })
      .nullable()
      .optional(),
    estateName: z.string().nullable().optional(),
  }),
};

export const SlackUpdateSliceState = z.object({
  ...agentCoreBaseEventFields,
  ...slackUpdateSliceStateFields,
});

// SLACK:UPDATE_TYPING_STATUS
export const slackUpdateTypingStatusFields = {
  type: z.literal("SLACK:UPDATE_TYPING_STATUS"),
  data: z.object({
    status: z.string().nullable(),
  }),
};

export const SlackUpdateTypingStatus = z.object({
  ...agentCoreBaseEventFields,
  ...slackUpdateTypingStatusFields,
});

// ------------------------- Discriminated Unions -------------------------

export const SlackSliceEvent = z.discriminatedUnion("type", [
  SlackWebhookEventReceived,
  SlackUpdateSliceState,
  SlackUpdateTypingStatus,
]);

// ------------------------- Types -------------------------

export type SlackWebhookEventReceived = z.infer<typeof SlackWebhookEventReceived>;
export type SlackUpdateSliceState = z.infer<typeof SlackUpdateSliceState>;
export type SlackUpdateTypingStatus = z.infer<typeof SlackUpdateTypingStatus>;
export type SlackSliceEvent = z.infer<typeof SlackSliceEvent>;

export interface SlackSliceState {
  slackThreadId?: string | null;
  slackChannelId?: string | null;
  slackChannel?: {
    name: string;
    isShared: boolean;
    isExtShared: boolean;
  } | null;
  botUserId?: string;
  typingIndicatorStatus?: string | null;
  estateName?: string | null;
}

export interface SlackSliceDeps {}

export const slackSlice = defineAgentCoreSlice<{
  SliceState: SlackSliceState;
  EventSchema: typeof SlackSliceEvent;
  SliceDeps: SlackSliceDeps;
}>({
  name: "slack-slice",
  eventSchema: SlackSliceEvent,
  initialState: {
    slackThreadId: undefined,
    slackChannelId: undefined,
    slackChannel: undefined,
    botUserId: undefined,
    typingIndicatorStatus: null,
    estateName: undefined,
  },
  reduce(state, _deps, event) {
    const next = { ...state };

    switch (event.type) {
      case "SLACK:UPDATE_SLICE_STATE": {
        if (event.data.slackChannelId !== undefined) {
          next.slackChannelId = event.data.slackChannelId;
        }
        if (event.data.slackThreadId !== undefined) {
          next.slackThreadId = event.data.slackThreadId;
        }
        if (event.data.slackChannel !== undefined) {
          next.slackChannel = event.data.slackChannel;
        }
        if (event.data.estateName !== undefined) {
          next.estateName = event.data.estateName;
        }
        break;
      }

      case "SLACK:UPDATE_TYPING_STATUS": {
        next.typingIndicatorStatus = event.data.status;
        break;
      }

      case "SLACK:WEBHOOK_EVENT_RECEIVED": {
        const payload = event.data.payload as SlackWebhookPayload;

        if (next.botUserId === undefined) {
          const extractedBotUserId = extractBotUserIdFromAuthorizations(payload);
          if (extractedBotUserId) {
            next.botUserId = extractedBotUserId;
          }
        }

        const {
          promptFragment: messageContent,
          shouldTriggerLLM,
          role,
        } = slackWebhookEventToPromptFragment({
          webhookEvent: event,
          botUserId: next.botUserId,
        });
        const renderedMessageContent = renderPromptFragment(messageContent);
        if (renderedMessageContent) {
          const message = {
            type: "message" as const,
            role: role ?? "developer",
            content: [
              {
                type: "input_text" as const,
                text: renderedMessageContent,
              },
            ],
          };
          next.inputItems = [...next.inputItems, message];
        }

        // Check if the user who sent the message is in participants.
        // This filters out messages from users who are not participants and the agent would be in read-only mode for them.
        // Support both 'message' and 'app_mention' event types
        let userIsJoinedParticipant = false;
        if (
          (payload.event?.type === "message" || payload.event?.type === "app_mention") &&
          "user" in payload.event &&
          payload.event.user
        ) {
          const slackUserId = payload.event.user;
          userIsJoinedParticipant = Object.values(next.participants || {}).some(
            (participant) => participant.externalUserMapping?.slack?.externalUserId === slackUserId,
          );

          import("../tag-logger.ts").then(({ logger }) => {
            logger.info(
              `[slack-slice] type=${payload.event?.type}, user=${slackUserId}, isParticipant=${userIsJoinedParticipant}, participantCount=${Object.keys(next.participants || {}).length}`,
            );
          });

          // hack to make evals/e2e tests get responses for now
          // TODO: remove! we need to just send the approrpriate add participant events for the test users
          if (slackUserId === "UALICE" || slackUserId === "UBOB") userIsJoinedParticipant = true;
        }

        const finalTrigger = shouldTriggerLLM && !next.paused && userIsJoinedParticipant;

        import("../tag-logger.ts").then(({ logger }) => {
          logger.info(
            `[slack-slice] Final LLM trigger decision: shouldTriggerLLM=${shouldTriggerLLM}, paused=${next.paused}, userIsParticipant=${userIsJoinedParticipant}, FINAL=${finalTrigger}`,
          );
        });

        next.triggerLLMRequest = finalTrigger;
        break;
      }
    }

    // Set the slack context as an ephemeral prompt fragment
    // This will be automatically included in LLM requests as a developer message
    // and reset on each reducer run
    if (next.slackChannelId) {
      next.contextRules["slack-context"] = {
        key: "slack-context",
        prompt: createSlackContextForState({
          state: next as CoreReducedState<SlackSliceEvent> & SlackSliceState,
          botUserId: next.botUserId,
        }),
      };
    }

    // CRITICAL: Always force toolChoice to "required" for Slack agent
    // This ensures that the LLM will always attempt to use tools when available,
    // which is critical for Slack integration functionality like message posting
    next.modelOpts = {
      ...next.modelOpts,
      toolChoice: "required",
    };

    return next;
  },
});

export type SlackSlice = typeof slackSlice;

// ---------------------------------------------------------------------------
// LLM prompt/context engineering below
// Changing any of these helpers will directly change what the LLM sees.
// ---------------------------------------------------------------------------

export function createSlackContextForState(params: {
  state: CoreReducedState<SlackSliceEvent> & SlackSliceState;
  botUserId?: string;
}): PromptFragment {
  const { state, botUserId } = params;
  const promptFragment: PromptFragment = [];

  const channelThreadInfo: PromptFragment = [];

  if (state.estateName) {
    channelThreadInfo.push(`Estate: ${state.estateName}`);
  }

  if (state.slackChannelId) {
    channelThreadInfo.push(`Current channel ID: ${state.slackChannelId}`);
  }
  if (state.slackThreadId) {
    channelThreadInfo.push(`Current thread ID: ${state.slackThreadId}`);
  }

  if (state.slackChannel?.name) {
    channelThreadInfo.push(`Current channel name: ${state.slackChannel.name}`);
  }

  if (state.slackChannel?.isShared || state.slackChannel?.isExtShared) {
    channelThreadInfo.push("Current channel is shared with external users");
  } else {
    channelThreadInfo.push("Current channel is not shared with external users");
  }

  promptFragment.push(f("slack_channel_thread_info", channelThreadInfo));

  const userMap: Record<
    string,
    {
      name: string;
      email?: string;
      avatarUrl?: string;
      iterateUserID?: string;
      slackUserId: string;
      note?: string;
      role?: "member" | "admin" | "owner" | "guest" | "external";
    }
  > = {};

  if (state.participants) {
    for (const [internalUserId, participant] of Object.entries(state.participants)) {
      const slackMapping = participant.externalUserMapping?.slack;
      if (slackMapping) {
        userMap[slackMapping.externalUserId] = {
          name: participant.displayName || "",
          email: participant.email,
          slackUserId: slackMapping.externalUserId,
          iterateUserID: internalUserId,
          role: participant.role,
        };
        const profile = slackMapping.rawUserInfo?.profile;
        if (
          profile &&
          typeof profile === "object" &&
          "image_1024" in profile &&
          typeof profile.image_1024 === "string"
        ) {
          userMap[slackMapping.externalUserId].avatarUrl = profile.image_1024;
        }
      }
    }
  }

  if (state.mentionedParticipants) {
    for (const [internalUserId, participant] of Object.entries(state.mentionedParticipants)) {
      const slackMapping = participant.externalUserMapping?.slack;
      if (!slackMapping) {
        continue;
      }
      userMap[slackMapping.externalUserId] = {
        name: participant.displayName || participant.email || "",
        email: participant.email,
        slackUserId: slackMapping.externalUserId,
        iterateUserID: internalUserId,
        note: "(mentioned but not active participant)",
        role: participant.role,
      };
      const profile = slackMapping.rawUserInfo?.profile;
      if (
        profile &&
        typeof profile === "object" &&
        "image_1024" in profile &&
        typeof profile.image_1024 === "string"
      ) {
        userMap[slackMapping.externalUserId].avatarUrl = profile.image_1024;
      }
    }
  }

  if (botUserId) {
    userMap[botUserId] = {
      name: "Iterate bot",
      slackUserId: botUserId,
      note: "This is you! Messages sent via sendSlackMessage by you will appear to the user as coming from this slack bot.",
    };
  }

  promptFragment.push(
    f("slack_user_mappings", [
      JSON.stringify(userMap, null, 2),
      "This mapping shows all Slack users in this conversation, including active participants and mentioned users. Users marked with '(mentioned but not active participant)' have been mentioned but haven't sent any messages yet. The user emails are needed to make tool calls on behalf of users.",
    ]),
  );

  return f("slack_context", promptFragment);
}

/**
 * Turn a Slack webhook event into zero or more messages and determine if LLM should be triggered.
 */
export function slackWebhookEventToPromptFragment(params: {
  webhookEvent: SlackWebhookEventReceived;
  botUserId: string | undefined;
}): {
  promptFragment: PromptFragment;
  shouldTriggerLLM: boolean;
  role?: "developer" | "user";
} {
  const { webhookEvent, botUserId } = params;
  const payload = webhookEvent.data.payload as SlackWebhookPayload;
  const slackEvent = payload.event;

  if (!slackEvent) {
    return { promptFragment: null, shouldTriggerLLM: false, role: "developer" };
  }

  // Handle different Slack event types
  switch (slackEvent.type) {
    case "message": {
      // type: message events have _lots_ of subtypes
      switch (slackEvent.subtype) {
        case "message_deleted":
        case "channel_join":
        case "channel_leave":
        case "channel_topic":
        case "channel_purpose":
        case "channel_name":
        case "channel_posting_permissions":
        case "me_message":
        case "message_replied":
        case "ekm_access_denied":
        case "message_changed":
        case "channel_archive":
        case "channel_unarchive":
          // No idea what these do but useful to know they exist
          return {
            promptFragment: null,
            shouldTriggerLLM: false,
            role: "developer",
          };

        // file_share also falls through to default
        default: {
          // Regular message (no subtype)
          const isOurBotMessage = slackEvent.user === botUserId;
          const isFromAnyBot = "bot_id" in slackEvent || isOurBotMessage;

          // Our own bot's messages should never trigger LLM
          if (isOurBotMessage) {
            return {
              promptFragment: [
                "You have sent a message via Slack:",
                JSON.stringify(
                  {
                    user: slackEvent.user || "bot",
                    text: slackEvent.text,
                    ts: slackEvent.ts,
                    createdAt: webhookEvent.createdAt,
                  },
                  null,
                  2,
                ),
              ],
              shouldTriggerLLM: false,
              role: "developer",
            };
          }

          // Messages from other bots: allow through if they at-mention our bot
          if (isFromAnyBot) {
            const textMentionsBot = botUserId && isBotMentionedInMessage(slackEvent, botUserId);
            return {
              promptFragment: [
                "Message from a different bot via Slack webhook:",
                JSON.stringify(
                  {
                    user: slackEvent.user || "bot",
                    text: slackEvent.text,
                    ts: slackEvent.ts,
                    createdAt: webhookEvent.createdAt,
                  },
                  null,
                  2,
                ),
              ],
              shouldTriggerLLM: !!textMentionsBot,
              role: "developer",
            };
          }

          // Human-authored message: include and trigger
          return {
            promptFragment: [
              "User message via Slack webhook:",
              JSON.stringify(
                {
                  user: slackEvent.user,
                  text: slackEvent.text,
                  ts: slackEvent.ts,
                  createdAt: webhookEvent.createdAt,
                },
                null,
                2,
              ),
            ],
            shouldTriggerLLM: true,
            role: "developer", // TODO maybe should be "user" after all
          };
        }
      }
    }

    case "reaction_added":
    case "reaction_removed":
      if (slackEvent.user === botUserId) {
        // Include bot reactions in context but don't trigger LLM
        return {
          promptFragment: [
            `Bot ${slackEvent.type === "reaction_added" ? "added" : "removed"} reaction ${slackEvent.reaction} from slack message with ts ${slackEvent.event_ts} at ${webhookEvent.createdAt}`,
          ],
          shouldTriggerLLM: false,
          role: "developer",
        };
      }
      return {
        promptFragment: [
          `User ${slackEvent.user} ${slackEvent.type === "reaction_added" ? "added" : "removed"} reaction ${slackEvent.reaction} from slack message with ts ${slackEvent.event_ts} at ${webhookEvent.createdAt}`,
        ],
        shouldTriggerLLM: slackEvent.item_user === botUserId,
        role: "developer",
      };

    // List of all other slack webhook events that exist
    // You can drop into any of the case statements and use
    // the language server autocomplete on slackEvent.* to see
    // what's in it - typescript is better than the slack docs!

    case "app_mention":
      // app_mention events are sent when the bot is @-mentioned
      // Treat them similarly to regular messages
      return {
        promptFragment: [
          "User mentioned bot via Slack:",
          JSON.stringify(
            {
              user: slackEvent.user,
              text: slackEvent.text,
              ts: slackEvent.ts,
              createdAt: webhookEvent.createdAt,
            },
            null,
            2,
          ),
        ],
        shouldTriggerLLM: true,
        role: "developer",
      };

    case "member_joined_channel":
    case "member_left_channel":
    case "channel_created":
    case "channel_rename":
    case "channel_archive":
    case "channel_unarchive":
    case "app_deleted":
    case "app_home_opened":
    case "app_installed":
    case "app_rate_limited":
    case "app_requested":
    case "app_uninstalled":
    case "app_uninstalled_team":
    case "assistant_thread_context_changed":
    case "assistant_thread_started":
    case "call_rejected":
    case "channel_deleted":
    case "channel_history_changed":
    case "channel_id_changed":
    case "channel_left":
    case "channel_shared":
    case "channel_unshared":
    case "dnd_updated":
    case "dnd_updated_user":
    case "email_domain_changed":
    case "emoji_changed":
    case "file_change":
    case "file_comment_deleted":
    case "file_created":
    case "file_deleted":
    case "file_public":
    case "file_shared":
    case "file_unshared":
    case "function_executed":
    case "grid_migration_finished":
    case "grid_migration_started":
    case "group_archive":
    case "group_close":
    case "group_deleted":
    case "group_history_changed":
    case "group_left":
    case "group_open":
    case "group_rename":
    case "group_unarchive":
    case "im_close":
    case "im_created":
    case "im_history_changed":
    case "im_open":
    case "invite_requested":
    case "link_shared":
    case "message_metadata_posted":
    case "message_metadata_updated":
    case "message_metadata_deleted":
    case "pin_added":
    case "pin_removed":
    case "shared_channel_invite_accepted":
    case "shared_channel_invite_approved":
    case "shared_channel_invite_declined":
    case "shared_channel_invite_received":
    case "shared_channel_invite_requested":
    case "star_added":
    case "star_removed":
    case "subteam_created":
    case "subteam_members_changed":
    case "subteam_self_added":
    case "subteam_self_removed":
    case "subteam_updated":
    case "team_access_granted":
    case "team_access_revoked":
    case "team_domain_change":
    case "team_join":
    case "team_rename":
    case "tokens_revoked":
    case "user_change":
    case "user_huddle_changed":
    case "user_profile_changed":
    case "user_status_changed":
    case "workflow_deleted":
    case "workflow_published":
    case "workflow_step_deleted":
    case "workflow_step_execute":
    case "workflow_unpublished":
      return { promptFragment: null, shouldTriggerLLM: false, role: "developer" };

    default:
      exhaustiveMatchingGuard(slackEvent);
  }
}
