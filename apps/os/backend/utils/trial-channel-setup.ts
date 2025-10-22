import { env } from "process";
import { WebClient } from "@slack/web-api";
import { eq, and } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";

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
}): Promise<
  | { success: true; channelId: string; channelName: string }
  | { success: false; error: "invalid_email" | "channel_exists" | "api_error"; message: string }
> {
  const { db, userEstateId, userEmail, userName, iterateTeamId, iterateBotToken } = params;

  const channelName = estateIdToChannelName(userEstateId);
  const slackAPI = new WebClient(iterateBotToken);

  try {
    const existingOverride = await db.query.slackChannelEstateOverride.findFirst({
      where: and(
        eq(schema.slackChannelEstateOverride.slackTeamId, iterateTeamId),
        eq(schema.slackChannelEstateOverride.estateId, userEstateId),
      ),
    });

    if (existingOverride) {
      logger.info(
        `Trial channel already exists for estate ${userEstateId}, reusing channel ${existingOverride.slackChannelId}`,
      );

      const channelId = existingOverride.slackChannelId;

      // Check if channel is archived and unarchive if needed
      const channelInfo = await slackAPI.conversations.info({
        channel: channelId,
      });

      if (channelInfo.ok && channelInfo.channel?.is_archived) {
        logger.info(`Channel ${channelId} is archived, attempting to unarchive...`);
        const unarchiveResult = await slackAPI.conversations.unarchive({
          channel: channelId,
        });

        if (!unarchiveResult.ok) {
          const errorCode = unarchiveResult.error;
          logger.error(`Failed to unarchive channel ${channelId}: ${errorCode}`);

          // If bot can't unarchive (not in channel or lacks permissions), return a clear error
          if (errorCode === "not_in_channel" || errorCode === "cant_unarchive_channel") {
            return {
              success: false,
              error: "channel_exists",
              message: `Your trial channel (#${channelName}) is archived. Please ask a Slack workspace admin to unarchive the channel, or contact support for assistance.`,
            };
          }
          // Other unarchive errors should fail the operation
          return {
            success: false,
            error: "api_error",
            message: `Failed to unarchive channel: ${errorCode}`,
          };
        }
        logger.info(`Successfully unarchived channel ${channelId}`);
      }

      // Ensure bot is a member of the channel
      logger.info(`Joining bot to existing channel ${channelId}`);
      const joinResult = await slackAPI.conversations.join({
        channel: channelId,
      });
      if (!joinResult.ok && joinResult.error !== "already_in_channel") {
        logger.warn(`Failed to join channel ${channelId}: ${joinResult.error}`);
      }

      // Resend Slack Connect invite (in case user needs it)
      logger.info(`Sending Slack Connect invite to ${userEmail}`);
      const inviteResult = await slackAPI.conversations.inviteShared({
        channel: channelId,
        external_limited: false,
        emails: [userEmail],
      });
      if (!inviteResult.ok && inviteResult.error === "invalid_email") {
        logger.warn(`Email ${userEmail} not found in Slack`);
        return {
          success: false,
          error: "invalid_email",
          message: `The email ${userEmail} is not associated with any Slack account. Please provide your Slack email address.`,
        };
      }

      logger.info(
        `Successfully reused existing trial channel for ${userEmail}: ${channelName} → estate ${userEstateId}`,
      );

      return {
        success: true,
        channelId,
        channelName,
      };
    }

    // 1. Create Slack channel in iterate's workspace (or find existing one)
    let channelWasCreated = false;

    logger.info(`Creating trial channel: ${channelName}`);
    const channelResult = await slackAPI.conversations.create({
      name: channelName,
      is_private: false,
    });

    if (!channelResult.ok) {
      // If channel name is already taken, this shouldn't happen with estate-based naming
      // since the database check above should have found the override.
      // This could only happen if:
      // 1. The channel exists but isn't in our database (orphaned channel)
      // 2. There's a race condition (very unlikely)
      if (channelResult.error === "name_taken") {
        logger.error(
          `Channel ${channelName} (for estate ${userEstateId}) already exists but no override found in database. This indicates orphaned data.`,
        );
        return {
          success: false,
          error: "channel_exists",
          message: `A trial channel for your account already exists. Please contact support for assistance.`,
        };
      }

      logger.error("Failed to create Slack channel", channelResult);
      return {
        success: false,
        error: "api_error",
        message: `Failed to create Slack channel: ${channelResult.error}`,
      };
    }

    if (!channelResult.channel?.id) {
      logger.error("Failed to create Slack channel - no channel ID returned", channelResult);
      return {
        success: false,
        error: "api_error",
        message: "Failed to create Slack channel",
      };
    }

    const channelId = channelResult.channel.id;
    channelWasCreated = true;
    logger.info(`Created Slack channel ${channelName} (${channelId})`);

    // 2. Ensure bot is a member of the channel
    logger.info(`Joining bot to channel ${channelId}`);
    const joinResult2 = await slackAPI.conversations.join({
      channel: channelId,
    });
    // If already in channel, that's fine - continue
    if (!joinResult2.ok && joinResult2.error !== "already_in_channel") {
      logger.warn(`Failed to join channel ${channelId}: ${joinResult2.error}`);
      // Don't fail the whole operation - we can still try to send the invite
    }

    // 3. Send Slack Connect invite
    logger.info(`Sending Slack Connect invite to ${userEmail}`);
    const inviteResult2 = await slackAPI.conversations.inviteShared({
      channel: channelId,
      emails: [userEmail],
    });

    if (!inviteResult2.ok) {
      // Check if it's an invalid email error
      if (inviteResult2.error === "invalid_email" || inviteResult2.error === "user_not_found") {
        logger.warn(`Email ${userEmail} not found in Slack, will need alternate email`);
        return {
          success: false,
          error: "invalid_email",
          message: `The email ${userEmail} is not associated with any Slack account. Please provide your Slack email address.`,
        };
      }

      logger.error("Failed to send Slack Connect invite", inviteResult2);
      // Continue anyway - admin can manually invite later
    }

    // 4. Create or update routing override
    // Check if this channel already has an override (from a previous trial attempt)
    const existingChannelOverride = await db.query.slackChannelEstateOverride.findFirst({
      where: and(
        eq(schema.slackChannelEstateOverride.slackChannelId, channelId),
        eq(schema.slackChannelEstateOverride.slackTeamId, iterateTeamId),
      ),
    });

    if (existingChannelOverride) {
      // Update the existing override to point to the new estate
      logger.info(
        `Updating existing routing override: channel ${channelId} (was estate ${existingChannelOverride.estateId}) → estate ${userEstateId}`,
      );
      await db
        .update(schema.slackChannelEstateOverride)
        .set({
          estateId: userEstateId,
          reason: `Trial via Slack Connect for ${userName} (${userEmail})`,
          metadata: {
            createdVia: "trial_signup",
            userEmail,
            userName,
            channelName,
            createdAt: new Date().toISOString(),
            previousEstateId: existingChannelOverride.estateId,
            updatedAt: new Date().toISOString(),
          },
        })
        .where(eq(schema.slackChannelEstateOverride.id, existingChannelOverride.id));
    } else {
      // Create new override
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
    }

    logger.info(
      `Successfully ${channelWasCreated ? "created" : "reused existing"} trial channel for ${userEmail}: ${channelName} → estate ${userEstateId}`,
    );

    return {
      success: true,
      channelId,
      channelName,
    };
  } catch (error) {
    logger.error("Error in createTrialSlackConnectChannel", error);
    return {
      success: false,
      error: "api_error",
      message:
        error instanceof Error ? `Unexpected error: ${error.message}` : "Unexpected error occurred",
    };
  }
}

/**
 * Resends Slack Connect invite to a different email address
 */
export async function resendSlackConnectInvite(params: {
  channelId: string;
  alternateEmail: string;
  iterateBotToken: string;
}): Promise<{ success: boolean; error?: string }> {
  const { channelId, alternateEmail, iterateBotToken } = params;

  const slackAPI = new WebClient(iterateBotToken);

  logger.info(`Resending Slack Connect invite to ${alternateEmail} for channel ${channelId}`);
  const inviteResult = await slackAPI.conversations.inviteShared({
    channel: channelId,
    emails: [alternateEmail],
  });

  if (!inviteResult.ok) {
    if (inviteResult.error === "invalid_email" || inviteResult.error === "user_not_found") {
      return {
        success: false,
        error: `The email ${alternateEmail} is not associated with any Slack account.`,
      };
    }

    logger.error("Failed to resend Slack Connect invite", inviteResult);
    return {
      success: false,
      error: inviteResult.error || "Failed to send invite",
    };
  }

  logger.info(`Successfully sent Slack Connect invite to ${alternateEmail}`);
  return { success: true };
}
