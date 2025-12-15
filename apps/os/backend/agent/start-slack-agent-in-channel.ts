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
 * @param installationId - Estate ID
 * @param slackChannelIdOrName - Slack channel ID or name (will be looked up in database first)
 * @param firstMessage - Initial message to post in the thread
 * @param additionalEvents - Optional additional events to send to the agent after initialization
 * @returns Object with success status, thread timestamp, and channel ID
 */
export async function startSlackAgentInChannel(params: {
  db: DB;
  installationId: string;
  slackChannelIdOrName: string;
  firstMessage?: string;
  additionalEvents?: Array<any>;
}): Promise<{
  success: boolean;
  threadTs: string;
  channel: string;
}> {
  const { db, installationId, slackChannelIdOrName, firstMessage, additionalEvents } = params;

  // Look up the Slack channel ID in the database first by name, then fall back to treating as ID
  let channelId = slackChannelIdOrName;
  const channelRecord = await db.query.slackChannel.findFirst({
    where: and(eq(slackChannel.installationId, installationId), eq(slackChannel.name, slackChannelIdOrName)),
  });

  if (channelRecord) {
    channelId = channelRecord.externalId;
  }
  // If not found by name, assume slackChannelIdOrName is already the channel ID

  const slackAccount = await getSlackAccessTokenForEstate(db, installationId);
  if (!slackAccount) {
    throw new Error("No Slack integration found for this estate");
  }

  const slackAPI = new WebClient(slackAccount.accessToken);

  const chatResult = await slackAPI.chat.postMessage({
    channel: channelId,
    text: firstMessage || "",
  });

  if (!chatResult.ok || !chatResult.ts) {
    throw new Error("Failed to post message to Slack");
  }

  const routingKey = getRoutingKey({
    installationId: installationId,
    threadTs: chatResult.ts,
  });

  const slackAgent = (await getOrCreateAgentStubByRoute("SlackAgent", {
    db: db,
    installationId: installationId,
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
