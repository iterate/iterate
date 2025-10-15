import { WebClient } from "@slack/web-api";
import { eq, and } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { getSlackAccessTokenForEstate } from "../auth/token-utils.ts";

/**
 * Converts an email address to a Slack-friendly channel name
 * Example: user@example.com → trial-user-example-com
 */
export function emailToChannelName(email: string): string {
  const cleaned = email.replace(/@/g, "-").replace(/\./g, "-").toLowerCase();
  return `trial-${cleaned}`;
}

/**
 * Gets the estate ID for iterate's own Slack workspace
 */
export async function getIterateSlackEstateId(
  db: DB,
  iterateTeamId: string,
): Promise<string | null> {
  const result = await db
    .select({
      estateId: schema.providerEstateMapping.internalEstateId,
    })
    .from(schema.providerEstateMapping)
    .where(
      and(
        eq(schema.providerEstateMapping.externalId, iterateTeamId),
        eq(schema.providerEstateMapping.providerId, "slack-bot"),
      ),
    )
    .limit(1);

  return result[0]?.estateId ?? null;
}

/**
 * Creates a trial Slack Connect channel and sets up routing
 *
 * This function:
 * 1. Creates a channel in iterate's Slack workspace
 * 2. Sends a Slack Connect invite to the user's email
 * 3. Creates a routing override to route webhooks from that channel to the user's estate
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

  const channelName = emailToChannelName(userEmail);
  const slackAPI = new WebClient(iterateBotToken);

  try {
    // Check if channel already exists
    const existingOverride = await db.query.slackChannelEstateOverride.findFirst({
      where: and(
        eq(schema.slackChannelEstateOverride.slackTeamId, iterateTeamId),
        eq(schema.slackChannelEstateOverride.estateId, userEstateId),
      ),
    });

    if (existingOverride) {
      logger.info(`Trial channel already exists for estate ${userEstateId}`);
      return {
        success: false,
        error: "channel_exists",
        message: "A trial channel already exists for this estate",
      };
    }

    // 1. Create Slack channel in iterate's workspace
    logger.info(`Creating trial channel: ${channelName}`);
    const channelResult = await slackAPI.conversations.create({
      name: channelName,
      is_private: false,
    });

    if (!channelResult.ok || !channelResult.channel?.id) {
      logger.error("Failed to create Slack channel", channelResult);
      return {
        success: false,
        error: "api_error",
        message: "Failed to create Slack channel",
      };
    }

    const channelId = channelResult.channel.id;
    logger.info(`Created Slack channel ${channelName} (${channelId})`);

    // 2. Send Slack Connect invite
    try {
      logger.info(`Sending Slack Connect invite to ${userEmail}`);
      const inviteResult = await slackAPI.conversations.inviteShared({
        channel: channelId,
        emails: [userEmail],
      });

      if (!inviteResult.ok) {
        logger.error("Failed to send Slack Connect invite", inviteResult);
        // Don't fail here - we'll handle email errors below
      }
    } catch (error: any) {
      // Check if it's an invalid email error
      if (error?.data?.error === "invalid_email" || error?.data?.error === "user_not_found") {
        logger.warn(`Email ${userEmail} not found in Slack, will need alternate email`);
        return {
          success: false,
          error: "invalid_email",
          message: `The email ${userEmail} is not associated with any Slack account. Please provide your Slack email address.`,
        };
      }

      logger.error("Error sending Slack Connect invite", error);
      // Continue anyway - admin can manually invite later
    }

    // 3. Create routing override
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

    // 4. Update estate to link the trial channel
    await db
      .update(schema.estate)
      .set({
        slackTrialConnectChannelId: channelId,
      })
      .where(eq(schema.estate.id, userEstateId));

    logger.info(
      `Successfully created trial channel for ${userEmail}: ${channelName} → estate ${userEstateId}`,
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
      message: error instanceof Error ? error.message : "Unknown error occurred",
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

  try {
    const slackAPI = new WebClient(iterateBotToken);

    logger.info(`Resending Slack Connect invite to ${alternateEmail} for channel ${channelId}`);
    const inviteResult = await slackAPI.conversations.inviteShared({
      channel: channelId,
      emails: [alternateEmail],
    });

    if (!inviteResult.ok) {
      logger.error("Failed to resend Slack Connect invite", inviteResult);
      return {
        success: false,
        error: inviteResult.error || "Failed to send invite",
      };
    }

    logger.info(`Successfully sent Slack Connect invite to ${alternateEmail}`);
    return { success: true };
  } catch (error: any) {
    if (error?.data?.error === "invalid_email" || error?.data?.error === "user_not_found") {
      return {
        success: false,
        error: `The email ${alternateEmail} is not associated with any Slack account.`,
      };
    }

    logger.error("Error resending Slack Connect invite", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}
