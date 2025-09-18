// @ts-nocheck

import type {
  AgentCoreDeps,
  MergedEventInputForSlices,
} from "@iterate-com/helpers/agent/agent-core";
import type {
  AgentCoreEvent,
  AgentCoreEventInput,
  LlmInputItemEventInput,
  ParticipantJoinedEventInput,
  ParticipantMentionedEventInput,
} from "@iterate-com/helpers/agent/agent-core-schemas";
import { renderPromptFragment } from "@iterate-com/sdk/prompts";
import type { SlackEvent } from "@slack/types";
import { APP_URLS } from "iterate:estate-manifest";
import { z } from "zod/v4";
import * as R from "remeda";
import type { MagicAgentInstructions } from "@iterate-com/helpers/agent/tools/magic";
import type { DOToolDefinitions } from "@iterate-com/helpers/agent/do-tools";
import { UpdateSlackMessageInput } from "../legacy-agent/integrations/slack/router.ts";
import type { StoredSlackWebhook } from "../db/schema.ts";
import type { Memory } from "../db/types.ts";
import { serverTrpc } from "../legacy-agent/trpc/trpc.ts";
import { getUrlContent } from "./url-content-handler.ts";
import { shouldIncludeEventInConversation } from "./slack-filters.ts";
import { slackSlice, type SlackSliceState } from "./slack-slice.ts";
import { extractBotUserIdFromAuthorizations } from "./slack-agent-utils.ts";
import {
  type SlackModalDefinition,
  type SlackModalDefinitions,
  type SlackWebhookPayload,
} from "./slack.types.ts";
import { CORE_AGENT_SLICES, IterateAgent } from "./agent.ts";

import {
  getMessageMetadata,
  getMentionedExternalUserIds,
  slackWebhookEventToIdempotencyKey,
  isBotMentionedInMessage,
} from "./slack-agent-utils.ts";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import { slackAgentTools } from "./slack-agent-tools.ts";

// memorySlice removed for now
const slackAgentSlices = [...CORE_AGENT_SLICES, slackSlice] as const;
export type SlackAgentSlices = typeof slackAgentSlices;

type ToolsInterface = typeof slackAgentTools.$infer.interface;
type Inputs = typeof slackAgentTools.$infer.inputTypes;

export class SlackAgent extends IterateAgent<SlackAgentSlices> implements ToolsInterface {
  protected getSlices(): SlackAgentSlices {
    return slackAgentSlices;
  }

  toolDefinitions(): DOToolDefinitions<{}> {
    return {
      ...iterateAgentTools,
      ...slackAgentTools,
    };
  }

  protected getExtraDependencies(deps: AgentCoreDeps) {
    return {
      getMemoriesForUsers: async (userIds: string[]): Promise<Memory[]> => {
        const memories: Memory[] = [];

        for (const userId of userIds) {
          const userMemories = await serverTrpc.platform.memory.getUserMemories.query({
            __auth: {
              impersonateUserId: userId,
            },
          });
          memories.push(
            ...userMemories.map((m) => ({
              id: m.id,
              content: m.content,
              userId: m.userId,
              isEstateWide: m.isEstateWide,
              createdAt: m.createdAt,
            })),
          );
        }

        return memories;
      },
      getMemoriesForEstate: async (): Promise<Memory[]> => {
        return await serverTrpc.platform.memory.getEstateMemoriesForAgent.query();
      },
      onEventAdded: <E, S>(payload: {
        event: E;
        reducedState: S;
        getFinalRedirectUrl?: <S>(payload: {
          durableObjectInstanceName: string;
          reducedState: S;
        }) => Promise<string | undefined>;
      }) => {
        deps?.onEventAdded?.(payload);
        const { slackChannelId, slackThreadId } = payload.reducedState as SlackSliceState;
        if (!slackChannelId || !slackThreadId) {
          return;
        }
        switch ((payload.event as AgentCoreEvent).type) {
          case "CORE:LLM_REQUEST_START":
            // Start typing indicator
            this.ctx.waitUntil(
              serverTrpc.platform.integrations.slack.setThreadStatus
                .mutate({
                  channelId: slackChannelId,
                  threadTs: slackThreadId,
                  status: "is typing...",
                })
                .catch((error) => {
                  console.error("[SlackAgent] Failed to start typing indicator:", error);
                }),
            );
            break;
          case "CORE:LLM_REQUEST_CANCEL":
          case "CORE:LLM_REQUEST_END":
            // Stop typing indicator by clearing status
            this.ctx.waitUntil(
              serverTrpc.platform.integrations.slack.setThreadStatus
                .mutate({
                  channelId: slackChannelId,
                  threadTs: slackThreadId,
                  status: "",
                })
                .catch((error) => {
                  console.error("[SlackAgent] Failed to stop typing indicator:", error);
                }),
            );
            break;
        }
      },
      getFinalRedirectUrl: async <S>(_payload: {
        durableObjectInstanceName: string;
        reducedState: S;
      }) => {
        return await this.getSlackPermalink();
      },
    };
  }

