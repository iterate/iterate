import type { SlackEvent } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { and, asc, eq, or, inArray } from "drizzle-orm";
import pDebounce from "p-suite/p-debounce";
import { env as _env, env } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import { getSlackAccessTokenForEstate } from "../auth/token-utils.ts";
import {
  slackWebhookEvent,
  providerUserMapping,
  estate,
  organizationUserMembership,
  organization,
  user,
} from "../db/schema.ts";
import { getFileContent, uploadFileFromURL } from "../file-handlers.ts";
import type {
  AgentCoreDeps,
  AgentCoreEventInput,
  MergedEventInputForSlices,
} from "./agent-core.ts";
import type { DOToolDefinitions } from "./do-tools.ts";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import { CORE_AGENT_SLICES, IterateAgent } from "./iterate-agent.ts";
import { slackAgentTools } from "./slack-agent-tools.ts";
import { slackSlice, type SlackSliceState } from "./slack-slice.ts";
import { shouldIncludeEventInConversation, shouldUnfurlSlackMessage } from "./slack-agent-utils.ts";
import type {
  AgentCoreEvent,
  CoreReducedState,
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
import { createSlackAPIMock } from "./slack-api-mock.ts";
// Inherit generic static helpers from IterateAgent

// memorySlice removed for now
const slackAgentSlices = [...CORE_AGENT_SLICES, slackSlice] as const;
export type SlackAgentSlices = typeof slackAgentSlices;

type ToolsInterface = typeof slackAgentTools.$infer.interface;
type Inputs = typeof slackAgentTools.$infer.inputTypes;
import type { AgentInitParams } from "./iterate-agent.ts";

export class SlackAgent extends IterateAgent<SlackAgentSlices> implements ToolsInterface {
  static getNamespace() {
    // cast necessary to avoid typescript error:
    // Class static side 'typeof SlackAgent' incorrectly extends base class static side 'typeof IterateAgent'.
    // The types returned by 'getNamespace()' are incompatible between these types.

    // tradeoff: types for some other static methods inherited from IterateAgent like getOrCreateStubByName
    // are for IterateAgent, rather than SlackAgent, so a cast is necessary if you want to call slack-specific methods on a stub.
    return env.SLACK_AGENT as unknown as typeof env.ITERATE_AGENT;
  }

  protected slackAPI!: WebClient;

  private updateSlackStatusDebounced = pDebounce(async (status: string | null) => {
    const { slackChannelId, slackThreadId } = this.getReducedState() as SlackSliceState;
    if (!slackChannelId || !slackThreadId) return;

    await this.slackAPI.assistant.threads.setStatus({
      channel_id: slackChannelId,
      thread_ts: slackThreadId,
      status: status || "",
    });
  }, 300);

  private checkAndClearTypingIndicator = pDebounce(async () => {
    const state = this.agentCore.state as SlackSliceState;
    const status = state.typingIndicatorStatus;

    if (!status) return;

    if (this.agentCore.llmRequestInProgress()) {
      void this.checkAndClearTypingIndicator();
      return;
    }

    this.agentCore.addEvents([
      {
        type: "SLACK:UPDATE_TYPING_STATUS",
        data: { status: null },
      },
    ]);
    void this.updateSlackStatusDebounced(null);
  }, 15000);

  private syncTypingIndicator() {
    const state = this.agentCore.state as SlackSliceState;
    const status = state.typingIndicatorStatus ?? null;

    void this.updateSlackStatusDebounced(status);

    if (status) {
      void this.checkAndClearTypingIndicator();
    }
  }

  // This gets run between the synchronous durable object constructor and the asynchronous onStart method of the agents SDK
  async initAfterConstructorBeforeOnStart(params: AgentInitParams) {
    await super.initAfterConstructorBeforeOnStart(params);

    if (params.record.durableObjectName.includes("mock_slack")) {
      this.slackAPI = createSlackAPIMock<WebClient>();
      return;
    }

    const slackAccessToken = await getSlackAccessTokenForEstate(this.db, params.record.estateId);
    if (!slackAccessToken) {
      throw new Error(`Slack access token not set for estate ${params.record.estateId}.`);
    }
    // For now we want to make errors maximally visible
    this.slackAPI = new WebClient(slackAccessToken, {
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
    });
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
      onEventAdded: (payload: {
        event: AgentCoreEvent;
        reducedState: CoreReducedState;
        getFinalRedirectUrl?: (payload: {
          durableObjectInstanceName: string;
        }) => Promise<string | undefined>;
      }) => {
        deps?.onEventAdded?.(payload);

        const event = payload.event as AgentCoreEvent;
        switch (event.type) {
          case "CORE:LLM_REQUEST_START":
            this.agentCore.addEvents([
              {
                type: "SLACK:UPDATE_TYPING_STATUS",
                data: { status: "is typing..." },
              },
            ]);
            break;

          case "CORE:LLM_REQUEST_CANCEL":
            this.agentCore.addEvents([
              {
                type: "SLACK:UPDATE_TYPING_STATUS",
                data: { status: null },
              },
            ]);
            break;
          case "CORE:FILE_SHARED": {
            const fileSharedEvent = payload.event as AgentCoreEvent & { type: "CORE:FILE_SHARED" };
            if (fileSharedEvent.data.direction === "from-agent-to-user") {
              void this.shareFileWithSlack({
                iterateFileId: fileSharedEvent.data.iterateFileId,
                originalFilename: fileSharedEvent.data.originalFilename,
              }).catch((error) => {
                logger.warn(
                  `[SlackAgent] Failed automatically sharing file ${fileSharedEvent.data.iterateFileId} in Slack:`,
                  error,
                );
              });
            }
            break;
          }
          case "CORE:INTERNAL_ERROR": {
            logger.error("[SlackAgent] Internal Error:", payload.event);
            const errorEvent = payload.event as AgentCoreEvent & { type: "CORE:INTERNAL_ERROR" };
            const errorMessage = errorEvent.data?.error || "Unknown error";
            void this.getAgentDebugURL().then((url) =>
              this.sendSlackMessage({
                text: `There was an internal error; the debug URL is ${url.debugURL}.\n\n${errorMessage.slice(0, 256)}${errorMessage.length > 256 ? "..." : ""}`,
              }),
            );
            break;
          }
        }

        if (event.type !== "CORE:LOG") {
          this.syncTypingIndicator();
        }
      },
      getFinalRedirectUrl: async (_payload: { durableObjectInstanceName: string }) => {
        return await this.getSlackPermalink();
      },
      lazyConnectionDeps: {
        getDurableObjectInfo: () => this.hydrationInfo,
        getEstateId: () => this.databaseRecord.estateId,
        getReducedState: () => this.agentCore.state,
        mcpConnectionCache: this.mcpManagerCache,
        mcpConnectionQueues: this.mcpConnectionQueues,
        getFinalRedirectUrl: async (_payload: { durableObjectInstanceName: string }) => {
          return await this.getSlackPermalink();
        },
      },
    };
  }

  // Turn any files shared with the bot into iterate files that can be used by the LLM
  protected async convertSlackSharedFilesToIterateFileSharedEvents(
    slackEvent: SlackEvent,
    botUserId: string | undefined,
  ): Promise<AgentCoreEventInput[]> {
    if (shouldIncludeEventInConversation(slackEvent, botUserId) && slackEvent?.type === "message") {
      if (slackEvent.subtype === "file_share" && slackEvent.files) {
        const fileUploadPromises = slackEvent.files.map(async (slackFile) => {
          try {
            const downloadUrl = slackFile.url_private_download || slackFile.url_private;
            if (!downloadUrl) {
              logger.error(`No download URL for Slack file ${slackFile.id}`);
              return null;
            }
            const fileRecord = await uploadFileFromURL({
              url: downloadUrl,
              filename: slackFile.name || `slack-file-${slackFile.id}`,
              estateId: this.databaseRecord.estateId,
              db: this.db,
              headers: {
                Authorization: `Bearer ${this.slackAPI.token}`,
              },
            });
            logger.log("File record", fileRecord);
            return {
              iterateFileId: fileRecord.id,
              originalFilename: fileRecord.filename ?? undefined,
              size: fileRecord.fileSize ?? undefined,
              mimeType: fileRecord.mimeType ?? undefined,
              openAIFileId: fileRecord.openAIFileId || undefined,
              slackFileId: slackFile.id,
            };
          } catch (error) {
            logger.error(`Failed to upload Slack file ${slackFile.id}:`, error);
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
   * Also processes any files that were shared in the thread history
   */
  public async getSlackThreadHistoryInputEvents(
    threadTs: string,
    botUserId: string | undefined,
  ): Promise<AgentCoreEventInput[]> {
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

    const events: AgentCoreEventInput[] = [
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

    // Process any files that were shared in the thread history
    const fileEventsPromises = previousMessages.map(async (message) => {
      const slackEvent = message.data as SlackEvent;
      return await this.convertSlackSharedFilesToIterateFileSharedEvents(slackEvent, botUserId);
    });

    const fileEventsArrays = await Promise.all(fileEventsPromises);
    const fileEvents = fileEventsArrays.flat();

    events.push(...fileEvents);

    return events;
  }

  /**
   * Adds a participant to the conversation when they send a message.
   * This is crucial for MCP personal connections to work properly.
   */
  public async getParticipantJoinedEvents(
    slackUserId: string,
    botUserId?: string,
  ): Promise<ParticipantJoinedEventInput[]> {
    if (slackUserId === botUserId) {
      return [];
    }
    const currentState = this.agentCore.state;

    const existingParticipant = Object.values(currentState.participants || {}).find(
      (participant) => participant.externalUserMapping?.slack?.externalUserId === slackUserId,
    );
    if (existingParticipant) {
      return [];
    }

    const estateId = this.databaseRecord.estateId;

    const result = await this.db
      .select({
        userId: user.id,
        userEmail: user.email,
        userName: user.name,
        slackUserId: providerUserMapping.externalId,
        providerMetadata: providerUserMapping.providerMetadata,
      })
      .from(providerUserMapping)
      .innerJoin(user, eq(providerUserMapping.internalUserId, user.id))
      .innerJoin(organizationUserMembership, eq(user.id, organizationUserMembership.userId))
      .innerJoin(organization, eq(organizationUserMembership.organizationId, organization.id))
      .innerJoin(estate, eq(organization.id, estate.organizationId))
      .where(
        and(
          eq(providerUserMapping.providerId, "slack-bot"),
          eq(providerUserMapping.externalId, slackUserId),
          eq(estate.id, estateId),
        ),
      )
      .limit(1);

    // If no result, user either doesn't exist or doesn't have access to this estate
    if (!result[0]) {
      logger.info(
        `[SlackAgent] User ${slackUserId} does not exist or does not have access to estate ${estateId}`,
      );
      return [];
    }

    const userInfo = result[0];

    if (currentState.participants[userInfo.userId]) {
      return [];
    }

    const internalUser = {
      id: userInfo.userId,
      email: userInfo.userEmail,
      name: userInfo.userName,
    };
    const externalId = userInfo.slackUserId;
    const providerMetadata = userInfo.providerMetadata;

    return [
      {
        type: "CORE:PARTICIPANT_JOINED",
        data: {
          internalUserId: internalUser.id,
          email: internalUser.email,
          displayName: internalUser.name,
          externalUserMapping: {
            slack: {
              integrationSlug: "slack",
              externalUserId: externalId,
              internalUserId: internalUser.id,
              email: internalUser.email,
              rawUserInfo: providerMetadata as Record<string, unknown>,
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

    if (mentionedUserIds.length === 0) {
      return [];
    }

    const existingSlackUserIds = new Set([
      ...Object.values(currentState.participants || {})
        .map((p) => p.externalUserMapping?.slack?.externalUserId)
        .filter(Boolean),
      ...Object.values(currentState.mentionedParticipants || {})
        .map((p) => p.externalUserMapping?.slack?.externalUserId)
        .filter(Boolean),
    ]);

    const newMentionedUserIds = mentionedUserIds
      .filter((id) => id !== botUserId && id !== currentSlackUserId)
      .filter((id) => !existingSlackUserIds.has(id))
      .filter((id, index, arr) => arr.indexOf(id) === index);

    if (newMentionedUserIds.length === 0) {
      return [];
    }

    const userMappings = await this.db.query.providerUserMapping.findMany({
      where: and(
        eq(providerUserMapping.providerId, "slack-bot"),
        inArray(providerUserMapping.externalId, newMentionedUserIds),
      ),
      with: {
        internalUser: true,
      },
    });

    return userMappings
      .filter((userMapping) => userMapping.internalUser != null)
      .map((userMapping): ParticipantMentionedEventInput => {
        const { internalUser, externalId, providerMetadata } = userMapping;
        return {
          type: "CORE:PARTICIPANT_MENTIONED",
          data: {
            internalUserId: internalUser!.id,
            email: internalUser!.email,
            displayName: internalUser!.name,
            externalUserMapping: {
              slack: {
                integrationSlug: "slack",
                externalUserId: externalId,
                internalUserId: internalUser.id,
                email: internalUser.email,
                rawUserInfo: providerMetadata as Record<string, unknown>,
              },
            },
          },
          triggerLLMRequest: false,
          metadata: {},
        };
      });
  }

  public async initSlack(channelId: string, threadTs: string) {
    const events: MergedEventInputForSlices<SlackAgentSlices>[] = [];
    events.push({
      type: "SLACK:UPDATE_SLICE_STATE",
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
        logger.error("Failed to get Slack permalink:", error);
      }
    } else {
      // if we can't find any message, get link to the thread
      const channelId = state.reducedState?.slackChannelId;
      const threadTs = state.reducedState?.slackThreadId;

      if (!channelId || !threadTs) {
        logger.error("Channel ID and thread TS are required to get a Slack permalink", {
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
        logger.error("Failed to get Slack permalink:", error);
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

  // This function is the primary interface between Slack and our agent.
  // Slack sends us webhook events, we route them to a durable object and then here,
  // in the durable object, we create agent core events that get added to the agent.
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
      this.convertSlackSharedFilesToIterateFileSharedEvents(slackEvent, botUserId),
      !isSlackInitialized && !isThreadStarter
        ? this.getSlackThreadHistoryInputEvents(messageMetadata.threadTs, botUserId)
        : Promise.resolve([]),
    ]);
    events.push(...(eventsLists satisfies Array<AgentCoreEventInput[]>).flat());

    // Pass the webhook event to the reducer
    // The reducer will handle filtering and determine if LLM computation should be triggered
    events.push({
      type: "SLACK:WEBHOOK_EVENT_RECEIVED",
      data: {
        payload: slackWebhookPayload,
        updateThreadIds: true,
      },
      // Don't trigger LLM for bot messages or non-message events
      triggerLLMRequest: slackEvent.type === "message" && !isBotMessageThatShouldBeIgnored,
      idempotencyKey: slackWebhookEventToIdempotencyKey(slackWebhookPayload),
    });

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

    const doUnfurl = shouldUnfurlSlackMessage({
      text: sendInput.text,
      unfurl: sendInput.unfurl,
    });

    const result = await this.slackAPI.chat.postMessage({
      channel: this.agentCore.state.slackChannelId as string,
      thread_ts: this.agentCore.state.slackThreadId as string,
      text: sendInput.text,
      // for some reason, I have to set both of these to the same value to get unfurling to stop
      unfurl_links: doUnfurl,
      unfurl_media: doUnfurl,
    });

    if (!result.ok) {
      throw new Error(`Failed to send Slack message: ${result.error}`);
    }

    const magic: MagicAgentInstructions = {};
    if (endTurn) {
      magic.__triggerLLMRequest = false;
      this.agentCore.addEvents([
        {
          type: "SLACK:UPDATE_TYPING_STATUS",
          data: { status: null },
        },
      ]);
      this.syncTypingIndicator();
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
      logger.warn("[SlackAgent] Failed adding zipper-mouth reaction:", error);
    }
    return {
      __pauseAgentUntilMentioned: true,
      __triggerLLMRequest: false,
    } satisfies MagicAgentInstructions;
  }

  async shareFileWithSlack(params: { iterateFileId: string; originalFilename?: string | null }) {
    const slackThreadId = this.agentCore.state.slackThreadId;
    const slackChannelId = this.agentCore.state.slackChannelId;

    if (typeof slackThreadId !== "string" || typeof slackChannelId !== "string") {
      throw new Error(
        "INTERNAL ERROR: Slack thread ID and channel ID are not set on the agent core state. This is an iterate bug.",
      );
    }

    const { content, fileRecord } = await getFileContent({
      iterateFileId: params.iterateFileId,
      db: this.db,
      estateId: this.databaseRecord.estateId,
    });

    const filename = params.originalFilename || fileRecord.filename || fileRecord.id;
    const filenameWithExtension = filename.includes(".") ? filename : `${filename}.txt`;

    const buffer = Buffer.from(await new Response(content).arrayBuffer());

    const uploadUrlResponse = await this.slackAPI.files.getUploadURLExternal({
      filename: filenameWithExtension,
      length: buffer.length,
    });

    if (!uploadUrlResponse.ok || !uploadUrlResponse.upload_url || !uploadUrlResponse.file_id) {
      throw new Error("Failed to get upload URL from Slack");
    }

    const uploadResponse = await fetch(uploadUrlResponse.upload_url, {
      method: "POST",
      body: buffer,
      headers: {
        "Content-Type": fileRecord.mimeType || "application/octet-stream",
        "Content-Length": buffer.length.toString(),
      },
    });

    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload file data: ${uploadResponse.statusText}`);
    }

    const completeResponse = await this.slackAPI.files.completeUploadExternal({
      files: [
        {
          id: uploadUrlResponse.file_id,
          title: filenameWithExtension,
        },
      ],
      channel_id: slackChannelId,
      thread_ts: slackThreadId,
    });

    if (!completeResponse.ok) {
      throw new Error(
        `Failed to share file in Slack: ${completeResponse.error ?? "Unknown error"}`,
      );
    }
  }

  async uploadAndShareFileInSlack() {
    return {
      message:
        "This function no longer exists - but we need it here because otherwise the agent would be bricked",
    };
  }
}
