import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getAgentByName } from "agents";
import type { Variables } from "../../worker.ts";
import { env, type CloudflareEnv } from "../../../env.ts";
import type { SlackWebhookPayload } from "../../agent/slack.types.ts";
import { getDb, type DB } from "../../db/client.ts";
import { agentInstance, agentInstanceRoute } from "../../db/schema.ts";
import { SlackAgent } from "../../worker.ts";
import {
  extractBotUserIdFromAuthorizations,
  isBotMentionedInMessage,
} from "../../agent/slack-agent-utils.ts";

export const slackApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

async function slackTeamIdToEstateId({ db, teamId }: { db: DB; teamId: string }) {
  console.log("slackTeamIdToEstateId", teamId);
  // TODO implement properl
  const estateId = await db.query.estate.findFirst();
  return estateId?.id;
}

slackApp.post("/webhook", async (c) => {
  const db = getDb();
  // TODO we need to verify the webhook signature - once we've done that, I think we can do the type assertion safely
  const body = (await c.req.json()) as SlackWebhookPayload;
  // Slack types say this doesn't exist but it was here in v1...
  // if (body.type === "url_verification") {
  //   return c.text(body.challenge);
  // }

  // First we get a slack team ID
  if (!body.team_id || !body.event) {
    console.warn("Slack webhook received without a team ID", body);
    return c.text("ok");
  }

  const estateId = await slackTeamIdToEstateId({ db, teamId: body.team_id });
  if (!estateId) {
    console.warn(
      `Slack webhook received for team ${body.team_id} that doesn't map to a known estate`,
      body,
    );
    return c.text("ok");
  }

  // This will throw an error if we didn't gracefully bow out
  const routingKey = getRoutingKey({
    payload: body,
    estateId: estateId,
  });

  const durableObjectName = `SlackAgent-${routingKey}`;
  const durableObjectId = env.SLACK_AGENT.idFromName(durableObjectName);

  // look up in the database to get all the agents by routing key
  const [agentRoute, ...rest] = await db.query.agentInstanceRoute.findMany({
    where: eq(agentInstanceRoute.routingKey, routingKey),
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

  // @ts-expect-error - TODO couldn't get types to line up
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

function getRoutingKey({ payload, estateId }: { payload: SlackWebhookPayload; estateId: string }) {
  if (!payload.event || !payload.team_id) {
    throw new Error("No event or team_id found in slack webhook payload");
  }

  // routing keys contain the estate ID - so if a slack team is first connected to estate A, and then later B,
  // then estate B should not get access to the data from estate A
  const prefix = `slack-${estateId}-team-${payload.team_id}`;

  if (payload.event.type === "message") {
    return `${prefix}-ts-${"thread_ts" in payload.event ? payload.event.thread_ts : payload.event.ts}`;
  }

  if (payload.event.type === "reaction_added" || payload.event.type === "reaction_removed") {
    throw new Error("reaction_added and reaction_removed not implemented");
    // return await serverTrpc.platform.integrations.slack.getThreadTsForMessage.query({
    //   messageTs: slackEvent.item.ts,
    // });
  }

  console.warn(
    "Didn't know how to turn this slack webhook payload into a routing key and durable object name",
    payload,
  );
  throw new Error(
    "Didn't know how to turn this slack webhook payload into a routing key and durable object name",
  );
}