  protected async getSlackFileEvents(
    slackEvent: SlackEvent,
    botUserId: string | undefined,
  ): Promise<AgentCoreEventInput[]> {
    if (shouldIncludeEventInConversation(slackEvent, botUserId) && slackEvent?.type === "message") {
      if (slackEvent.subtype === "file_share" && slackEvent.files) {
        const fileUploadPromises = slackEvent.files.map(async (slackFile) => {
          try {
            const downloadUrl = slackFile.url_private_download || slackFile.url_private;
            if (!downloadUrl) {
              console.error(`No download URL for Slack file ${slackFile.id}`);
              return null;
            }

            const { fileRecord } =
              await serverTrpc.platform.integrations.slack.downloadFileFromSlack.mutate({
                url: downloadUrl,
                filename: slackFile.name || `slack-file-${slackFile.id}`,
              });

            return {
              iterateFileId: fileRecord.iterateId,
              originalFilename: fileRecord.filename ?? undefined,
              size: fileRecord.fileSize ?? undefined,
              mimeType: fileRecord.mimeType ?? undefined,
              openAIFileId: fileRecord.openAIFileId || undefined,
              slackFileId: slackFile.id,
            };
          } catch (error) {
            console.error(`Failed to upload Slack file ${slackFile.id}:`, error);
            return null;
          }
        });

        const fileResults = await Promise.all(fileUploadPromises);

        const fileEvents = fileResults
          .filter((result): result is NonNullable<typeof result> => result !== null)
          .map((fileData) => ({
            type: "CORE:FILE_SHARED" as const,
            data: {
              direction: "from-user-to-agent" as const,
              iterateFileId: fileData.iterateFileId,
              originalFilename: fileData.originalFilename,
              size: fileData.size,
              mimeType: fileData.mimeType,
              openAIFileId: fileData.openAIFileId,
            },
            triggerLLMRequest: false,
          }));

        return fileEvents;
      }
    }
    return [];
  }

