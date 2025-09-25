import type { SlackEvent } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { and, asc, eq, or, inArray } from "drizzle-orm";
import { waitUntil } from "cloudflare:workers";
import { env as _env, env } from "../../env.ts";
import { getSlackAccessTokenForEstate } from "../auth/token-utils.ts";
import { slackWebhookEvent, providerUserMapping } from "../db/schema.ts";
import { getFileContent, uploadFileFromURL } from "../file-handlers.ts";
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
// import { renderPromptFragment } from "./prompt-fragments.ts";
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

  protected slackAPI!: WebClient;

  // This gets run between the synchronous durable object constructor and the asynchronous onStart method of the agents SDK
  async initAfterConstructorBeforeOnStart(params: { record: AgentInstanceDatabaseRecord }) {
    await super.initAfterConstructorBeforeOnStart(params);

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
            waitUntil(
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
            waitUntil(
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
              console.error(`No download URL for Slack file ${slackFile.id}`);
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
            console.log("File record", fileRecord);
            return {
              iterateFileId: fileRecord.id,
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

  // Removed: getSlackThreadHistoryInputEvents

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

    const existingParticipant = Object.values(currentState.participants || {}).find(
      (participant) => participant.externalUserMapping?.slack?.externalUserId === slackUserId,
    );
    if (existingParticipant) {
      return [];
    }

    const userMapping = await this.db.query.providerUserMapping.findFirst({
      where: and(
        eq(providerUserMapping.providerId, "slack-bot"),
        eq(providerUserMapping.externalId, slackUserId),
      ),
      with: {
        internalUser: true,
      },
    });

    if (!userMapping?.internalUser) {
      return [];
    }

    if (currentState.participants[userMapping.internalUser.id]) {
      return [];
    }

    const { internalUser, externalId, providerMetadata } = userMapping;

    return [
      {
        type: "CORE:PARTICIPANT_JOINED" as const,
        data: {
          internalUserId: internalUser.id,
          email: internalUser.email,
          displayName: internalUser.name,
          externalUserMapping: {
            slack: {
              integrationSlug: "slack" as const,
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
    ] as const;
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
          type: "CORE:PARTICIPANT_MENTIONED" as const,
          data: {
            internalUserId: internalUser!.id,
            email: internalUser!.email,
            displayName: internalUser!.name,
            externalUserMapping: {
              slack: {
                integrationSlug: "slack" as const,
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
    const events: MergedEventInputForSlices<SlackAgentSlices>[] = [
      {
        type: "SLACK:UPDATE_SLICE_STATE" as const,
        data: {
          slackChannelId: channelId,
          slackThreadId: threadTs,
        },
        triggerLLMRequest: false,
      },
    ];
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

  // This function is the primary interface between Slack and our agent.
  // Slack sends us webhook events, we route them to a durable object and then here,
  // in the durable object, we create agent core events that get added to the agent.
  async onSlackWebhookEventReceived(
    slackWebhookPayloadOrList: SlackWebhookPayload | SlackWebhookPayload[],
  ) {
    const inputPayloads: SlackWebhookPayload[] = Array.isArray(slackWebhookPayloadOrList)
      ? slackWebhookPayloadOrList
      : [slackWebhookPayloadOrList];

    const firstPayload = inputPayloads[0];
    const firstEvent = firstPayload?.event;
    if (!firstEvent) {
      return;
    }

    const firstMetadata = await getMessageMetadata(firstEvent, this.db);
    if (!firstMetadata || !firstMetadata.channel || !firstMetadata.threadTs) {
      return;
    }

    // Prefer botUserId from payload; fall back to slice state if present
    const botUserId =
      extractBotUserIdFromAuthorizations(firstPayload) ||
      (this.agentCore.state as SlackSliceState)?.botUserId;

    if (!botUserId) {
      return;
    }

    const currentState = this.agentCore.state;
    const isSlackInitialized = !!currentState.slackChannelId;
    const isThreadStarter = firstMetadata.ts === firstMetadata.threadTs;

    const events: MergedEventInputForSlices<SlackAgentSlices>[] = [];

    // One-time back & front fill: if first time and mid-thread, pull entire thread history
    let payloadsToProcess: SlackWebhookPayload[] = inputPayloads;
    if (!isSlackInitialized && !isThreadStarter) {
      // Back & front fill: load all webhooks in this thread from DB
      const allThreadRows = await this.db
        .select()
        .from(slackWebhookEvent)
        .where(
          and(
            or(
              eq(slackWebhookEvent.thread_ts, firstMetadata.threadTs),
              eq(slackWebhookEvent.ts, firstMetadata.threadTs),
            ),
            eq(slackWebhookEvent.channel, firstMetadata.channel),
            eq(slackWebhookEvent.estateId, this.databaseRecord.estateId),
          ),
        )
        .orderBy(asc(slackWebhookEvent.ts));

      const template: Omit<SlackWebhookPayload, "event"> = {
        team_id: firstPayload.team_id,
        authorizations: firstPayload.authorizations,
      };

      const backAndFrontFillPayloads: SlackWebhookPayload[] = allThreadRows.map((row) => ({
        ...template,
        event: row.data as any,
      }));

      // Merge DB payloads with input payloads, dedupe by idempotency key, sort by ts asc
      const merged = [...backAndFrontFillPayloads, ...inputPayloads];
      const dedupedMap = new Map<string, SlackWebhookPayload>();
      for (const p of merged) {
        const key = slackWebhookEventToIdempotencyKey(p);
        if (!dedupedMap.has(key)) {
          dedupedMap.set(key, p);
        }
      }
      payloadsToProcess = Array.from(dedupedMap.values()).sort((a, b) => {
        const ats = (a.event as any)?.ts || (a.event as any)?.event_ts || "0";
        const bts = (b.event as any)?.ts || (b.event as any)?.event_ts || "0";
        return parseFloat(ats) - parseFloat(bts);
      });
    }

    // Ensure slice has channel/thread set as early as possible on first call
    if (!isSlackInitialized) {
      events.push({
        type: "SLACK:UPDATE_SLICE_STATE" as const,
        data: {
          slackChannelId: firstMetadata.channel,
          slackThreadId: firstMetadata.threadTs,
        },
        triggerLLMRequest: false,
      });
    }

    // Track to avoid emitting duplicates in this batch
    const seenJoinSlackUserIds = new Set<string>();
    const seenResume = { value: false };

    for (const slackWebhookPayload of payloadsToProcess) {
      const slackEvent = slackWebhookPayload.event!;

      const isBotMessage =
        botUserId &&
        (("user" in slackEvent && slackEvent.user === botUserId) || "bot_id" in slackEvent);
      const isFromOurBot = botUserId && "user" in slackEvent && slackEvent.user === botUserId;
      const isBotMessageThatShouldBeIgnored =
        isFromOurBot || (isBotMessage && !isBotMentionedInMessage(slackEvent, botUserId));

      const messageMetadata = await getMessageMetadata(slackEvent, this.db);
      if (!messageMetadata || !messageMetadata.channel || !messageMetadata.threadTs) {
        continue;
      }

      if (currentState.paused && slackEvent.type === "message" && "text" in slackEvent) {
        const messageText = slackEvent.text;
        if (messageText) {
          const mentionedUserIds = getMentionedExternalUserIds(messageText);
          if (!seenResume.value && mentionedUserIds.includes(botUserId)) {
            events.push({ type: "CORE:RESUME_LLM_REQUESTS", triggerLLMRequest: false });
            seenResume.value = true;
          }
        }
      }

      const eventsLists = await Promise.all([
        slackEvent?.type === "message" && "user" in slackEvent && slackEvent.user
          ? seenJoinSlackUserIds.has(slackEvent.user)
            ? Promise.resolve([])
            : this.getParticipantJoinedEvents(slackEvent.user, botUserId).then((evts) => {
                if (evts.length > 0) seenJoinSlackUserIds.add(slackEvent.user as string);
                return evts;
              })
          : Promise.resolve([]),
        slackEvent?.type === "message" && "text" in slackEvent && slackEvent.text
          ? this.getParticipantMentionedEvents(
              slackEvent.text,
              "user" in slackEvent ? (slackEvent.user as string | undefined) : undefined,
              botUserId,
            )
          : Promise.resolve([]),
        this.convertSlackSharedFilesToIterateFileSharedEvents(slackEvent, botUserId),
      ]);
      events.push(...(eventsLists satisfies Array<AgentCoreEventInput[]>).flat());

      // Always add the raw webhook event
      events.push({
        type: "SLACK:WEBHOOK_EVENT_RECEIVED" as const,
        data: {
          payload: slackWebhookPayload,
          updateThreadIds: true,
        },
        triggerLLMRequest: slackEvent.type === "message" && !isBotMessageThatShouldBeIgnored,
        idempotencyKey: slackWebhookEventToIdempotencyKey(slackWebhookPayload),
      });
    }

    await this.addEvents(events);

    return { events };
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

  async uploadAndShareFileInSlack(input: Inputs["uploadAndShareFileInSlack"]) {
    const slackThreadId = this.agentCore.state.slackThreadId;
    const slackChannelId = this.agentCore.state.slackChannelId;

    if (typeof slackThreadId !== "string" || typeof slackChannelId !== "string") {
      throw new Error(
        "INTERNAL ERROR: Slack thread ID and channel ID are not set on the agent core state. This is an iterate bug.",
      );
    }
    const { content, fileRecord } = await getFileContent({
      iterateFileId: input.iterateFileId,
      db: this.db,
      estateId: this.databaseRecord.estateId,
    });

    // Ensure filename has a proper extension for better Slack unfurl behavior
    const filename = fileRecord.filename || fileRecord.id;
    const filenameWithExtension = filename.includes(".") ? filename : `${filename}.txt`;

    try {
      // The Slack SDK's uploadV2 helper doesn't handle ReadableStream properly,
      // so we implement the three-step process manually as per:
      // https://docs.slack.dev/messaging/working-with-files/#upload

      // Convert ReadableStream to Buffer for upload
      const buffer = Buffer.from(await new Response(content).arrayBuffer());

      // Step 1: Get upload URL from Slack
      const uploadUrlResponse = await this.slackAPI.files.getUploadURLExternal({
        filename: filenameWithExtension,
        length: buffer.length,
      });

      if (!uploadUrlResponse.ok || !uploadUrlResponse.upload_url || !uploadUrlResponse.file_id) {
        throw new Error("Failed to get upload URL from Slack");
      }

      // Step 2: Upload file data to the external URL
      // The external URL expects raw binary data, not multipart form data
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

      // Step 3: Complete the upload and share in the channel
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

      return completeResponse;
    } catch (error) {
      console.warn("[SlackAgent] Failed uploading file:", error);
      console.log("Full error details:", JSON.stringify(error, null, 2));
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
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
      console.warn("[SlackAgent] Failed adding zipper-mouth reaction:", error);
    }
    return {
      __pauseAgentUntilMentioned: true,
      __triggerLLMRequest: false,
    } satisfies MagicAgentInstructions;
  }
}
