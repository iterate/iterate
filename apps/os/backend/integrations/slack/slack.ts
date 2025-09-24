import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { WebClient, type UsersListResponse } from "@slack/web-api";
import { waitUntil } from "cloudflare:workers";
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
import { shouldIncludeEventInConversation } from "../../agent/slack-agent-utils.ts";

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

  waitUntil(
    // deterministically react to the webhook as early as possible (eyes emoji)
    getSlackAccessTokenForEstate(db, estateId).then(async (slackToken) => {
      if (slackToken) {
        await reactToSlackWebhook(body, new WebClient(slackToken), messageMetadata);
      }
    }),
  );

  waitUntil(
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

  // If the bot isn't mentioned or it's not a DM to the bot, we bail early

  if (!agentRoute) {
    const botUserId = extractBotUserIdFromAuthorizations(body);
    const isBotMentioned =
      botUserId && body.event.type === "message"
        ? isBotMentionedInMessage(body.event, botUserId)
        : false;
    const isDM = "channel_type" in body.event && body.event.channel_type === "im";
    if (!isBotMentioned && !isDM) {
      console.log("IGNORING WEBHOOK EVENT BECAUSE BOT IS NOT MENTIONED OR IT'S NOT A DM");
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

  waitUntil((agentStub as unknown as SlackAgent).onSlackWebhookEventReceived(body));

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

export async function saveSlackUserMapping(
  db: ReturnType<typeof getDb>,
  member: NonNullable<UsersListResponse["members"]>[number],
) {
  await db.transaction(async (tx) => {
    if (!member.id || !member.profile?.email || member.deleted) {
      return;
    }
    const existingMapping = await tx.query.providerUserMapping.findFirst({
      where: and(
        eq(schema.providerUserMapping.providerId, "slack-bot"),
        eq(schema.providerUserMapping.externalId, member.id),
      ),
    });

    if (existingMapping) {
      await tx
        .update(schema.user)
        .set({
          name: member.real_name || member.name || undefined,
          image: member.profile?.image_192,
        })
        .where(eq(schema.user.id, existingMapping.internalUserId));
      await tx
        .update(schema.providerUserMapping)
        .set({
          providerMetadata: member,
        })
        .where(eq(schema.providerUserMapping.id, existingMapping.id));
      return;
    }

    const existingUser = await tx.query.user.findFirst({
      where: eq(schema.user.email, member.profile.email),
    });

    if (existingUser) {
      await tx
        .update(schema.user)
        .set({
          name: member.real_name || member.name || "",
          image: member.profile?.image_192,
        })
        .where(eq(schema.user.id, existingUser.id));

      await tx.insert(schema.providerUserMapping).values({
        providerId: "slack-bot",
        internalUserId: existingUser.id,
        externalId: member.id,
        providerMetadata: member,
      });

      return;
    }
    const newUser = await tx
      .insert(schema.user)
      .values({
        name: member.real_name || member.name || "",
        email: member.profile.email,
        image: member.profile?.image_192,
        emailVerified: false,
      })
      .returning();

    await tx.insert(schema.providerUserMapping).values({
      providerId: "slack-bot",
      internalUserId: newUser[0].id,
      externalId: member.id,
      providerMetadata: member,
    });
  });
}

export async function syncSlackUsersInBackground(db: DB, botToken: string) {
  const authedWebClient = new WebClient(botToken);
  const userListResponse = await authedWebClient.users.list({});
  if (userListResponse.ok && userListResponse.members) {
    await Promise.allSettled(
      userListResponse.members.map(async (member) => {
        await saveSlackUserMapping(db, member);
      }),
    );
  }
}