  /**
   * Fetches previous messages in a Slack thread and returns an LLM input item event
   */
  public async getSlackThreadHistoryInputEvents(
    threadTs: string,
  ): Promise<LlmInputItemEventInput[]> {
    const timings: Record<string, number> = { startTime: performance.now() };
    const previousMessages = await serverTrpc.platform.integrations.slack.getMessagesInThread.query(
      {
        threadTs: threadTs,
      },
    );
    timings.getMessagesInThread = performance.now() - timings.startTime;

    type TextMessage = StoredSlackWebhook & { data: { text: string; ts: string; user: string } };
    const filteredPreviousMessages = previousMessages.filter(
      (m): m is TextMessage => "text" in m.data && "ts" in m.data && "user" in m.data,
    );
    const dedupedPreviousMessages = Object.values(
      Object.fromEntries(filteredPreviousMessages.map((m) => [m.data.ts, m])), // Use ts as key for deduplication
    ).sort((a, b) => parseFloat(a.data.ts) - parseFloat(b.data.ts)); // Sort by timestamp

    // Generate context for mid-thread joins
    const context = renderPromptFragment({
      tag: "slack_channel_context",
      content: [
        "You should use the previous messages in the thread to understand the context of the current message.",
        // Deduplicate messages by ts and format them
        ...(previousMessages.length > 0
          ? [
              "Previous messages:",
              ...dedupedPreviousMessages.map((m) => {
                return (
                  JSON.stringify(
                    {
                      user: m.data.user,
                      text: m.data.text,
                      ts: m.data.ts,
                      createdAt: new Date(parseFloat(m.data.ts) * 1000).toISOString(),
                    },
                    null,
                    2,
                  ) + "\n"
                );
              }),
            ]
          : []),
      ],
    });

    return [
      {
        type: "CORE:LLM_INPUT_ITEM",
        data: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: context,
            },
          ],
        },
        triggerLLMRequest: false,
        metadata: { timings },
      },
    ];
  }

  /**
   * Adds a participant to the conversation when they send a message.
   * This is crucial for MCP personal connections to work properly.
   */
  protected async getParticipantJoinedEvents(
    slackUserId: string,
    botUserId?: string,
  ): Promise<ParticipantJoinedEventInput[]> {
    if (slackUserId === botUserId) {
      return [];
    }
    const currentState = this.agentCore.state;
    for (const participant of Object.values(currentState.participants || {})) {
      if (participant.externalUserMapping?.slack?.externalUserId === slackUserId) {
        return []; // Already a participant, skip DB queries
      }
    }

    const userMapping = await serverTrpc.platform.integrations.getIntegrationUserMapping.query({
      integrationSlug: "slack",
      externalUserId: slackUserId,
    });
    if (!userMapping?.internalUserId) {
      return [];
    }

    if (currentState.participants && userMapping.internalUserId in currentState.participants) {
      return [];
    }

    const { user } = await serverTrpc.platform.auth.getUserById.query({
      id: userMapping.internalUserId,
    });

    return [
      {
        type: "CORE:PARTICIPANT_JOINED",
        data: {
          internalUserId: userMapping.internalUserId,
          email: user.email,
          displayName: user.name,
          externalUserMapping: {
            slack: {
              integrationSlug: userMapping.integrationSlug,
              externalUserId: userMapping.externalUserId,
              internalUserId: userMapping.internalUserId,
              email: user.email,
              rawUserInfo: userMapping.rawUserInfo || undefined,
            },
          },
        },
        triggerLLMRequest: false,
        metadata: {},
      },
    ];
  }

  /**
   * Creates PARTICIPANT_MENTIONED events for users mentioned in a message.
   * These are lightweight participants who haven't actively participated yet.
   */
  protected async getParticipantMentionedEvents(
    messageText: string,
    currentSlackUserId?: string,
    botUserId?: string,
  ): Promise<ParticipantMentionedEventInput[]> {
    const mentionedUserIds = getMentionedExternalUserIds(messageText);
    const currentState = this.agentCore.state;

    const existingSlackUserIds = new Set([
      ...Object.values(currentState.participants || {})
        .map((p) => p.externalUserMapping?.slack?.externalUserId)
        .filter(Boolean),
      ...Object.values(currentState.mentionedParticipants || {})
        .map((p) => p.externalUserMapping?.slack?.externalUserId)
        .filter(Boolean),
    ]);

    const newMentionedUserIds = R.pipe(
      mentionedUserIds,
      R.filter((id) => id !== botUserId && id !== currentSlackUserId),
      R.filter((id) => !existingSlackUserIds.has(id)),
      R.unique(),
    );

    if (newMentionedUserIds.length === 0) {
      return [];
    }

    const userMappingResults = await Promise.all(
      newMentionedUserIds.map(async (slackUserId) => {
        const mapping = await serverTrpc.platform.integrations.getIntegrationUserMapping.query({
          integrationSlug: "slack",
          externalUserId: slackUserId,
        });
        return { slackUserId, mapping };
      }),
    );

    const validMappings = userMappingResults.filter(
      (
        result,
      ): result is {
        slackUserId: string;
        mapping: NonNullable<typeof result.mapping> & { internalUserId: string };
      } =>
        result.mapping?.internalUserId != null && typeof result.mapping.internalUserId === "string",
    );

    const userDetails = await Promise.all(
      validMappings.map(async ({ slackUserId, mapping }) => {
        const { user } = await serverTrpc.platform.auth.getUserById.query({
          id: mapping.internalUserId,
        });
        return { slackUserId, mapping, user };
      }),
    );

    const validUserDetails = R.filter(userDetails, R.isTruthy);

    return validUserDetails.map(
      ({ mapping, user }): ParticipantMentionedEventInput => ({
        type: "CORE:PARTICIPANT_MENTIONED",
        data: {
          internalUserId: mapping.internalUserId,
          email: user.email,
          displayName: user.name,
          externalUserMapping: {
            slack: {
              integrationSlug: mapping.integrationSlug,
              externalUserId: mapping.externalUserId,
              internalUserId: mapping.internalUserId,
              email: user.email,
              rawUserInfo: mapping.rawUserInfo ?? undefined,
            },
          },
        },
        triggerLLMRequest: false,
        metadata: {},
      }),
    );
  }

  public async initSlack(channelId: string, threadTs: string) {
    const events: MergedEventInputForSlices<SlackAgentSlices>[] = [];
    events.push({
      type: "SLACK:UPDATE_SLICE_STATE" as const,
      data: {
        slackChannelId: channelId,
        slackThreadId: threadTs,
      },
      triggerLLMRequest: false,
    });
    return events;
  }

  async getSlackPermalink(): Promise<string | undefined> {
    const state = await this.getState();
    const botUserId = state.reducedState?.botUserId;

    let lastUserMessage: any = null;

    for (let i = state.events.length - 1; i >= 0; i--) {
      const event = state.events[i] as any;

      if (event.type === "SLACK:WEBHOOK_EVENT_RECEIVED") {
        const slackEvent = event.data?.payload?.event as SlackEvent;

        if (slackEvent?.type === "message") {
          const messageEvent = slackEvent as any;

          if (
            !("subtype" in messageEvent) &&
            messageEvent.user &&
            messageEvent.user !== botUserId &&
            messageEvent.channel &&
            messageEvent.ts
          ) {
            lastUserMessage = messageEvent;
            break;
          }
        }
      }
    }

    if (lastUserMessage) {
      const messageChannelId = lastUserMessage.channel;
      const ts = lastUserMessage.thread_ts || lastUserMessage.ts;

      try {
        const result = await serverTrpc.platform.integrations.slack.getPermalink.query({
          channelId: messageChannelId,
          ts,
        });
        if (result.success && result.permalink) {
          return result.permalink;
        }
      } catch (error) {
        console.error("Failed to get Slack permalink:", error);
      }
    } else {
      // if we can't find any message, get link to the thread
      const channelId = state.reducedState?.slackChannelId;
      const threadTs = state.reducedState?.slackThreadId;

      if (!channelId || !threadTs) {
        console.error("Channel ID and thread TS are required to get a Slack permalink", {
          channelId,
          threadTs,
        });
        return undefined;
      }
      try {
        const result = await serverTrpc.platform.integrations.slack.getPermalink.query({
          channelId,
          ts: threadTs,
        });
        if (result.success && result.permalink) {
          return result.permalink;
        }
      } catch (error) {
        console.error("Failed to get Slack permalink:", error);
      }
    }

    return undefined;
  }

  async storeModalDefinitions(modalDefinitions: SlackModalDefinitions): Promise<void> {
    for (const [actionId, modalDef] of Object.entries(modalDefinitions) as [
      string,
      SlackModalDefinition,
    ][]) {
      const agentState = await this.getState();
      const threadTs = agentState?.reducedState?.slackThreadId;
      const modalWithMetadata: SlackModalDefinition = {
        ...modalDef,
        callback_id: modalDef.callback_id || `${actionId}_form`,
        private_metadata: JSON.stringify({
          thread_ts: threadTs,
          action_id: actionId,
        }),
      };
      await this.addEvents([
        {
          type: "SLACK:STORE_MODAL_DEFINITION",
          data: {
            actionId,
            modal: modalWithMetadata,
          },
        },
      ]);
    }
  }

  /**
   * Finds the most recent Slack message timestamp (ts) seen by this agent from webhook events
   */
  protected async mostRecentSlackMessageTs(): Promise<string | null> {
    const state = await this.getState();
    for (let i = state.events.length - 1; i >= 0; i--) {
      const event = state.events[i] as MergedEventInputForSlices<SlackAgentSlices>;
      if (event?.type === "SLACK:WEBHOOK_EVENT_RECEIVED") {
        const slackEvent = (event.data?.payload as { event?: SlackEvent })?.event;
        return slackEvent?.type === "message" && typeof slackEvent.ts === "string"
          ? slackEvent.ts
          : null;
      }
    }
    return null;
  }

  /**
   * Handles instant button feedback by preserving original message content and only updating button blocks
   * to show selection feedback. This provides immediate user feedback before LLM processing.
   */
  protected async handleInstantButtonFeedback(params: {
    channelId: string;
    messageTs: string;
    actions: any[];
    userId: string;
  }): Promise<void> {
    const { channelId, messageTs, actions } = params;
    const clickedActions = actions.map((action) => ({
      actionId: action.action_id,
      value: action.value || action.selected_option?.value,
      text: action.text?.text || action.selected_option?.text?.text || action.action_id,
    }));
    if (clickedActions.length === 0) {
      return;
    }
    const selectionText = clickedActions.map((action) => `Selected: ${action.text}`).join(", ");

    try {
      let updatedBlocks: any[] | undefined;
      let actionBlockFound = false;

      try {
        const originalMessage =
          await serverTrpc.platform.integrations.getOriginalSlackMessage.query({
            messageTs,
          });

        if (originalMessage.found) {
          if (originalMessage.blocks && Array.isArray(originalMessage.blocks)) {
            updatedBlocks = originalMessage.blocks.map((block: any) => {
              if (block.type === "actions") {
                actionBlockFound = true;
                // Replace action block with feedback
                return {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `✅ ${selectionText}`,
                  },
                };
              }
              return block; // Keep other blocks unchanged (sections, images, dividers, etc.)
            });

            // If no action blocks were found, add feedback block at the end
            if (!actionBlockFound) {
              updatedBlocks.push({
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `✅ ${selectionText}`,
                },
              });
            }
          } else {
            // No blocks in original message, create new blocks with feedback
            updatedBlocks = [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `✅ ${selectionText}`,
                },
              },
            ];
          }
        }
      } catch (trpcError) {
        console.warn(
          "[SlackAgent] Could not retrieve original message from webhook store:",
          trpcError,
        );
      }

      if (!updatedBlocks) {
        updatedBlocks = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✅ ${selectionText}`,
            },
          },
        ];
      }

      await serverTrpc.platform.integrations.slack.updateMessage.mutate({
        channel: channelId,
        ts: messageTs,
        text: `✅ ${selectionText}`, // Simple fallback text for accessibility
        blocks: updatedBlocks, // Updated blocks with selection feedback (this should display)
      });
    } catch (error) {
      console.error("[SlackAgent] Failed to update message with button feedback:", error);
    }
  }
  async getSetupIntegrationInAgentURL(input: Inputs["getSetupIntegrationInAgentURL"]) {
    const permalink = await this.getSlackPermalink();
    const url = await serverTrpc.platform.integrations.startOAuthSession.mutate({
      integrationSlug: input.integrationSlug,
      mode: input.mode,
      appSlug: input.appSlug,
      finalRedirectUrl: permalink,
      __auth: {
        impersonateUserEmail: input.impersonateUserEmail,
      },
      requestedByAgentDOId: this.ctx.id.toString(),
    });
    return `${APP_URLS.platform}/integrations/redirect?url=${encodeURIComponent(url)}`;
  }

  async onSlackWebhookEventReceived(input: Inputs["onSlackWebhookEventReceived"]) {
    const slackWebhookPayload = input as SlackWebhookPayload;
    const slackEvent = slackWebhookPayload.event!;
    if (!slackEvent.type) {
      return;
    }

    const messageMetadata = await getMessageMetadata(slackEvent);
    if (!messageMetadata) {
      return;
    }

    const botUserId = extractBotUserIdFromAuthorizations(slackWebhookPayload);

    if (!botUserId) {
      return;
    }

    const currentState = this.agentCore.state;
    const isSlackInitialized = !!currentState.slackChannelId;
    const isThreadStarter = messageMetadata.messageTs === messageMetadata.threadTs;

    const events: MergedEventInputForSlices<SlackAgentSlices>[] = [];

    if (!isSlackInitialized) {
      const initEvents = await this.initSlack(messageMetadata.channel, messageMetadata.threadTs);
      events.push(...initEvents);
    }
    if (currentState.paused && slackEvent.type === "message" && "text" in slackEvent) {
      const messageText = slackEvent.text;
      if (messageText) {
        const mentionedUserIds = getMentionedExternalUserIds(messageText);
        if (mentionedUserIds.includes(botUserId)) {
          events.push({
            type: "CORE:RESUME_LLM_REQUESTS",
            triggerLLMRequest: false,
          });
        }
      }
    }

    // Determine who authored the message and whether it mentions our bot
    const isBotMessage =
      botUserId &&
      (("user" in slackEvent && slackEvent.user === botUserId) || "bot_id" in slackEvent);
    const isFromOurBot = botUserId && "user" in slackEvent && slackEvent.user === botUserId;
    // We always ignore our own bot's messages
    // We ignore other bot messages unless they explicitly mention our bot - to avoid two bots getting in an infinite loop talking to each other
    const isBotMessageThatShouldBeIgnored =
      isFromOurBot || (isBotMessage && !isBotMentionedInMessage(slackEvent, botUserId));

    // Parallelize participant management, file events, thread history, and mention extraction
    const eventsLists = await Promise.all([
      slackEvent?.type === "message" && "user" in slackEvent && slackEvent.user
        ? this.getParticipantJoinedEvents(slackEvent.user, botUserId)
        : Promise.resolve([]),
      slackEvent?.type === "message" && "text" in slackEvent && slackEvent.text
        ? this.getParticipantMentionedEvents(
            slackEvent.text,
            "user" in slackEvent ? slackEvent.user : undefined,
            botUserId,
          )
        : Promise.resolve([]),
      this.getSlackFileEvents(slackEvent, botUserId),
      !isSlackInitialized && !isThreadStarter
        ? this.getSlackThreadHistoryInputEvents(messageMetadata.threadTs)
        : Promise.resolve([]),
    ]);
    events.push(...(eventsLists satisfies Array<AgentCoreEventInput[]>).flat());

    // Pass the webhook event to the reducer
    // The reducer will handle filtering and determine if LLM computation should be triggered
    events.push({
      type: "SLACK:WEBHOOK_EVENT_RECEIVED" as const,
      data: {
        payload: input,
        updateThreadIds: true,
      },
      // Don't trigger LLM for bot messages or non-message events
      triggerLLMRequest: slackEvent.type === "message" && !isBotMessageThatShouldBeIgnored,
      idempotencyKey: slackWebhookEventToIdempotencyKey(input as SlackWebhookPayload),
    });

    // Batch add events
    await this.addEvents(events);

    return {
      success: true,
    };
  }

  async onSlackInteractionReceived(input: Inputs["onSlackInteractionReceived"]) {
    const { payload } = input;

    // we don't pass in the bot user id because they can't send interactions
    const participantJoinedEvents = await this.getParticipantJoinedEvents(payload.user.id);
    await this.addEvents(participantJoinedEvents);

    // Handle deterministic modal operations - open stored modals when buttons are clicked
    let modalOpened = false;
    if (payload.type === "block_actions" && payload.trigger_id) {
      const actions = payload.actions || [];

      const agentState = await this.getState();
      const modalDefinitions: SlackModalDefinitions =
        agentState?.reducedState?.interactions?.modalDefinitions || {};

      for (const action of actions) {
        const actionId = action.action_id;
        if (!actionId) {
          continue;
        }

        if (!modalDefinitions[actionId]) {
          continue;
        }

        const modalView: SlackModalDefinition = modalDefinitions[actionId];

        const result = await serverTrpc.platform.integrations.slack.openModal.mutate({
          triggerId: payload.trigger_id,
          view: modalView,
        });

        if (result.success) {
          modalOpened = true;
        }
      }
    }

    // Handle instant button feedback - update message immediately to show selection
    // This happens for all button interactions that don't open modals
    if (
      payload.type === "block_actions" &&
      !modalOpened &&
      payload.message?.ts &&
      payload.channel?.id &&
      (payload.actions || []).length > 0
    ) {
      await this.handleInstantButtonFeedback({
        channelId: payload.channel.id,
        messageTs: payload.message.ts,
        actions: payload.actions || [],
        userId: payload.user.id,
      });
    }

    const shouldTriggerLLM = !modalOpened || payload.type === "view_submission";

    await this.addEvents([
      {
        type: "SLACK:INTERACTION_RECEIVED",
        data: input,
        triggerLLMRequest: shouldTriggerLLM,
      },
    ]);
    return {
      success: true,
    };
  }

  async sendSlackMessage(input: Inputs["sendSlackMessage"]) {
    // Store modal definitions if provided
    if (input.modalDefinitions) {
      await this.storeModalDefinitions(input.modalDefinitions);
    }

    const slackThreadId = this.agentCore.state.slackThreadId;
    const slackChannelId = this.agentCore.state.slackChannelId;

    if (typeof slackThreadId !== "string" || typeof slackChannelId !== "string") {
      throw new Error("Slack thread ID and channel ID must be strings");
    }

    const { endTurn, ...sendInput } = input;

    const message = await serverTrpc.platform.integrations.slack.sendSlackMessage.mutate({
      channel: slackChannelId,
      threadTs: slackThreadId,
      ...sendInput,
    });
    // Build magic return properties based on behaviour
    const magic: MagicAgentInstructions = {};
    if (endTurn) {
      magic.__triggerLLMRequest = false;
    }

    // return an empty object to conserve tokens in the success case, plus magic flags if any
    return {
      ...(message.success ? {} : message),
      ...magic,
    };
  }

  async addSlackReaction(input: Inputs["addSlackReaction"]) {
    await serverTrpc.platform.integrations.slack.addSlackReaction.mutate(input);
    return {
      success: true,
    };
  }

  async removeSlackReaction(input: Inputs["removeSlackReaction"]) {
    await serverTrpc.platform.integrations.slack.removeSlackReaction.mutate(input);
    return {
      success: true,
    };
  }

  async uploadAndShareFileInSlack(input: Inputs["uploadAndShareFileInSlack"]) {
    const slackThreadId = this.agentCore.state.slackThreadId;
    const slackChannelId = this.agentCore.state.slackChannelId;

    if (typeof slackThreadId !== "string" || typeof slackChannelId !== "string") {
      throw new Error("Slack thread ID and channel ID must be strings");
    }

    try {
      const uploadResult = await serverTrpc.platform.integrations.slack.uploadFileToSlack.mutate({
        channel: slackChannelId,
        threadTs: slackThreadId,
        ...input,
      });
      return uploadResult;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async createMemory(input: Inputs["createMemory"]) {
    return await serverTrpc.platform.memory.createMemory.mutate({
      content: input.content,
      isEstateWide: input.isEstateWide,
      __auth: {
        impersonateUserEmail: input.impersonateUserEmail,
      },
    });
  }

  async updateSlackMessage(input: z.infer<typeof UpdateSlackMessageInput>) {
    const result = await serverTrpc.platform.integrations.slack.updateMessage.mutate(input);
    return result;
  }

  async stopRespondingUntilMentioned(_input: Inputs["stopRespondingUntilMentioned"]) {
    try {
      const channel = this.agentCore.state.slackChannelId;
      const ts = await this.mostRecentSlackMessageTs();
      if (channel && ts) {
        await serverTrpc.platform.integrations.slack.addSlackReaction.mutate({
          channel,
          timestamp: ts,
          name: "zipper_mouth_face",
        });
      }
    } catch (error) {
      console.warn("[SlackAgent] Failed adding zipper-mouth reaction:", error);
    }
    return {
      __pauseAgentUntilMentioned: true,
      __triggerLLMRequest: false,
    } satisfies MagicAgentInstructions;
  }

  async getUrlContent(input: Inputs["getUrlContent"]) {
    return await getUrlContent({
      url: input.url,
      shouldMakeScreenshot: input.shouldMakeScreenshot,
    });
  }

  async searchWeb(input: Inputs["searchWeb"]) {
    const searchRequest = {
      ...input,
      type: "auto" as const,
    };
    return await serverTrpc.platform.defaultTools.exaSearch.mutate(searchRequest);
  }
}

export async function getAgentInstanceNamesForSlackWebhook(slackEvent: SlackEvent) {
  const threadId = await getThreadId(slackEvent);
  return threadId ? `SlackAgent ${threadId}` : null;
}

export async function getThreadId(slackEvent: SlackEvent) {
  if (slackEvent.type === "message") {
    return "thread_ts" in slackEvent ? slackEvent.thread_ts : slackEvent.ts;
  }
  if (slackEvent.type === "reaction_added" || slackEvent.type === "reaction_removed") {
    return await serverTrpc.platform.integrations.slack.getThreadTsForMessage.query({
      messageTs: slackEvent.item.ts,
    });
  }

  return null;
}
