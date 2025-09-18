// ------------------------- Event Schemas -------------------------

import z from "zod";
import { exhaustiveMatchingGuard, JSONSerializable } from "../utils/type-helpers.ts";
import {
  agentCoreBaseEventFields,
  agentCoreBaseEventInputFields,
  type CoreReducedState,
} from "./agent-core-schemas.ts";
import { SlackInteractionPayload, type SlackWebhookPayload } from "./slack.types.ts";
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

export const SlackWebhookEventReceivedInput = z.object({
  ...agentCoreBaseEventInputFields,
  ...slackWebhookEventReceivedFields,
});

// SLACK:UPDATE_SLICE_STATE
export const slackUpdateSliceStateFields = {
  type: z.literal("SLACK:UPDATE_SLICE_STATE"),
  data: z.object({
    slackChannelId: z.string().nullable().optional(),
    slackThreadId: z.string().nullable().optional(),
  }),
};

export const SlackUpdateSliceState = z.object({
  ...agentCoreBaseEventFields,
  ...slackUpdateSliceStateFields,
});

export const SlackUpdateSliceStateInput = z.object({
  ...agentCoreBaseEventInputFields,
  ...slackUpdateSliceStateFields,
});

// SLACK:INTERACTION_RECEIVED
export const slackInteractionReceivedFields = {
  type: z.literal("SLACK:INTERACTION_RECEIVED"),
  data: z.object({
    payload: SlackInteractionPayload, // Full interaction payload from Slack
    interactionId: z.string(), // Unique ID for this interaction
    timestamp: z.number(),
  }),
};

export const SlackInteractionReceived = z.object({
  ...agentCoreBaseEventFields,
  ...slackInteractionReceivedFields,
});

export const SlackInteractionReceivedInput = z.object({
  ...agentCoreBaseEventInputFields,
  ...slackInteractionReceivedFields,
});

// SLACK:STORE_MODAL_DEFINITION
export const slackStoreModalDefinitionFields = {
  type: z.literal("SLACK:STORE_MODAL_DEFINITION"),
  data: z.object({
    actionId: z.string(), // Button action ID that will trigger this modal
    modal: z.any(), // The complete modal definition to open when button is clicked
  }),
};

export const SlackStoreModalDefinition = z.object({
  ...agentCoreBaseEventFields,
  ...slackStoreModalDefinitionFields,
});

export const SlackStoreModalDefinitionInput = z.object({
  ...agentCoreBaseEventInputFields,
  ...slackStoreModalDefinitionFields,
});

// ------------------------- Discriminated Unions -------------------------

export const SlackSliceEvent = z.discriminatedUnion("type", [
  SlackWebhookEventReceived,
  SlackUpdateSliceState,
  SlackInteractionReceived,
  SlackStoreModalDefinition,
]);

export const SlackEventInput = z.discriminatedUnion("type", [
  SlackWebhookEventReceivedInput,
  SlackUpdateSliceStateInput,
  SlackInteractionReceivedInput,
  SlackStoreModalDefinitionInput,
]);

// ------------------------- Types -------------------------

export type SlackWebhookEventReceived = z.infer<typeof SlackWebhookEventReceived>;
export type SlackUpdateSliceState = z.infer<typeof SlackUpdateSliceState>;
export type SlackInteractionReceived = z.infer<typeof SlackInteractionReceived>;
export type SlackSliceEvent = z.infer<typeof SlackSliceEvent>;
export type SlackSliceEventInput = z.input<typeof SlackEventInput>;

export interface SlackSliceState {
  slackThreadId?: string | null;
  slackChannelId?: string | null;
  /** Bot user ID extracted from webhook payload authorizations - cached on first webhook event */
  botUserId?: string;

  // Minimal operational state for interactivity
  interactions?: {
    // Modal definitions stored when buttons are created, keyed by action_id
    modalDefinitions: Record<string, any>;

    // Active modal views - one per user
    modalViews: Record<
      string,
      {
        // keyed by userId (not viewId since we only have one modal per user)
        viewId: string;
        userId: string;
        hash?: string; // For race condition prevention
        callbackId?: string;
        privateMetadata?: string; // For carrying data between views
        openedAt: number;
      }
    >;
  };
}

export interface SlackSliceDeps {}

