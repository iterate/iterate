import type { SlackEvent } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { and, asc, eq, or } from "drizzle-orm";
import { env as _env, env } from "../../env.ts";
import { getSlackAccessTokenForEstate } from "../auth/token-utils.ts";
import { slackWebhookEvent } from "../db/schema.ts";
import type {
  AgentCoreDeps,
  AgentCoreEventInput,
  MergedEventInputForSlices,
} from "./agent-core.ts";
import type { DOToolDefinitions } from "./do-tools.ts";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import {
  CORE_AGENT_SLICES,
  IterateAgent,
  type AgentInstanceDatabaseRecord,
} from "./iterate-agent.ts";
import { slackAgentTools } from "./slack-agent-tools.ts";
import { slackSlice, type SlackSliceState } from "./slack-slice.ts";
import { shouldIncludeEventInConversation } from "./slack-agent-utils.ts";
import type {
  AgentCoreEvent,
  LlmInputItemEventInput,
  ParticipantJoinedEventInput,
  ParticipantMentionedEventInput,
} from "./agent-core-schemas.ts";
import type { SlackWebhookPayload } from "./slack.types.ts";
import {
  extractBotUserIdFromAuthorizations,
  getMentionedExternalUserIds,
  getMessageMetadata,
  isBotMentionedInMessage,
  slackWebhookEventToIdempotencyKey,
} from "./slack-agent-utils.ts";
import type { MagicAgentInstructions } from "./magic.ts";
import { renderPromptFragment } from "./prompt-fragments.ts";
// Inherit generic static helpers from IterateAgent

// memorySlice removed for now
const slackAgentSlices = [...CORE_AGENT_SLICES, slackSlice] as const;
export type SlackAgentSlices = typeof slackAgentSlices;

type ToolsInterface = typeof slackAgentTools.$infer.interface;
type Inputs = typeof slackAgentTools.$infer.inputTypes;

export class SlackAgent extends IterateAgent<SlackAgentSlices> implements ToolsInterface {
  static getNamespace() {
    // cast necessary to avoid typescript error:
    // Class static side 'typeof SlackAgent' incorrectly extends base class static side 'typeof IterateAgent'.
    // The types returned by 'getNamespace()' are incompatible between these types.

    // tradeoff: types for some other static methods inherited from IterateAgent like getOrCreateStubByName
    // are for IterateAgent, rather than SlackAgent, so a cast is necessary if you want to call slack-specific methods on a stub.
    return env.SLACK_AGENT as unknown as typeof env.ITERATE_AGENT;
  }

  static getClassName(): string {
    return "SlackAgent";
  }

  protected slackAPI!: WebClient;

  // This gets run between the synchronous durable object constructor and the asynchronous onStart method of the agents SDK
  async initAfterConstructorBeforeOnStart(params: { record: AgentInstanceDatabaseRecord }) {
    await super.initAfterConstructorBeforeOnStart(params);

    const slackAccessToken = await getSlackAccessTokenForEstate(this.db, params.record.estateId);
    if (!slackAccessToken) {
      throw new Error(`Slack access token not set for estate ${params.record.estateId}.`);
    }
    this.slackAPI = new WebClient(slackAccessToken);
  }

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
      onEventAdded: <E, S>(payload: {
        event: E;
        reducedState: S;
        getFinalRedirectUrl?: (payload: {
          durableObjectInstanceName: string;
        }) => Promise<string | undefined>;
      }) => {
        deps?.onEventAdded?.(payload);
        const { slackChannelId, slackThreadId } = this.getReducedState() as SlackSliceState;
        if (!slackChannelId || !slackThreadId) {
          return;
        }
        switch ((payload.event as AgentCoreEvent).type) {
          case "CORE:LLM_REQUEST_START":
            // Start typing indicator
            this.ctx.waitUntil(
              this.slackAPI.assistant.threads
                .setStatus({
                  channel_id: slackChannelId,
                  thread_ts: slackThreadId,
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
              this.slackAPI.assistant.threads
                .setStatus({
                  channel_id: slackChannelId,
                  thread_ts: slackThreadId,
                  status: "",
                })
                .catch((error) => {
                  console.error("[SlackAgent] Failed to stop typing indicator:", error);
                }),
            );
            break;
        }
      },
      getFinalRedirectUrl: async (_payload: { durableObjectInstanceName: string }) => {
        return await this.getSlackPermalink();
      },
      lazyConnectionDeps: {
        getDurableObjectInfo: () => this.hydrationInfo,
        getEstateId: () => this.databaseRecord.estateId,
        getReducedState: () => this.agentCore.state,
        getFinalRedirectUrl: async (_payload: { durableObjectInstanceName: string }) => {
          return await this.getSlackPermalink();
        },
      },
    };
  }

