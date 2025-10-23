import { WebClient } from "@slack/web-api";
import { eq, and } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { env } from "../../env.ts";

export async function slackChannelOverrideExists(db: DB, estateId: string): Promise<boolean> {
  const override = await db.query.slackChannelEstateOverride.findFirst({
    where: eq(schema.slackChannelEstateOverride.estateId, estateId),
    columns: { id: true },
  });

  return !!override;
}

export async function getSlackChannelOverrideId(
  db: DB,
  estateId: string,
): Promise<string | undefined> {
  const override = await db.query.slackChannelEstateOverride.findFirst({
    where: eq(schema.slackChannelEstateOverride.estateId, estateId),
    columns: { slackChannelId: true },
  });

  return override?.slackChannelId || undefined;
}

/**
 * Generates a deterministic trial channel name from an estate ID
 * Uses the last 6 characters of the estate ID for a readable, unique code
 * Example: est_abc123xyz → iterate-23xyz (taking last 6 chars after the prefix)
 */
export function estateIdToChannelName(estateId: string): string {
  // Estate IDs are in format "est_XXXXXXXXXX" - take last 6 chars
  const code = estateId.slice(-6).toLowerCase();
  return `iterate-${code}`;
}

/**
 * Gets the estate ID for iterate's own Slack workspace
 */
export async function getIterateSlackEstateId(db: DB): Promise<string | undefined> {
  if (!env.SLACK_ITERATE_TEAM_ID) {
    return undefined;
  }
  const result = await db
    .select({
      estateId: schema.providerEstateMapping.internalEstateId,
    })
    .from(schema.providerEstateMapping)
    .where(
      and(
        eq(schema.providerEstateMapping.externalId, env.SLACK_ITERATE_TEAM_ID),
        eq(schema.providerEstateMapping.providerId, "slack-bot"),
      ),
    )
    .limit(1);

  return result[0]?.estateId || undefined;
}

function slackChannelNameFromEmail(email: string): string {
  let full = `iterate-${email}`.replace(/\.com$/, "").replace(/\W+/g, "-");
  full = full.replace(/^[-_]+/, "").replace(/[-_]+$/, ""); // remove leading and trailing hyphens and underscores
  return full.slice(0, 80 - 15); // subtract 15 from slack max channel name length so we can add `-${Date.now()}` if the channel name is taken
}

function assertOk<T extends { ok: boolean; error?: string; message?: string }>(
  result: T,
): T & { ok: true } {
  if (!result.ok) {
    throw new Error(`Slack API error: ${result.error}: ${result.message}`, { cause: result });
  }
  return result as T & { ok: true };
}

/**
 * Creates a trial Slack Connect channel and sets up routing
 *
 * This function:
 * 1. Creates a channel in iterate's Slack workspace (or finds existing one)
 * 2. Unarchives the channel if it was previously archived
 * 3. Ensures the bot is a member of the channel
 * 4. Sends a Slack Connect invite to the user's email
 * 5. Creates or updates routing override to route webhooks from that channel to the user's estate
 * 6. Links the channel to the user's estate
 *
 * Note: If the channel already exists and has a routing override (from a previous trial),
 * it will update the override to point to the new estate, making this operation idempotent.
 * If a channel with the same name exists but is archived, it will be unarchived and reused.
 *
 * @returns Success result with channel info, or error info if email is invalid
 */
export async function createTrialSlackConnectChannel(params: {
  db: DB;
  userEstateId: string;
  userEmail: string;
  userName: string;
  iterateTeamId: string;
  iterateBotToken: string;
}): Promise<{ channelId: string; channelName: string }> {
  const { db, userEstateId, userEmail, userName, iterateTeamId, iterateBotToken } = params;

  let channelName = slackChannelNameFromEmail(userEmail);
  const slackAPI = new WebClient(iterateBotToken);

  // removed the logic for reusing existing channels/overrides
  // if we want to put that kind of thing back in, we should move it to a different function. it was added in https://github.com/iterate/iterate/pull/361
  // without it, there's some risk of creating duplicate channels for the same user, if they click the button in two differrent tabs or something.
  // an outbox system, or just an advisory lock, could fix this.

  // 1. Create Slack channel in iterate's workspace (or find existing one)
  logger.info(`Creating trial channel: ${channelName}`);
  let channelResult = await slackAPI.conversations.create({
    name: channelName,
    is_private: false,
  });

  if (channelResult.error === "name_taken") {
    channelName = `${channelName}-${Date.now()}`;
    channelResult = await slackAPI.conversations.create({
      name: channelName,
      is_private: false,
    });
  }

  channelResult = assertOk(channelResult);

  if (!channelResult.channel?.id) {
    // This should never happen, but slack's types aren't great
    throw new Error("Failed to create Slack channel - no channel ID returned", {
      cause: channelResult,
    });
  }

  const channelId = channelResult.channel.id;
  logger.info(`Created Slack channel #${channelName} (${channelId})`);

  // 2. Ensure bot is a member of the channel
  logger.info(`Joining bot to channel ${channelId}`);
  const joinResult = await slackAPI.conversations.join({
    channel: channelId,
  });
  // If already in channel, that's fine - continue
  if (!joinResult.ok && joinResult.error !== "already_in_channel") {
    logger.warn(`Failed to join channel ${channelId}: ${joinResult.error}`);
    // Don't fail the whole operation - we can still try to send the invite
  }

  // 3. Send Slack Connect invite
  logger.info(`Sending Slack Connect invite to ${userEmail}`);
  assertOk(
    await slackAPI.conversations.inviteShared({
      channel: channelId,
      emails: [userEmail],
    }),
  );

  // Create new override - note that if this user has already created a channel, there will be two records. We look for the most recent one when mapping to an estate.
  logger.info(`Creating routing override: channel ${channelId} → estate ${userEstateId}`);
  await db.insert(schema.slackChannelEstateOverride).values({
    slackChannelId: channelId,
    slackTeamId: iterateTeamId,
    estateId: userEstateId,
    reason: `Trial via Slack Connect for ${userName} (${userEmail})`,
    metadata: {
      createdVia: "trial_signup",
      userEmail,
      userName,
      channelName,
      createdAt: new Date().toISOString(),
    },
  });

  logger.info(`Created channel for ${userEmail}: ${channelName}. Estate: ${userEstateId}`);

  await slackAPI.chat.postMessage({
    channel: channelId,
    text: `hi. @ me if you need anything.`,
  });
  const slackConnectDefaultInvitees = env.SLACK_CONNECT_DEFAULT_INVITEES?.split(",");
  if (slackConnectDefaultInvitees?.length) {
    await slackAPI.conversations.inviteShared({
      channel: channelId,
      emails: slackConnectDefaultInvitees,
    });
  }

  return {
    channelId,
    channelName,
  };
}
