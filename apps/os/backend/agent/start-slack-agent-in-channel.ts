import { eq, and } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import type { DB } from "../db/client.ts";
import { slackChannel } from "../db/schema.ts";
import { getSlackAccessTokenForEstate } from "../auth/token-utils.ts";
import { getRoutingKey } from "../integrations/slack/slack.ts";
import { getOrCreateAgentStubByRoute } from "./agents/stub-getters.ts";
import { SlackAgent } from "./slack-agent.ts";

/**
 * Starts a Slack agent in a Slack channel by posting an initial message and creating the agent.
 *
 * This function handles the chicken-and-egg problem of creating a Slack agent: we need to post
 * a message to Slack first to get the thread timestamp, which is required to create the routing key
 * for the agent. This means it is not possible to send an LLM-generated or agent-generated
 * `firstMessage` to Slack because we need the thread timestamp from posting the `firstMessage`
 * in order to even create our agent.
 *
 * @param db - Database connection
 * @param estateId - Estate ID
 * @param slackChannelIdOrName - Slack channel ID or name (will be looked up in database first)
 * @param firstMessage - Initial message to post in the thread
 * @param additionalEvents - Optional additional events to send to the agent after initialization
 * @returns Object with success status, thread timestamp, and channel ID
 */
export async function startSlackAgentInChannel(params: {
  db: DB;
  estateId: string;
  slackChannelIdOrName: string;
  firstMessage?: string;
  additionalEvents?: Array<any>;
}): Promise<{
  success: boolean;
  threadTs: string;
  channel: string;
}> {
  const { db, estateId, slackChannelIdOrName, firstMessage, additionalEvents } = params;

  const accessToken = await getSlackAccessTokenForEstate(db, estateId);
  if (!accessToken) {
    throw new Error("No Slack integration found for this estate");
  }

  const slackAPI = new WebClient(accessToken);

  // Look up the Slack channel ID in the database first by name
  let channelId = slackChannelIdOrName;
  const channelRecord = await db.query.slackChannel.findFirst({
    where: and(eq(slackChannel.estateId, estateId), eq(slackChannel.name, slackChannelIdOrName)),
  });

  if (channelRecord) {
    channelId = channelRecord.externalId;
  } else if (!slackChannelIdOrName.startsWith("C") && !slackChannelIdOrName.startsWith("D")) {
    // If not found in DB and doesn't look like a channel ID, search via Slack API
    // This handles cases where the channel exists but hasn't been synced to our DB yet
    try {
      const channelsResponse = await slackAPI.conversations.list({
        types: "public_channel,private_channel",
        limit: 1000, // Slack's max
      });

      if (channelsResponse.ok && channelsResponse.channels) {
        const matchingChannel = channelsResponse.channels.find(
          (ch: any) => ch.name === slackChannelIdOrName,
        );
        if (matchingChannel && matchingChannel.id) {
          channelId = matchingChannel.id;
        }
      }
    } catch (_error) {
      // If Slack API lookup fails, fall back to assuming it's a channel ID
      // The subsequent postMessage will fail if it's invalid
    }
  }
  // If not found by name or API lookup, assume slackChannelIdOrName is already the channel ID

  let chatResult;
  try {
    chatResult = await slackAPI.chat.postMessage({
      channel: channelId,
      text: firstMessage || "",
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to post message to Slack channel "${channelId}" (original: "${slackChannelIdOrName}"): ${errorMsg}`,
    );
  }

  if (!chatResult.ok || !chatResult.ts) {
    throw new Error(
      `Slack API returned error when posting to channel "${channelId}" (original: "${slackChannelIdOrName}"): ${chatResult.error || "Unknown error"}`,
    );
  }

  const routingKey = getRoutingKey({
    estateId: estateId,
    threadTs: chatResult.ts,
  });

  const slackAgent = (await getOrCreateAgentStubByRoute("SlackAgent", {
    db: db,
    estateId: estateId,
    route: routingKey,
    reason: "Start thread with agent",
  })) as unknown as SlackAgent;

  const events = await slackAgent.initSlack(channelId, chatResult.ts);
  await slackAgent.addEvents(events);

  // Add any additional events if provided
  if (additionalEvents && additionalEvents.length > 0) {
    await slackAgent.addEvents(additionalEvents);
  }

  return {
    success: true,
    threadTs: chatResult.ts,
    channel: channelId,
  };
}