  protected async getSlackFileEvents(
    slackEvent: SlackEvent,
    botUserId: string | undefined,
  ): Promise<AgentCoreEventInput[]> {
    if (shouldIncludeEventInConversation(slackEvent, botUserId) && slackEvent?.type === "message") {
      if (slackEvent.subtype === "file_share" && slackEvent.files) {
        throw new Error("Slack file sharing not wired up yet");
        // const fileUploadPromises = slackEvent.files.map(async (slackFile) => {
        //   try {
        //     const downloadUrl = slackFile.url_private_download || slackFile.url_private;
        //     if (!downloadUrl) {
        //       console.error(`No download URL for Slack file ${slackFile.id}`);
        //       return null;
        //     }

        //     const { fileRecord } =
        //       await serverTrpc.platform.integrations.slack.downloadFileFromSlack.mutate({
        //         url: downloadUrl,
        //         filename: slackFile.name || `slack-file-${slackFile.id}`,
        //       });

        //     return {
        //       iterateFileId: fileRecord.iterateId,
        //       originalFilename: fileRecord.filename ?? undefined,
        //       size: fileRecord.fileSize ?? undefined,
        //       mimeType: fileRecord.mimeType ?? undefined,
        //       openAIFileId: fileRecord.openAIFileId || undefined,
        //       slackFileId: slackFile.id,
        //     };
        //   } catch (error) {
        //     console.error(`Failed to upload Slack file ${slackFile.id}:`, error);
        //     return null;
        //   }
        // });

        // const fileResults = await Promise.all(fileUploadPromises);

        // const fileEvents = fileResults
        //   .filter((result): result is NonNullable<typeof result> => result !== null)
        //   .map((fileData) => ({
        //     type: "CORE:FILE_SHARED" as const,
        //     data: {
        //       direction: "from-user-to-agent" as const,
        //       iterateFileId: fileData.iterateFileId,
        //       originalFilename: fileData.originalFilename,
        //       size: fileData.size,
        //       mimeType: fileData.mimeType,
        //       openAIFileId: fileData.openAIFileId,
        //     },
        //     triggerLLMRequest: false,
        //   }));

        // return fileEvents;
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
    const previousMessages = await this.db
      .select()
      .from(slackWebhookEvent)
      .where(
        and(
          or(eq(slackWebhookEvent.thread_ts, threadTs), eq(slackWebhookEvent.ts, threadTs)),
          eq(slackWebhookEvent.type, "message"),
        ),
      )
      .orderBy(asc(slackWebhookEvent.ts));
    timings.getMessagesInThread = performance.now() - timings.startTime;

    type TextMessage = typeof slackWebhookEvent.$inferSelect & {
      data: { text: string; ts: string; user: string };
    };
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
    _slackUserId: string,
    _botUserId?: string,
  ): Promise<ParticipantJoinedEventInput[]> {
    return [];
    // if (slackUserId === botUserId) {
    //   return [];
    // }
    // const currentState = this.agentCore.state;
    // for (const participant of Object.values(currentState.participants || {})) {
    //   if (participant.externalUserMapping?.slack?.externalUserId === slackUserId) {
    //     return []; // Already a participant, skip DB queries
    //   }
    // }

    // const userMapping = await serverTrpc.platform.integrations.getIntegrationUserMapping.query({
    //   integrationSlug: "slack",
    //   externalUserId: slackUserId,
    // });
    // if (!userMapping?.internalUserId) {
    //   return [];
    // }

    // if (currentState.participants && userMapping.internalUserId in currentState.participants) {
    //   return [];
    // }

    // const { user } = await serverTrpc.platform.auth.getUserById.query({
    //   id: userMapping.internalUserId,
    // });

    // return [
    //   {
    //     type: "CORE:PARTICIPANT_JOINED",
    //     data: {
    //       internalUserId: userMapping.internalUserId,
    //       email: user.email,
    //       displayName: user.name,
    //       externalUserMapping: {
    //         slack: {
    //           integrationSlug: userMapping.integrationSlug,
    //           externalUserId: userMapping.externalUserId,
    //           internalUserId: userMapping.internalUserId,
    //           email: user.email,
    //           rawUserInfo: userMapping.rawUserInfo || undefined,
    //         },
    //       },
    //     },
    //     triggerLLMRequest: false,
    //     metadata: {},
    //   },
    // ];
  }

  /**
   * Creates PARTICIPANT_MENTIONED events for users mentioned in a message.
   * These are lightweight participants who haven't actively participated yet.
   */
  protected async getParticipantMentionedEvents(
    _messageText: string,
    _currentSlackUserId?: string,
    _botUserId?: string,
  ): Promise<ParticipantMentionedEventInput[]> {
    return [];
    // const mentionedUserIds = getMentionedExternalUserIds(messageText);
    // const currentState = this.agentCore.state;

    // const existingSlackUserIds = new Set([
    //   ...Object.values(currentState.participants || {})
    //     .map((p) => p.externalUserMapping?.slack?.externalUserId)
    //     .filter(Boolean),
    //   ...Object.values(currentState.mentionedParticipants || {})
    //     .map((p) => p.externalUserMapping?.slack?.externalUserId)
    //     .filter(Boolean),
    // ]);

    // const newMentionedUserIds = R.pipe(
    //   mentionedUserIds,
    //   R.filter((id) => id !== botUserId && id !== currentSlackUserId),
    //   R.filter((id) => !existingSlackUserIds.has(id)),
    //   R.unique(),
    // );

    // if (newMentionedUserIds.length === 0) {
    //   return [];
    // }

    // const userMappingResults = await Promise.all(
    //   newMentionedUserIds.map(async (slackUserId) => {
    //     const mapping = await serverTrpc.platform.integrations.getIntegrationUserMapping.query({
    //       integrationSlug: "slack",
    //       externalUserId: slackUserId,
    //     });
    //     return { slackUserId, mapping };
    //   }),
    // );

    // const validMappings = userMappingResults.filter(
    //   (
    //     result,
    //   ): result is {
    //     slackUserId: string;
    //     mapping: NonNullable<typeof result.mapping> & { internalUserId: string };
    //   } =>
    //     result.mapping?.internalUserId != null && typeof result.mapping.internalUserId === "string",
    // );

    // const userDetails = await Promise.all(
    //   validMappings.map(async ({ slackUserId, mapping }) => {
    //     const { user } = await serverTrpc.platform.auth.getUserById.query({
    //       id: mapping.internalUserId,
    //     });
    //     return { slackUserId, mapping, user };
    //   }),
    // );

    // const validUserDetails = R.filter(userDetails, R.isTruthy);

    // return validUserDetails.map(
    //   ({ mapping, user }): ParticipantMentionedEventInput => ({
    //     type: "CORE:PARTICIPANT_MENTIONED",
    //     data: {
    //       internalUserId: mapping.internalUserId,
    //       email: user.email,
    //       displayName: user.name,
    //       externalUserMapping: {
    //         slack: {
    //           integrationSlug: mapping.integrationSlug,
    //           externalUserId: mapping.externalUserId,
    //           internalUserId: mapping.internalUserId,
    //           email: user.email,
    //           rawUserInfo: mapping.rawUserInfo ?? undefined,
    //         },
    //       },
    //     },
    //     triggerLLMRequest: false,
    //     metadata: {},
    //   }),
    // );
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

  // Not really sure what this is for - seems pretty janky
  async getSlackPermalink(): Promise<string | undefined> {
    const state = await this.getState();
    const botUserId = state.reducedState?.botUserId;

    let lastUserMessage: any = null;

    const events = this.getEventsByType("SLACK:WEBHOOK_EVENT_RECEIVED");

    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];

      if (event.type === "SLACK:WEBHOOK_EVENT_RECEIVED") {
        const slackEvent = (event.data?.payload as { event?: SlackEvent })?.event;

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
        const result = await this.slackAPI.chat.getPermalink({
          channel: messageChannelId,
          message_ts: ts,
        });
        if (result.ok && result.permalink) {
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
        const result = await this.slackAPI.chat.getPermalink({
          channel: channelId,
          message_ts: threadTs,
        });
        if (result.ok && result.permalink) {
          return result.permalink;
        }
      } catch (error) {
        console.error("Failed to get Slack permalink:", error);
      }
    }
    return undefined;
  }

  /**
   * Finds the most recent Slack message timestamp (ts) seen by this agent from webhook events
   */
  protected async mostRecentSlackMessageTs(): Promise<string | null> {
    const events = this.getEventsByType("SLACK:WEBHOOK_EVENT_RECEIVED");
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      const slackEvent = (event.data?.payload as { event?: SlackEvent })?.event;
      return slackEvent?.type === "message" && typeof slackEvent.ts === "string"
        ? slackEvent.ts
        : null;
    }
    return null;
  }

  async onSlackWebhookEventReceived(slackWebhookPayload: SlackWebhookPayload) {
    const slackEvent = slackWebhookPayload.event!;
    const messageMetadata = await getMessageMetadata(slackEvent, this.db);

    if (!messageMetadata || !messageMetadata.channel || !messageMetadata.threadTs) {
      return;
    }

    const botUserId = extractBotUserIdFromAuthorizations(slackWebhookPayload);

    if (!botUserId) {
      return;
    }

    const currentState = this.agentCore.state;
    const isSlackInitialized = !!currentState.slackChannelId;
    const isThreadStarter = messageMetadata.ts === messageMetadata.threadTs;

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
        payload: slackWebhookPayload,
        updateThreadIds: true,
      },
      // Don't trigger LLM for bot messages or non-message events
      triggerLLMRequest: slackEvent.type === "message" && !isBotMessageThatShouldBeIgnored,
      idempotencyKey: slackWebhookEventToIdempotencyKey(slackWebhookPayload),
    });

    // Batch add events
    await this.addEvents(events);

    return {
      success: true,
    };
  }

  async sendSlackMessage(input: Inputs["sendSlackMessage"]) {
    const slackThreadId = this.agentCore.state.slackThreadId;
    const slackChannelId = this.agentCore.state.slackChannelId;

    if (typeof slackThreadId !== "string" || typeof slackChannelId !== "string") {
      throw new Error("Slack thread ID and channel ID must be strings");
    }

    const { endTurn, ...sendInput } = input;

    const result = await this.slackAPI.chat.postMessage({
      channel: this.agentCore.state.slackChannelId as string,
      thread_ts: this.agentCore.state.slackThreadId as string,
      text: sendInput.text,
    });

    if (!result.ok) {
      throw new Error(`Failed to send Slack message: ${result.error}`);
    }

    // Build magic return properties based on behaviour
    const magic: MagicAgentInstructions = {};
    if (endTurn) {
      magic.__triggerLLMRequest = false;
    }

    // return an empty object to conserve tokens in the success case, plus magic flags if any
    return {
      ...(result.ok ? {} : result),
      ...magic,
    };
  }

  async addSlackReaction(input: Inputs["addSlackReaction"]) {
    return await this.slackAPI.reactions.add({
      channel: this.agentCore.state.slackChannelId!,
      timestamp: input.messageTs,
      name: input.name,
    });
  }

  async removeSlackReaction(input: Inputs["removeSlackReaction"]) {
    return await this.slackAPI.reactions.remove({
      channel: this.agentCore.state.slackChannelId!,
      timestamp: input.messageTs,
      name: input.name,
    });
  }

  // async uploadAndShareFileInSlack(input: Inputs["uploadAndShareFileInSlack"]) {
  //   const slackThreadId = this.agentCore.state.slackThreadId;
  //   const slackChannelId = this.agentCore.state.slackChannelId;

  //   if (typeof slackThreadId !== "string" || typeof slackChannelId !== "string") {
  //     throw new Error("Slack thread ID and channel ID must be strings");
  //   }

  //   try {
  //     const uploadResult = await serverTrpc.platform.integrations.slack.uploadFileToSlack.mutate({
  //       channel: slackChannelId,
  //       threadTs: slackThreadId,
  //       ...input,
  //     });
  //     return uploadResult;
  //   } catch (error) {
  //     return {
  //       success: false,
  //       error: error instanceof Error ? error.message : "Unknown error",
  //     };
  //   }
  // }

  async updateSlackMessage(input: Inputs["updateSlackMessage"]) {
    return await this.slackAPI.chat.update({
      channel: this.agentCore.state.slackChannelId!,
      blocks: [],
      ...input,
    });
  }

  async stopRespondingUntilMentioned(_input: Inputs["stopRespondingUntilMentioned"]) {
    try {
      const channel = this.agentCore.state.slackChannelId;
      const ts = await this.mostRecentSlackMessageTs();
      if (channel && ts) {
        await this.slackAPI.reactions.add({
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

  async getUrlContent(_input: Inputs["getUrlContent"]) {
    throw new Error("Not implemented");
    // return await getUrlContent({
    //   url: input.url,
    //   shouldMakeScreenshot: input.shouldMakeScreenshot,
    // });
  }

  async searchWeb(_input: Inputs["searchWeb"]) {
    throw new Error("Not implemented");
    // const searchRequest = {
    //   ...input,
    //   type: "auto" as const,
    // };
    // return await serverTrpc.platform.defaultTools.exaSearch.mutate(searchRequest);
  }
}
