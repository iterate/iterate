import type { SlackEvent } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { and, asc, eq, or, inArray, lt } from "drizzle-orm";
import * as YAML from "yaml";
import pDebounce from "p-suite/p-debounce";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.mjs";
import { env as _env, waitUntil } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import { getSlackAccessTokenForEstate } from "../auth/token-utils.ts";
import * as schema from "../db/schema.ts";
import {
  slackWebhookEvent,
  providerUserMapping,
  estate,
  organizationUserMembership,
  organization,
  user,
} from "../db/schema.ts";
import { getFileContent, uploadFileFromURL } from "../file-handlers.ts";
import { ensureUserSynced } from "../integrations/slack/slack.ts";
import type { AgentCoreDeps, MergedEventForSlices } from "./agent-core.ts";
import type { DOToolDefinitions } from "./do-tools.ts";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import { CORE_AGENT_SLICES, IterateAgent } from "./iterate-agent.ts";
import { slackAgentTools } from "./slack-agent-tools.ts";
import { slackSlice, type SlackSliceState } from "./slack-slice.ts";
import { shouldUnfurlSlackMessage } from "./slack-agent-utils.ts";
import {
  ApprovalKey,
  type AgentCoreEvent,
  type CoreReducedState,
  type ParticipantJoinedEvent,
  type ParticipantMentionedEvent,
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
import { createSlackAPIMock } from "./slack-api-mock.ts";
import { getOrCreateAgentStubByName } from "./agents/stub-getters.ts";
import type { ContextRule } from "./context-schemas.ts";
// Inherit generic static helpers from IterateAgent

// memorySlice removed for now
const slackAgentSlices = [...CORE_AGENT_SLICES, slackSlice] as const;
export type SlackAgentSlices = typeof slackAgentSlices;

type ToolsInterface = typeof slackAgentTools.$infer.interface;
type Inputs = typeof slackAgentTools.$infer.inputTypes;
import type { AgentInitParams } from "./iterate-agent.ts";
import { getConnectionKey } from "./mcp/mcp-slice.ts";

export class SlackAgent extends IterateAgent<SlackAgentSlices> implements ToolsInterface {
  protected slackAPI!: WebClient;
  private slackStatusClearTimeout: ReturnType<typeof setTimeout> | null = null;

  // Track Slack message timestamps for MCP connection status buttons
  // Maps from serverId or connectionKey to message timestamp
  private mcpConnectionMessages = new Map<string, string>();

  protected get slackChannelId(): string {
    const { slackChannelId } = this.getReducedState() as SlackSliceState;
    if (typeof slackChannelId !== "string") {
      throw new Error("INTERNAL ERROR: slackChannelId is not a string; this should never happen.");
    }
    return slackChannelId;
  }

  protected get slackThreadId(): string {
    const { slackThreadId } = this.getReducedState() as SlackSliceState;
    if (typeof slackThreadId !== "string") {
      throw new Error("INTERNAL ERROR: slackThreadId is not a string; this should never happen.");
    }
    return slackThreadId;
  }

  // Sets both the "typing status" and "loading messages" fields on the slack thread
  // The typing status is the thing you know from human slack users.
  // You can set the "is typing..." bit in "@boris is typing..." that is shown
  // at the bottom of the screen.
  // The loading_messages are a new crazy bot thing that shows a shimmering bot avatar while
  // your bot is thinking and cycles through an array of string status that appear where the message will
  // later appear.
  private updateSlackThreadStatus = pDebounce((params: { status: string | null | undefined }) => {
    const { status } = params;
    try {
      void this.slackAPI.assistant.threads.setStatus({
        channel_id: this.slackChannelId,
        thread_ts: this.slackThreadId,

        // Not super elegant but here's the logic
        // - we want the old-school status indicator that human users get to not feel out of place
        //    - so we just alternate it between "is typing..." and "is thinking..."
        //    - emoji are out of place here as they `@iterate is ✏️ typing` doesn't look good
        // - the loading messages, on the other hand, are rendered like actual slack messages
        // - so "🎨 generating image..." is a perfectly fine update
        // - we think ... at the end looks good but don't want to write it a million times, so we
        //   append it here

        // Note that there is some funkiness where at the root of the thread the loading message
        // is actually shown inline with the username like a typing status indicator,
        // and there it doesn't look good to have an emoji. So we could edge case that, too.
        status: status
          ? status === "✏️ writing response"
            ? "is typing..."
            : "is thinking..."
          : "",

        // Slack's new status API cycles through provided strings (loading_messages) while the
        // status is visible. Notes:
        // - Newlines are not supported; emojis are fine
        // - Cycles IN ORDER, so you can do animations
        // - Max 10 elements; multiple spaces collapse; no markdown
        // - On some devices, emojis may not render identically
        // For clearing (status === null), omit loading_messages entirely.
        ...(status ? { loading_messages: [`${status}...`] } : {}),
      });

      if (this.slackStatusClearTimeout) {
        clearTimeout(this.slackStatusClearTimeout);
      }

      if (status) {
        const scheduleClear = () => {
          if (this.agentCore.llmRequestInProgress()) {
            this.slackStatusClearTimeout = setTimeout(scheduleClear, 300);
            return;
          }
          this.slackStatusClearTimeout = null;
          this.updateSlackThreadStatus({ status: undefined });
        };

        this.slackStatusClearTimeout = setTimeout(scheduleClear, 300);
      } else {
        this.slackStatusClearTimeout = null;
      }
    } catch (error) {
      // log error but don't crash DO
      logger.error("Failed to update Slack status:", error);
    }
  }, 100);

  // This gets run between the synchronous durable object constructor and the asynchronous onStart method of the agents SDK
  async initIterateAgent(params: AgentInitParams) {
    await super.initIterateAgent(params);

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

  protected async getContextRules(): Promise<ContextRule[]> {
    const rules = await super.getContextRules();

    // Check if estate has an onboarding agent configured
    if (this.estate.onboardingAgentName) {
      try {
        // Get a stub for the onboarding agent
        const onboardingAgentStub = await getOrCreateAgentStubByName("OnboardingAgent", {
          db: this.db,
          estateId: this.estate.id,
          agentInstanceName: this.estate.onboardingAgentName,
        });

        // Call onboardingPromptFragment on the stub
        const onboardingPrompt = await (onboardingAgentStub as any).onboardingPromptFragment();

        // Add the onboarding context as a context rule
        rules.push({
          key: "onboarding-context",
          prompt: onboardingPrompt,
        });
      } catch (error) {
        logger.warn(`Failed to get onboarding context for estate ${this.estate.id}:`, error);
      }
    }

    return rules;
  }

  protected getExtraDependencies(deps: AgentCoreDeps) {
    return {
      onLLMStreamResponseStreamingChunk: (chunk: ResponseStreamEvent) => {
        deps?.onLLMStreamResponseStreamingChunk?.(chunk);
        // console.log(chunk.type);
        switch (chunk.type) {
          case "response.output_item.added": {
            switch (chunk.item.type) {
              case "function_call": {
                const toolName = chunk.item.name;
                const tool = this.agentCore.state.runtimeTools.find(
                  (t) => t.type === "function" && t.name === toolName,
                );
                const statusText =
                  tool && tool.type === "function" && tool.statusIndicatorText
                    ? tool.statusIndicatorText
                    : `🛠️ ${toolName}...`;
                this.updateSlackThreadStatus({ status: statusText });
                break;
              }
              case "reasoning": {
                this.updateSlackThreadStatus({ status: "🧠 thinking" });
                break;
              }
            }
            break;
          }
        }
      },
      onEventAdded: (payload: {
        event: AgentCoreEvent;
        reducedState: CoreReducedState;
        getFinalRedirectUrl?: (payload: {
          durableObjectInstanceName: string;
        }) => Promise<string | undefined>;
      }) => {
        deps?.onEventAdded?.(payload);

        const event = payload.event as MergedEventForSlices<SlackAgentSlices>;
        switch (event.type) {
          case "CORE:LLM_REQUEST_START":
            this.updateSlackThreadStatus({ status: "🧠 thinking" });
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
          case "MCP:OAUTH_REQUIRED": {
            const { oauthUrl, connectionKey, serverUrl } = event.data;

            const hostname = new URL(serverUrl).hostname;

            waitUntil(
              this.slackAPI.chat
                .postMessage({
                  channel: this.agentCore.state.slackChannelId as string,
                  thread_ts: this.agentCore.state.slackThreadId as string,
                  text: `Authorize ${hostname}`,
                  blocks: [
                    {
                      type: "actions",
                      elements: [
                        {
                          type: "button",
                          text: {
                            type: "plain_text",
                            text: `Authorize ${hostname}`,
                          },
                          url: oauthUrl,
                          style: "primary",
                        },
                      ],
                    },
                  ],
                })
                .then((result) => {
                  if (result.ok && result.ts) {
                    this.mcpConnectionMessages.set(connectionKey, result.ts);
                  }
                }),
            );
            break;
          }
          case "MCP:PARAMS_REQUIRED": {
            const { paramsCollectionUrl, connectionKey, serverUrl } = event.data;

            const hostname = new URL(serverUrl).hostname;

            waitUntil(
              this.slackAPI.chat
                .postMessage({
                  channel: this.agentCore.state.slackChannelId as string,
                  thread_ts: this.agentCore.state.slackThreadId as string,
                  text: `Authorize ${hostname}`,
                  blocks: [
                    {
                      type: "actions",
                      elements: [
                        {
                          type: "button",
                          text: {
                            type: "plain_text",
                            text: `Authorize ${hostname}`,
                          },
                          url: paramsCollectionUrl,
                          style: "primary",
                        },
                      ],
                    },
                  ],
                })
                .then((result) => {
                  if (result.ok && result.ts) {
                    this.mcpConnectionMessages.set(connectionKey, result.ts);
                  }
                }),
            );
            break;
          }
          case "MCP:CONNECT_REQUEST": {
            const { serverUrl, mode, userId } = event.data;

            const connectionKey = getConnectionKey({ serverUrl, mode, userId });

            const messageTs = this.mcpConnectionMessages.get(connectionKey);
            if (messageTs) {
              waitUntil(
                this.slackAPI.chat.update({
                  channel: this.agentCore.state.slackChannelId as string,
                  ts: messageTs,
                  text: `🔄 Connecting to ${serverUrl}...`,
                  blocks: [
                    {
                      type: "section",
                      text: {
                        type: "mrkdwn",
                        text: `🔄 Connecting to ${serverUrl}...`,
                      },
                    },
                  ],
                }),
              );
            }
            break;
          }
          case "MCP:CONNECTION_ESTABLISHED": {
            const { connectionKey, serverUrl } = event.data;

            const messageTs = this.mcpConnectionMessages.get(connectionKey);

            if (messageTs) {
              waitUntil(
                this.slackAPI.chat
                  .update({
                    channel: this.agentCore.state.slackChannelId as string,
                    ts: messageTs,
                    text: `✅ Connected to ${serverUrl}`,
                    blocks: [
                      {
                        type: "section",
                        text: {
                          type: "mrkdwn",
                          text: `✅ Connected to ${serverUrl}`,
                        },
                      },
                    ],
                  })
                  .then(() => {
                    this.mcpConnectionMessages.delete(connectionKey);
                  }),
              );
            }
            break;
          }
          case "MCP:CONNECTION_ERROR": {
            const { connectionKey, error } = event.data;

            const messageTs = connectionKey && this.mcpConnectionMessages.get(connectionKey);

            if (messageTs) {
              waitUntil(
                this.slackAPI.chat
                  .update({
                    channel: this.agentCore.state.slackChannelId as string,
                    ts: messageTs,
                    text: `❌ Connection failed`,
                    blocks: [
                      {
                        type: "section",
                        text: {
                          type: "mrkdwn",
                          text: `❌ *Connection failed*\n${error}`,
                        },
                      },
                    ],
                  })
                  .then(() => {
                    this.mcpConnectionMessages.delete(connectionKey);
                  }),
              );
            }
            break;
          }
        }

        // if (event.type !== "CORE:LOG") {
        //   this.syncTypingIndicator();
        // }
      },
      getFinalRedirectUrl: async (_payload: { durableObjectInstanceName: string }) => {
        return await this.getSlackPermalink();
      },
      requestApprovalForToolCall: async (
        payload: Parameters<NonNullable<AgentCoreDeps["requestApprovalForToolCall"]>>[0],
      ) => {
        const prettyArgs = YAML.stringify(payload.args || {}, (key, value) => {
          if (key === "impersonateUserId") return undefined;
          return value;
        }).trim();

        let message = `Approval needed to call tool *${payload.toolName}*. Approve or reject with the buttons below.`;
        if (prettyArgs !== "{}") {
          message += `\n\nArguments:\n\n\`\`\`\n${prettyArgs}\`\`\``;
        }

        const result = await this.sendSlackMessage({ text: message });
        if (!result.ts) throw new Error("Failed to send approval request message");

        // add the options ahead of time to make it easy to react (not parallely pls, so they always show up in the right order)
        await this.addSlackReaction({ messageTs: result.ts!, name: "+1" });
        await this.addSlackReaction({ messageTs: result.ts!, name: "-1" });

        return ApprovalKey.parse(result.ts);
      },
      onToolCallApproved: async ({ data, replayToolCall }) => {
        const messageTs = data.approvalKey;
        const removeReactions = () =>
          Promise.all([
            this.removeSlackReaction({ messageTs, name: "+1" }),
            this.removeSlackReaction({ messageTs, name: "-1" }),
          ]);
        if (!data.approved) {
          await Promise.all([
            removeReactions(),
            this.addSlackReaction({ messageTs, name: "no_entry" }),
          ]);
        }

        await Promise.all([
          removeReactions(),
          this.addSlackReaction({ messageTs, name: "eyes" }),
          replayToolCall(),
        ])
          .then(() => this.addSlackReaction({ messageTs, name: "white_check_mark" }))
          .catch((e) =>
            this.addSlackReaction({ messageTs, name: "x" }).then(() => Promise.reject(e)),
          )
          .finally(() => this.removeSlackReaction({ messageTs, name: "eyes" }));
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
    } satisfies Partial<AgentCoreDeps> & Record<string, unknown>;
  }

  // Turn any files shared with the bot into iterate files that can be used by the LLM
  protected async convertSlackSharedFilesToIterateFileSharedEvents(
    slackEvent: SlackEvent,
    botUserId: string | undefined,
  ): Promise<AgentCoreEvent[]> {
    // Only process files from human messages (not bot's own messages)
    if (
      slackEvent?.type === "message" &&
      "user" in slackEvent &&
      slackEvent.user !== botUserId &&
      "files" in slackEvent &&
      slackEvent.files
    ) {
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
    return [];
  }

  /**
   * Fetches webhook payloads from a thread, optionally before a specific timestamp
   */
  protected async getWebhooksFromThread({
    threadTs,
    beforeTs,
  }: {
    threadTs: string;
    beforeTs?: string;
  }): Promise<SlackWebhookPayload[]> {
    const whereConditions = [
      or(eq(slackWebhookEvent.thread_ts, threadTs), eq(slackWebhookEvent.ts, threadTs)),
      eq(slackWebhookEvent.type, "message"),
    ];

    if (beforeTs) {
      whereConditions.push(lt(slackWebhookEvent.ts, beforeTs));
    }

    const previousMessages = await this.db
      .select()
      .from(slackWebhookEvent)
      .where(and(...whereConditions))
      .orderBy(asc(slackWebhookEvent.ts));

    type TextMessage = typeof slackWebhookEvent.$inferSelect & {
      data: { text: string; ts: string; user: string };
    };
    const filteredPreviousMessages = previousMessages.filter(
      (m): m is TextMessage => "text" in m.data && "ts" in m.data && "user" in m.data,
    );
    const dedupedPreviousMessages = Object.values(
      Object.fromEntries(filteredPreviousMessages.map((m) => [m.data.ts, m])),
    ).sort((a, b) => parseFloat(a.data.ts) - parseFloat(b.data.ts));

    return dedupedPreviousMessages.map((message) => {
      return {
        event: message.data as SlackEvent,
        team_id: "",
        authorizations: [],
      };
    });
  }

  /**
   * Extracts all events from a single webhook payload
   * Returns participant joined, participant mentioned, file shared, and webhook received events
   */
  protected async extractEventsFromWebhook(
    slackWebhookPayload: SlackWebhookPayload,
    botUserId: string | undefined,
    shouldTriggerLLM: boolean,
  ): Promise<MergedEventForSlices<SlackAgentSlices>[]> {
    const slackEvent = slackWebhookPayload.event!;
    const events: MergedEventForSlices<SlackAgentSlices>[] = [];

    const isBotMessage =
      botUserId &&
      (("user" in slackEvent && slackEvent.user === botUserId) || "bot_id" in slackEvent);
    const isFromOurBot = botUserId && "user" in slackEvent && slackEvent.user === botUserId;
    const isBotMessageThatShouldBeIgnored =
      isFromOurBot || (isBotMessage && !isBotMentionedInMessage(slackEvent, botUserId));

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
    ]);
    events.push(...eventsLists.flat());

    events.push({
      type: "SLACK:WEBHOOK_EVENT_RECEIVED",
      data: {
        payload: slackWebhookPayload as {},
        updateThreadIds: true,
      },
      triggerLLMRequest:
        shouldTriggerLLM && slackEvent.type === "message" && !isBotMessageThatShouldBeIgnored,
      idempotencyKey: slackWebhookEventToIdempotencyKey(slackWebhookPayload),
    });

    return events;
  }

  private async getUserInfo(slackUserId: string, botUserId: string | undefined) {
    if (slackUserId === botUserId) {
      return null;
    }
    const currentState = this.agentCore.state;

    const existingParticipant = Object.values(currentState.participants || {}).find(
      (participant) => participant.externalUserMapping?.slack?.externalUserId === slackUserId,
    );
    if (existingParticipant) {
      return {
        status: "existing-participant" as const,
        userId: existingParticipant.internalUserId,
        userEmail: existingParticipant.email,
        userName: existingParticipant.displayName,
        orgRole: existingParticipant.role,
      };
    }

    const estateId = this.databaseRecord.estateId;

    const result = await this.db
      .select({
        userId: user.id,
        userEmail: user.email,
        userName: user.name,
        orgRole: organizationUserMembership.role,
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
      return null;
    }

    return {
      status: "new-participant" as const,
      ...result[0],
    };
  }

  /**
   * Gets the Slack team ID to use for syncing users.
   * For regular estates, uses the estate's own provider mapping.
   * For trial estates, finds the team ID via the channel override.
   */
  private async getSyncingTeamId(estateId: string): Promise<string | null> {
    // First check if this is a trial estate
    const estate = await this.db.query.estate.findFirst({
      where: eq(schema.estate.id, estateId),
      columns: { slackTrialConnectChannelId: true },
    });

    if (estate?.slackTrialConnectChannelId) {
      // For trial estates, find the team ID via channel override
      logger.info(
        `[SlackAgent JIT] Estate ${estateId} is a trial estate with channel ${estate.slackTrialConnectChannelId}`,
      );

      const channelOverride = await this.db.query.slackChannelEstateOverride.findFirst({
        where: and(
          eq(schema.slackChannelEstateOverride.estateId, estateId),
          eq(schema.slackChannelEstateOverride.slackChannelId, estate.slackTrialConnectChannelId),
        ),
      });

      if (channelOverride) {
        logger.info(
          `[SlackAgent JIT] Found channel override with teamId=${channelOverride.slackTeamId}`,
        );
        return channelOverride.slackTeamId;
      }

      logger.warn(
        `[SlackAgent JIT] Trial estate ${estateId} has channel ${estate.slackTrialConnectChannelId} but no override found`,
      );
      return null;
    }

    // For regular estates, use the provider estate mapping
    const estateMapping = await this.db.query.providerEstateMapping.findFirst({
      where: and(
        eq(schema.providerEstateMapping.internalEstateId, estateId),
        eq(schema.providerEstateMapping.providerId, "slack-bot"),
      ),
    });

    return estateMapping?.externalId ?? null;
  }

  /**
   * Helper function to query Slack users from the database.
   *
   * With the unique constraint on (providerId, estateId, externalId),
   * each Slack user can have only one mapping per estate.
   *
   * Schema semantics:
   * - estateId: The estate that discovered this user (always set)
   * - externalUserTeamId: The user's home team, only set if external (Slack Connect)
   *   - null = user is from estate's own workspace (internal)
   *   - set = user is from different workspace (external)
   */
  private async querySlackUsersByExternalId(params: { slackUserIds: string[]; estateId: string }) {
    const { slackUserIds, estateId } = params;

    const results = await this.db
      .select({
        userId: user.id,
        userEmail: user.email,
        userName: user.name,
        orgRole: organizationUserMembership.role,
        slackUserId: providerUserMapping.externalId,
        slackTeamId: providerUserMapping.externalUserTeamId,
        mappingEstateId: providerUserMapping.estateId,
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
          eq(providerUserMapping.estateId, estateId),
          inArray(providerUserMapping.externalId, slackUserIds),
        ),
      );

    return results;
  }

  /**
   * Adds a participant to the conversation when they send a message.
   * This is crucial for MCP personal connections to work properly.
   */
  public async getParticipantJoinedEvents(
    slackUserId: string,
    botUserId?: string,
  ): Promise<ParticipantJoinedEvent[]> {
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

    let results = await this.querySlackUsersByExternalId({
      slackUserIds: [slackUserId],
      estateId,
    });

    // If no result, try just-in-time sync before giving up
    if (results.length === 0) {
      logger.info(
        `[SlackAgent JIT] User ${slackUserId} not found in database, attempting JIT sync for estate ${estateId}`,
      );

      // Get Slack token and team ID for this estate
      const slackToken = await getSlackAccessTokenForEstate(this.db, estateId);
      if (!slackToken) {
        logger.warn(`[SlackAgent JIT] No Slack token found for estate ${estateId}`);
        return [];
      }

      logger.info(`[SlackAgent JIT] Got Slack token for estate ${estateId}`);

      // Get team ID (handles both regular and trial estates)
      const syncingTeamId = await this.getSyncingTeamId(estateId);

      if (!syncingTeamId) {
        logger.warn(`[SlackAgent JIT] No syncing team ID found for estate ${estateId}`);
        return [];
      }

      logger.info(
        `[SlackAgent JIT] Found syncing team ID for ${estateId}: syncingTeamId=${syncingTeamId}`,
      );

      // Attempt JIT sync
      const syncSuccess = await ensureUserSynced({
        db: this.db,
        estateId,
        slackUserId,
        botToken: slackToken,
        syncingTeamId,
      });

      logger.info(`[SlackAgent JIT] Sync result for user ${slackUserId}: ${syncSuccess}`);

      if (syncSuccess) {
        // Query again after successful sync
        results = await this.querySlackUsersByExternalId({
          slackUserIds: [slackUserId],
          estateId,
        });
        logger.info(
          `[SlackAgent JIT] Query after sync returned ${results.length} results for user ${slackUserId}`,
        );
        if (results.length > 0) {
          logger.info(
            `[SlackAgent JIT] Successfully synced user ${slackUserId}: userId=${results[0].userId}, role=${results[0].orgRole}, slackTeamId=${results[0].slackTeamId}`,
          );
        }
      }

      // If still no results after JIT sync, user doesn't exist or couldn't be synced
      if (results.length === 0) {
        logger.warn(
          `[SlackAgent JIT] User ${slackUserId} could not be synced for estate ${estateId} (syncSuccess=${syncSuccess})`,
        );
        return [];
      }
    }

    const userInfo = results[0];

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
          role: userInfo.orgRole,
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
  ): Promise<ParticipantMentionedEvent[]> {
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

    const estateId = this.databaseRecord.estateId;

    // Query users from the database
    let userMappings = await this.querySlackUsersByExternalId({
      slackUserIds: newMentionedUserIds,
      estateId,
    });

    // If some mentioned users weren't found, try JIT sync for them
    const foundUserIds = new Set(userMappings.map((m) => m.slackUserId));
    const missingUserIds = newMentionedUserIds.filter((id) => !foundUserIds.has(id));

    if (missingUserIds.length > 0) {
      logger.info(
        `[SlackAgent JIT] ${missingUserIds.length} mentioned users not found in database: ${missingUserIds.join(", ")} - attempting JIT sync for estate ${estateId}`,
      );

      // Get Slack token and team ID for this estate
      const slackToken = await getSlackAccessTokenForEstate(this.db, estateId);
      if (!slackToken) {
        logger.warn(
          `[SlackAgent JIT] Cannot sync mentioned users - no Slack token for estate ${estateId}`,
        );
      } else {
        const syncingTeamId = await this.getSyncingTeamId(estateId);

        if (!syncingTeamId) {
          logger.warn(
            `[SlackAgent JIT] Cannot sync mentioned users - no syncing team ID for estate ${estateId}`,
          );
        } else {
          logger.info(
            `[SlackAgent JIT] Syncing mentioned users with syncingTeamId=${syncingTeamId}`,
          );

          // Try to sync each missing user
          const syncResults = await Promise.all(
            missingUserIds.map((slackUserId) =>
              ensureUserSynced({
                db: this.db,
                estateId,
                slackUserId,
                botToken: slackToken,
                syncingTeamId,
              }),
            ),
          );

          logger.info(
            `[SlackAgent JIT] Mentioned users sync results: ${syncResults.filter((r) => r).length}/${missingUserIds.length} succeeded`,
          );

          // Query again for all mentioned users after sync attempts
          userMappings = await this.querySlackUsersByExternalId({
            slackUserIds: newMentionedUserIds,
            estateId,
          });
          logger.info(
            `[SlackAgent JIT] After sync, found ${userMappings.length}/${newMentionedUserIds.length} mentioned users`,
          );
        }
      }
    }

    return userMappings.map((userMapping): ParticipantMentionedEvent => {
      return {
        type: "CORE:PARTICIPANT_MENTIONED",
        data: {
          internalUserId: userMapping.userId,
          email: userMapping.userEmail,
          displayName: userMapping.userName,
          role: userMapping.orgRole,
          externalUserMapping: {
            slack: {
              integrationSlug: "slack",
              externalUserId: userMapping.slackUserId,
              internalUserId: userMapping.userId,
              email: userMapping.userEmail,
              rawUserInfo: userMapping.providerMetadata as Record<string, unknown>,
            },
          },
        },
        triggerLLMRequest: false,
        metadata: {},
      };
    });
  }

  public async initSlack(channelId: string, threadTs: string) {
    const events: MergedEventForSlices<SlackAgentSlices>[] = [];

    // Query database for channel info to populate state
    let slackChannel: { name: string; isShared: boolean; isExtShared: boolean } | null = null;

    try {
      const channelMapping = await this.db.query.slackChannel.findFirst({
        where: and(
          eq(schema.slackChannel.estateId, this.databaseRecord.estateId),
          eq(schema.slackChannel.externalId, channelId),
        ),
        columns: {
          name: true,
          isShared: true,
          isExtShared: true,
        },
      });

      if (channelMapping) {
        slackChannel = {
          name: channelMapping.name,
          isShared: channelMapping.isShared,
          isExtShared: channelMapping.isExtShared,
        };
      }
    } catch (error) {
      logger.warn(`Failed to fetch channel info during initialization for ${channelId}:`, error);
    }

    events.push({
      type: "SLACK:UPDATE_SLICE_STATE",
      data: {
        slackChannelId: channelId,
        slackThreadId: threadTs,
        slackChannel,
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

    if (
      !messageMetadata ||
      !messageMetadata.channel ||
      !messageMetadata.threadTs ||
      !messageMetadata.ts
    ) {
      return;
    }
    const botUserId = extractBotUserIdFromAuthorizations(slackWebhookPayload);

    if (!botUserId) {
      return;
    }

    const currentState = this.agentCore.state;
    const isSlackInitialized = !!currentState.slackChannelId;
    const isThreadStarter = messageMetadata.ts === messageMetadata.threadTs;

    if (!isSlackInitialized) {
      const initEvents = await this.initSlack(messageMetadata.channel, messageMetadata.threadTs);
      this.addEvents(initEvents);
    }

    if (currentState.paused && slackEvent.type === "message" && "text" in slackEvent) {
      const messageText = slackEvent.text;
      if (messageText) {
        const mentionedUserIds = getMentionedExternalUserIds(messageText);
        if (mentionedUserIds.includes(botUserId)) {
          this.addEvents([
            {
              type: "CORE:RESUME_LLM_REQUESTS",
              triggerLLMRequest: false,
            },
          ]);
        }
      }
    }

    // If mid-thread join, process historical webhooks first
    if (!isSlackInitialized && !isThreadStarter) {
      const historicalWebhooks = await this.getWebhooksFromThread({
        threadTs: messageMetadata.threadTs,
        beforeTs: messageMetadata.ts,
      });
      for (const webhook of historicalWebhooks) {
        const events = await this.extractEventsFromWebhook(webhook, botUserId, false);
        this.addEvents(events);
      }
    }

    // Process current webhook
    const currentEvents = await this.extractEventsFromWebhook(slackWebhookPayload, botUserId, true);

    // Determine who authored the message and whether it mentions our bot
    const isBotMessage =
      botUserId &&
      (("user" in slackEvent && slackEvent.user === botUserId) || "bot_id" in slackEvent);
    const isFromOurBot = botUserId && "user" in slackEvent && slackEvent.user === botUserId;
    // We always ignore our own bot's messages
    // We ignore other bot messages unless they explicitly mention our bot - to avoid two bots getting in an infinite loop talking to each other
    const isBotMessageThatShouldBeIgnored =
      isFromOurBot || (isBotMessage && !isBotMentionedInMessage(slackEvent, botUserId));

    if (
      slackEvent.type === "reaction_added" &&
      !isBotMessageThatShouldBeIgnored &&
      slackEvent.item.ts in currentState.toolCallApprovals &&
      currentState.toolCallApprovals[slackEvent.item.ts as ApprovalKey]?.status === "pending" &&
      (slackEvent.reaction === "+1" || slackEvent.reaction === "-1")
    ) {
      const userInfo = await this.getUserInfo(slackEvent.user, botUserId);
      if (userInfo) {
        currentEvents.push({
          type: "CORE:TOOL_CALL_APPROVED",
          data: {
            approvalKey: ApprovalKey.parse(slackEvent.item.ts),
            approved: slackEvent.reaction === "+1",
            approvedBy: userInfo,
          },
        });
      }
    }

    this.addEvents(currentEvents);

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

    const magic: MagicAgentInstructions = input.endTurn ? { __triggerLLMRequest: false } : {};

    // don't include full slack API response to conserve tokens in the success case. need some properties though so the LLM knows the message was sent
    return { ok: true, ts: result.ts, ...magic };
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
