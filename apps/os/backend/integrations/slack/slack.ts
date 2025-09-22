import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import { type CloudflareEnv } from "../../../env.ts";
import type { SlackWebhookPayload } from "../../agent/slack.types.ts";
import { getDb, type DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";

import { SlackAgent } from "../../agent/slack-agent.ts";
import {
  extractBotUserIdFromAuthorizations,
  extractUserId,
  getMessageMetadata,
  isBotMentionedInMessage,
} from "../../agent/slack-agent-utils.ts";
import { slackWebhookEvent } from "../../db/schema.ts";
import { getSlackAccessTokenForEstate } from "../../auth/token-utils.ts";

export const slackApp = new Hono<{ Bindings: CloudflareEnv }>();

async function slackTeamIdToEstateId({ db, teamId }: { db: DB; teamId: string }) {
  const result = await db
    .select({
      estateId: schema.providerEstateMapping.internalEstateId,
    })
    .from(schema.providerEstateMapping)
    .where(
      and(
        eq(schema.providerEstateMapping.externalId, teamId),
        eq(schema.providerEstateMapping.providerId, "slack-bot"),
      ),
    )
    .limit(1);

  return result[0]?.estateId ?? null;
}

slackApp.post("/webhook", async (c) => {
  const db = getDb();
  // TODO we need to verify the webhook signature - once we've done that, I think we can do the type assertion safely
  const body = (await c.req.json()) as SlackWebhookPayload;
  // Slack types say this doesn't exist but it was here in v1...
  if ("type" in body && body.type === "url_verification" && "challenge" in body) {
    return c.text(body.challenge as string);
  }

  // First we get a slack team ID
  if (!body.team_id || !body.event) {
    console.warn("Slack webhook received without a team ID", body);
    return c.text("ok");
  }

  const [estateId, messageMetadata] = await Promise.all([
    slackTeamIdToEstateId({ db, teamId: body.team_id }),
    getMessageMetadata(body.event, db),
  ]);

  if (!estateId) {
    console.warn(
      `Slack webhook received for team ${body.team_id} that doesn't map to a known estate`,
      body,
    );
    return c.text("ok");
  }

  c.executionCtx.waitUntil(
    // deterministically react to the webhook as early as possible (eyes emoji)
    getSlackAccessTokenForEstate(db, estateId).then(async (slackToken) => {
      if (slackToken) {
        await reactToSlackWebhook(body, new WebClient(slackToken), messageMetadata);
      }
    }),
  );

  c.executionCtx.waitUntil(
    db
      .insert(slackWebhookEvent)
      .values({
        data: body.event,
        ts: messageMetadata.ts,
        thread_ts: messageMetadata.threadTs,
        type: "type" in body.event ? body.event.type : null,
        subtype: "subtype" in body.event ? body.event.subtype : null,
        user: extractUserId(body.event),
        channel: messageMetadata.channel,
        estateId: estateId,
      })
      .returning(),
  );

  if (!messageMetadata.threadTs) {
    return c.text("ok");
  }

  const routingKey = await getRoutingKey({
    payload: body,
    estateId: estateId,
    threadTs: messageMetadata.threadTs,
  });

  const durableObjectName = `SlackAgent-${routingKey}`;

  // look up in the database to get all the agents by routing key
  const [agentRoute, ...rest] = await db.query.agentInstanceRoute.findMany({
    where: eq(schema.agentInstanceRoute.routingKey, routingKey),
    with: {
      agentInstance: true,
    },
  });

  if (rest.length > 0) {
    console.error(`Multiple agents found for routing key ${routingKey}`);
    return c.text("ok");
  }

  if (!agentRoute) {
    const botUserId = extractBotUserIdFromAuthorizations(body);
    const isBotMentioned =
      botUserId && body.event.type === "message"
        ? isBotMentionedInMessage(body.event, botUserId)
        : false;
    const isDM = "channel_type" in body.event && body.event.channel_type === "im";

    if (!isBotMentioned && !isDM) {
      return c.text("ok");
    }
  }

  const agentStub = await SlackAgent.getOrCreateStubByRoute({
    db,
    estateId,
    agentInstanceName: durableObjectName,
    route: routingKey,
    reason: "Slack webhook received",
  });

  c.executionCtx.waitUntil((agentStub as unknown as SlackAgent).onSlackWebhookEventReceived(body));

  return c.text("ok");
});

// async onEventPublished(event: DispatchedEvent) {
//   switch (event.event) {
//     case "SYSTEM:APP_INSTALLED": {
//       // Find the general channel
//       const channelsResult = await serverTrpc.platform.integrations.slack.listChannels.query({
//         types: "public_channel",
//         exclude_archived: true,
//       });

//       if (!channelsResult.success || !channelsResult.channels) {
//         console.error("[Platform] Could not list channels for app_installed event");
//         return;
//       }

//       const generalChannel = channelsResult.channels.find((channel) => channel.is_general);
//       const targetChannel = generalChannel || channelsResult.channels[0];

//       if (!targetChannel) {
//         console.error("[Platform] Could not find any suitable channel for app_installed event");
//         return;
//       }

//       if (!generalChannel) {
//         console.warn(
//           `[Platform] #general channel not found, using fallback channel: ${targetChannel.name}`,
//         );
//       }

//       const { threadTs } =
//         await serverTrpc.platform.integrations.slack.startThreadWithAgent.mutate({
//           channel: targetChannel.id,
//           blocks: INITIAL_ONBOARDING_BLOCKS,

//           eventsToAdd: [
//             {
//               type: "CORE:LLM_INPUT_ITEM",
//               data: {
//                 type: "message",
//                 role: "developer",
//                 content: [
//                   {
//                     type: "input_text",
//                     text: ONBOARDING_PROMPT,
//                   },
//                 ],
//               },
//               triggerLLMRequest: false,
//             },
//           ],
//         });

//       if (!threadTs) {
//         console.error("[Platform] Could not start thread for app_installed event");
//         return;
//       }

//       await serverTrpc.platform.integrations.slack.sendSlackMessage.mutate({
//         channel: targetChannel.id,
//         threadTs,
//         text: "should not be here",
//         blocks: SECONDARY_ONBOARDING_BLOCKS,
//       });

//       const slackAgent = await getPersistedAgentByName(
//         this.env.SLACK_AGENT,
//         `SlackAgent ${threadTs}`,
//         "SlackAgent",
//         {
//           db,
//           table: durableObjectInstances,
//           reason: "App installed",
//         },
//       );

//       await slackAgent.storeModalDefinitions(MODAL_DEFINITIONS);

//       return;
//     }
//   }

//   switch (event.event) {
//     case "SLACK:WEBHOOK_EVENT_RECEIVED":
//       break;
//     default:
//       return;
//   }

//   let slackAgentInstanceName: string | null = null;
//   switch (event.event) {
//     case "SLACK:WEBHOOK_EVENT_RECEIVED": {
//       const eventData = event.data as any;
//       const slackEvent = eventData?.event as SlackEvent;
//       if (slackEvent.type === "assistant_thread_started") {
//         const channelId = slackEvent.assistant_thread.channel_id;
//         const threadTs = slackEvent.assistant_thread.thread_ts;
//         await serverTrpc.platform.integrations.slack.setSuggestedPrompts.mutate({
//           channel_id: channelId,
//           thread_ts: threadTs,
//           prompts: getRandomPromptSet().prompts,
//         });
//       }

//       // Handle channel_joined events - check recent messages for bot mentions
//       if (
//         slackEvent.type === "message" &&
//         "subtype" in slackEvent &&
//         slackEvent.subtype === "channel_join"
//       ) {
//         const channelId = slackEvent.channel;
//         const botUserId = extractBotUserIdFromAuthorizations(eventData);

//         if (botUserId && channelId) {
//           await handleChannelJoinedEvent({ channelId, botUserId });
//         }
//       }
//       await storeSlackWebhookEvent({ slackEvent });
//       slackAgentInstanceName = await getAgentInstanceNamesForSlackWebhook(slackEvent);
//       if (slackEvent.type === "app_home_opened") {
//         await handleAppHomeOpened(slackEvent.user);
//       }
//       break;
//     }
//   }

//   if (!slackAgentInstanceName) {
//     return;
//   }

//   const agentExists = await checkPersistedAgentWithNameExists(
//     slackAgentInstanceName,
//     "SlackAgent",
//     {
//       db,
//       table: durableObjectInstances,
//     },
//   );

//   if (!agentExists) {
//     switch (event.event) {
//       case "SLACK:WEBHOOK_EVENT_RECEIVED": {
//         const eventData = event.data as any;
//         const slackEvent = eventData?.event as SlackEvent;
//         const botUserId = extractBotUserIdFromAuthorizations(eventData);
//         const isBotMentioned =
//           botUserId && slackEvent.type === "message"
//             ? isBotMentionedInMessage(slackEvent, botUserId)
//             : false;
//         const isDM = "channel_type" in slackEvent && slackEvent.channel_type === "im";

//         if (!isBotMentioned && !isDM) {
//           return;
//         }
//         break;
//       }
//     }
//   }

//   const slackAgent = await getPersistedAgentByName(
//     this.env.SLACK_AGENT,
//     slackAgentInstanceName,
//     "SlackAgent",
//     {
//       db,
//       table: durableObjectInstances,
//       reason: `Event ${event.event} received`,
//     },
//   );

//   // inject new braintrust span
//   /*
//   if (!agentExists) {
//     const prefix = env.STAGE__PR_ID
//       ? `pr-${env.STAGE__PR_ID}`
//       : env.ITERATE_USER
//         ? `local-${env.ITERATE_USER}`
//         : `estate-${ESTATE_MANIFEST.estateName}`;
//     const braintrustLogger = getBraintrustLogger({
//       braintrustKey: this.env.BRAINTRUST_API_KEY ?? "",
//       projectName: `${prefix}-platform`
//     });
//     const parentSpan = braintrustLogger.startSpan({
//       name: slackAgentInstanceName,
//       type: "task",
//       startTime: Date.now() / 1000
//     });
//     parentSpan.end();
//     await parentSpan.flush();
//     const exportedId = await parentSpan.export();
//     await slackAgent.setBraintrustParentSpanExportedId(exportedId);
//   }
//     */

//   switch (event.event) {
//     case "SLACK:WEBHOOK_EVENT_RECEIVED":
//       await slackAgent.onSlackWebhookEventReceived(event.data as any);
//       break;
//   }
// }

async function getRoutingKey({
  payload,
  estateId,
  threadTs,
}: {
  payload: SlackWebhookPayload;
  estateId: string;
  threadTs: string;
}) {
  if (!payload.event || !payload.team_id) {
    throw new Error("No event or team_id found in slack webhook payload");
  }
  const suffix = `slack-${estateId}-team-${payload.team_id}`;
  return `ts-${threadTs}-${suffix}`;
}

export async function reactToSlackWebhook(
  slackWebhookPayload: SlackWebhookPayload,
  slackAPI: WebClient,
  messageMetadata: { channel?: string; ts?: string },
) {
  const botUserId = extractBotUserIdFromAuthorizations(slackWebhookPayload);

  if (!botUserId || !slackWebhookPayload.event) {
    return;
  }

  const shouldInclude = shouldIncludeEventInConversation(slackWebhookPayload.event, botUserId);

  if (shouldInclude && slackWebhookPayload.event.type === "message") {
    if (messageMetadata.channel && messageMetadata.ts) {
      const isMentioned = isBotMentionedInMessage(slackWebhookPayload.event, botUserId);

      if (isMentioned) {
        await slackAPI.reactions
          .add({
            channel: messageMetadata.channel,
            timestamp: messageMetadata.ts,
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

export function shouldIncludeEventInConversation(
  slackEvent: SlackWebhookPayload["event"] | undefined,
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
      const unhandledEvent: SlackWebhookPayload["event"] = slackEvent;
      console.warn(`Unhandled Slack event type: ${unhandledEvent.type}`);

      // For now, ignore any unhandled event types
      // When new event types are added to @slack/types, they'll appear here
      // and we can decide whether to include them in conversations
      return false;
    }
  }
}