export const slackSlice = defineAgentCoreSlice<{
  SliceState: SlackSliceState;
  EventSchema: typeof SlackSliceEvent;
  EventInputSchema: typeof SlackEventInput;
  SliceDeps: SlackSliceDeps;
}>({
  name: "slack-slice",
  eventSchema: SlackSliceEvent,
  eventInputSchema: SlackEventInput,
  initialState: {
    slackThreadId: undefined,
    slackChannelId: undefined,
    botUserId: undefined,
    interactions: {
      modalDefinitions: {},
      modalViews: {},
    },
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
        break;
      }

      case "SLACK:STORE_MODAL_DEFINITION": {
        if (!next.interactions) {
          next.interactions = {
            modalDefinitions: {},
            modalViews: {},
          };
        }
        next.interactions.modalDefinitions[event.data.actionId] = event.data.modal;
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
          reducedState: next,
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
        next.triggerLLMRequest = shouldTriggerLLM && !next.paused;
        break;
      }

      case "SLACK:INTERACTION_RECEIVED": {
        const { payload, timestamp } = event.data;

        if (!next.interactions) {
          next.interactions = {
            modalDefinitions: {},
            modalViews: {},
          };
        }

        switch (payload.type) {
          case "block_actions": {
            const shouldTriggerLLM = event.triggerLLMRequest !== false;
            if (shouldTriggerLLM) {
              const actions = payload.actions || [];
              const actionDescriptions = actions.map((a: any) => {
                const desc = `${a.action_id}${a.value ? `="${a.value}"` : ""}`;
                return { desc, action: a };
              });

              const actionTexts = actionDescriptions.map((a) => a.desc).join(", ");

              const promptContent: PromptFragment[] = [];
              promptContent.push(
                f(
                  "action",
                  `User ${payload.user.name} (${payload.user.id}) clicked button: ${actionTexts}`,
                ),
              );

              const messageTs = "message" in payload ? payload.message?.ts : undefined;

              if (messageTs) {
                promptContent.push(
                  f("message_update_guidance", [
                    `If you need to update/edit the message with buttons, use updateSlackMessage with:`,
                    `- channel: ${payload.channel?.id}`,
                    `- ts: ${messageTs} (this is the message with buttons, NOT the thread timestamp)`,
                    `- Use this ts to edit the specific message that contained the buttons`,
                    `- This will update the message that the user just interacted with`,
                  ]),
                );
              }

              next.inputItems.push({
                type: "message" as const,
                role: "user",
                content: [
                  {
                    type: "input_text" as const,
                    text: renderPromptFragment(f("slack_interaction", promptContent)),
                  },
                ],
              });
              next.triggerLLMRequest = true;
            } else {
              next.triggerLLMRequest = false;
            }
            break;
          }

          case "view_submission": {
            if (payload.view?.id && payload.user?.id) {
              const userId = payload.user.id;
              next.interactions.modalViews[userId] = {
                viewId: payload.view.id,
                userId,
                hash: payload.view.hash,
                callbackId: payload.view.callback_id,
                privateMetadata: payload.view.private_metadata,
                openedAt: timestamp,
              };
            }

            const formValues = extractFormValues(payload.view?.state?.values);
            const modalTitle = payload.view?.title?.text || "Form";
            const callbackId = payload.view?.callback_id || "unknown";

            next.inputItems.push({
              type: "message" as const,
              role: "user",
              content: [
                {
                  type: "input_text" as const,
                  text: renderPromptFragment(
                    f("slack_form_submission", [
                      f(
                        "modal_info",
                        `Modal "${modalTitle}" (callback_id: ${callbackId}) was submitted`,
                      ),
                      f("form_data", JSON.stringify(formValues, null, 2)),
                      f(
                        "instructions",
                        "Process this form submission and respond appropriately. You may want to send a confirmation message or take action based on the data.",
                      ),
                    ]),
                  ),
                },
              ],
            });
            next.triggerLLMRequest = true;
            break;
          }

          case "view_closed":
            if (payload.user?.id) {
              delete next.interactions.modalViews[payload.user.id];
            }
            next.triggerLLMRequest = false;
            break;

          case "shortcut":
          case "message_action":
            next.inputItems.push({
              type: "message" as const,
              role: "user",
              content: [
                {
                  type: "input_text" as const,
                  text: renderPromptFragment(
                    f("slack_interaction", [
                      f(payload.type, `User triggered ${payload.callback_id || payload.type}`),
                      ...(payload.message ? [f("message", payload.message.text || "")] : []),
                    ]),
                  ),
                },
              ],
            });
            next.triggerLLMRequest = true;
            break;
        }
        break;
      }
    }

    // ---------------------------------------------------------------------
    // Set Slack context as ephemeral prompt fragment
    // ---------------------------------------------------------------------

    // Set the slack context as an ephemeral prompt fragment
    // This will be automatically included in LLM requests as a developer message
    // and reset on each reducer run
    if (next.slackChannelId) {
      next.ephemeralPromptFragments["slack-context"] = createSlackContextForState({
        state: next,
        botUserId: next.botUserId,
      });
    }

    // Slack is considered initialized once we have a channel ID
    // No need for a separate flag - the presence of slackChannelId is enough

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

function extractFormValues(stateValues: any): Record<string, any> {
  if (!stateValues) {
    return {};
  }

  const result: Record<string, any> = {};

  for (const [blockId, block] of Object.entries(stateValues)) {
    for (const [actionId, element] of Object.entries(block as any)) {
      const value =
        (element as any).value ||
        (element as any).selected_option?.value ||
        (element as any).selected_options?.map((o: any) => o.value);

      result[`${blockId}.${actionId}`] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// LLM prompt/context engineering below
// Changing any of these helpers will directly change what the LLM sees.
// ---------------------------------------------------------------------------

export function createSlackContextForState(params: {
  state: CoreReducedState<SlackSliceEventInput> & SlackSliceState;
  botUserId?: string;
}): PromptFragment {
  const { state, botUserId } = params;
  const promptFragment: PromptFragment = [];

  const channelThreadInfo: PromptFragment = [];
  if (state.slackChannelId) {
    channelThreadInfo.push(`Current channel ID: ${state.slackChannelId}`);
  }
  if (state.slackThreadId) {
    channelThreadInfo.push(`Current thread ID: ${state.slackThreadId}`);
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
  reducedState: CoreReducedState<SlackSliceEventInput> & SlackSliceState;
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
        case "thread_broadcast":
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
                    note: "This message was sent by you (the bot) and should appear chronologically before any user interactions with it",
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
