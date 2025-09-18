import { Hono } from "hono";
import type { Variables } from "../../worker.ts";
import { type CloudflareEnv } from "../../../env.ts";
import type { SlackWebhookPayload } from "../../agent/slack.types.ts";
import { slackAPI } from "./client.ts";

export const slackApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

slackApp.post("/webhook", async (c) => {
  const body = (await c.req.json()) as SlackWebhookPayload;
  // Slack types say this doesn't exist but it was here in v1...
  // if (body.type === "url_verification") {
  //   return c.text(body.challenge);
  // }

  console.log("Slack webhook received:", body);

  if (body.event?.type === "message") {
    const threadTs = body.event.ts;
    await (
      await slackAPI()
    ).chat.postMessage({
      thread_ts: threadTs,
      channel: body.event.channel,
      text: "HELLO",
    });
  }

  // const agent = await getAgentStub({
  //   agentInstanceName: "slack-agent2",
  //   agentClassName: "SlackAgent",
  //   reason: "Slack webhook received",
  // });

  // await (agent as DurableObjectStub<SlackAgent>).onSlackWebhookEventReceived(body);
  // TODO: Add Slack we bhook verification and processing logic here

  return c.text("ok");
});

slackApp.post("/interactions", async (_c) => {
  // // Parse application/x-www-form-urlencoded body
  // const formData = await c.req.formData();
  // const payload = JSON.parse(formData.get("payload") as string);
  // // Generate unique interaction ID
  // const interactionId = `${payload.team?.id}-${payload.user?.id}-${Date.now()}`;
  // // Publish to event bus
  // await c.env.PLATFORM.publishEvent({
  //   event: `SLACK:INTERACTION_RECEIVED`,
  //   data: {
  //     payload,
  //     interactionId,
  //     timestamp: Date.now(),
  //   },
  //   source: {
  //     service: "platform",
  //     metadata: {
  //       interactionType: payload.type,
  //       teamId: payload.team?.id,
  //       userId: payload.user?.id,
  //       channelId: payload.channel?.id,
  //     },
  //   },
  // });
  // // Return appropriate acknowledgment based on interaction type
  // if (payload.type === "view_submission") {
  //   // For view_submission, we can include response_action in acknowledgment
  //   // For now, just acknowledge
  //   return c.json({});
  // }
  // // Default acknowledgment for other interaction types
  // return c.text("");
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
//     case "SLACK:INTERACTION_RECEIVED":
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
//     case "SLACK:INTERACTION_RECEIVED": {
//       const eventData = event.data as any;
//       const payload = eventData?.payload;

//       if (payload?.message?.thread_ts) {
//         slackAgentInstanceName = `SlackAgent ${payload.message.thread_ts}`;
//       } else if (payload?.container?.thread_ts) {
//         slackAgentInstanceName = `SlackAgent ${payload.container.thread_ts}`;
//       } else if (payload?.channel?.id && payload?.message?.ts) {
//         slackAgentInstanceName = `SlackAgent ${payload.message.ts}`;
//       } else if (payload?.type === "view_submission" && payload?.view?.private_metadata) {
//         try {
//           const metadata = JSON.parse(payload.view.private_metadata);
//           if (metadata.thread_ts) {
//             slackAgentInstanceName = `SlackAgent ${metadata.thread_ts}`;
//           }
//         } catch {
//           // Ignore parsing errors
//         }
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
//       case "SLACK:INTERACTION_RECEIVED":
//         console.log("Skipping interaction - no agent exists for this thread");
//         return;
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
//     case "SLACK:INTERACTION_RECEIVED":
//       await slackAgent.onSlackInteractionReceived(event.data as any);
//       break;
//   }
// }
