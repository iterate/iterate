import { WebClient } from "@slack/web-api";
import { eq, and } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";

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

  const channelName = emailToChannelName(userEmail);
  const slackAPI = new WebClient(iterateBotToken);

  try {
    // Check if channel already exists for this estate
    const existingOverride = await db.query.slackChannelEstateOverride.findFirst({
      where: and(
        eq(schema.slackChannelEstateOverride.slackTeamId, iterateTeamId),
        eq(schema.slackChannelEstateOverride.estateId, userEstateId),
      ),
    });

    if (existingOverride) {
      // Channel override already exists - reuse it and ensure bot is joined
      logger.info(
        `Trial channel already exists for estate ${userEstateId}, reusing channel ${existingOverride.slackChannelId}`,
      );

      const channelId = existingOverride.slackChannelId;
      const metadata = existingOverride.metadata as any;
      const channelName = metadata?.channelName || emailToChannelName(userEmail);

      // Check if channel is archived and unarchive if needed
      try {
        const channelInfo = await slackAPI.conversations.info({
          channel: channelId,
        });

        if (channelInfo.ok && channelInfo.channel?.is_archived) {
          logger.info(`Channel ${channelId} is archived, attempting to unarchive...`);
          try {
            await slackAPI.conversations.unarchive({
              channel: channelId,
            });
            logger.info(`Successfully unarchived channel ${channelId}`);
          } catch (unarchiveError: any) {
            const errorCode = unarchiveError?.data?.error;
            logger.error(`Failed to unarchive channel ${channelId}:`, unarchiveError);

            // If bot can't unarchive (not in channel or lacks permissions), return a clear error
            if (errorCode === "not_in_channel" || errorCode === "cant_unarchive_channel") {
              return {
                success: false,
                error: "channel_exists",
                message: `A trial channel for this email (#${channelName}) already exists but is archived. Please ask a Slack workspace admin to unarchive the channel, or contact support for assistance.`,
              };
            }
            // Other unarchive errors should be rethrown
            throw unarchiveError;
          }
        }
      } catch (archiveError: any) {
        // If we failed to get channel info, log and continue
        // But if it was an unarchive error, it was already handled above
        if (
          !archiveError?.data?.error?.includes("not_in_channel") ||
          !archiveError.message?.includes("unarchive")
        ) {
          logger.warn(`Failed to check channel info for ${channelId}`, archiveError);
        }
      }

      // Ensure bot is a member of the channel
      try {
        logger.info(`Joining bot to existing channel ${channelId}`);
        await slackAPI.conversations.join({
          channel: channelId,
        });
      } catch (joinError: any) {
        if (joinError?.data?.error !== "already_in_channel") {
          logger.warn(`Failed to join channel ${channelId}`, joinError);
        }
      }

      // Resend Slack Connect invite (in case user needs it)
      try {
        logger.info(`Sending Slack Connect invite to ${userEmail}`);
        await slackAPI.conversations.inviteShared({
          channel: channelId,
          emails: [userEmail],
        });
      } catch (inviteError: any) {
        if (
          inviteError?.data?.error === "invalid_email" ||
          inviteError?.data?.error === "user_not_found"
        ) {
          logger.warn(`Email ${userEmail} not found in Slack`);
          return {
            success: false,
            error: "invalid_email",
            message: `The email ${userEmail} is not associated with any Slack account. Please provide your Slack email address.`,
          };
        }
        // Ignore other invite errors (e.g., already invited)
        logger.info(`Invite may have been sent previously or user already in channel`);
      }

      // Ensure estate is linked to the trial channel
      await db
        .update(schema.estate)
        .set({
          slackTrialConnectChannelId: channelId,
        })
        .where(eq(schema.estate.id, userEstateId));

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
    let channelId: string;
    let channelWasCreated = false;

    try {
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

      channelId = channelResult.channel.id;
      channelWasCreated = true;
      logger.info(`Created Slack channel ${channelName} (${channelId})`);
    } catch (createError: any) {
      // If channel name is already taken, find the existing channel
      if (createError?.data?.error === "name_taken") {
        logger.info(`Channel ${channelName} already exists, finding it...`);

        // Find the channel by name, paginating through all results
        // Include archived channels so we can unarchive them if needed
        let cursor: string | undefined;
        let foundChannelId: string | undefined;
        let foundChannelIsArchived = false;

        do {
          const listResult = await slackAPI.conversations.list({
            types: "public_channel,private_channel",
            exclude_archived: false, // Include archived channels
            limit: 1000,
            cursor,
          });

          const existingChannel = listResult.channels?.find((ch) => ch.name === channelName);

          if (existingChannel?.id) {
            foundChannelId = existingChannel.id;
            foundChannelIsArchived = existingChannel.is_archived ?? false;
            break;
          }

          cursor = listResult.response_metadata?.next_cursor;
        } while (cursor);

        if (!foundChannelId) {
          logger.error(`Channel ${channelName} exists but could not be found`);
          return {
            success: false,
            error: "api_error",
            message: "Channel exists but could not be found",
          };
        }

        channelId = foundChannelId;
        logger.info(
          `Found existing channel ${channelName} (${channelId})${foundChannelIsArchived ? " - archived" : ""}`,
        );

        // Unarchive if needed
        if (foundChannelIsArchived) {
          try {
            logger.info(`Unarchiving channel ${channelId}`);
            await slackAPI.conversations.unarchive({
              channel: channelId,
            });
            logger.info(`Successfully unarchived channel ${channelId}`);
          } catch (unarchiveError: any) {
            const errorCode = unarchiveError?.data?.error;
            logger.error(`Failed to unarchive channel ${channelId}`, unarchiveError);

            // If bot can't unarchive (not in channel or lacks permissions), return a clear error
            if (errorCode === "not_in_channel" || errorCode === "cant_unarchive_channel") {
              return {
                success: false,
                error: "channel_exists",
                message: `A trial channel for this email (#${channelName}) already exists but is archived. Please ask a Slack workspace admin to unarchive the channel, or contact support for assistance.`,
              };
            }
            // For other errors, return generic message
            return {
              success: false,
              error: "api_error",
              message: "Failed to unarchive existing channel",
            };
          }
        }
      } else {
        throw createError;
      }
    }

    // 2. Ensure bot is a member of the channel
    try {
      logger.info(`Joining bot to channel ${channelId}`);
      await slackAPI.conversations.join({
        channel: channelId,
      });
    } catch (joinError: any) {
      // If already in channel, that's fine - continue
      if (joinError?.data?.error !== "already_in_channel") {
        logger.warn(`Failed to join channel ${channelId}`, joinError);
        // Don't fail the whole operation - we can still try to send the invite
      }
    }

    // 3. Send Slack Connect invite
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

    // 5. Update estate to link the trial channel
    await db
      .update(schema.estate)
      .set({
        slackTrialConnectChannelId: channelId,
      })
      .where(eq(schema.estate.id, userEstateId));

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
