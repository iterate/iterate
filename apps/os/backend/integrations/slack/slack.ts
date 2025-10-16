import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { WebClient, type ConversationsRepliesResponse } from "@slack/web-api";
import * as R from "remeda";
import { waitUntil, type CloudflareEnv } from "../../../env.ts";
import type { SlackWebhookPayload } from "../../agent/slack.types.ts";
import { getDb, type DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { SlackAgent } from "../../agent/slack-agent.ts";
import { logger } from "../../tag-logger.ts";
import {
  extractBotUserIdFromAuthorizations,
  extractUserId,
  getMessageMetadata,
  isBotMentionedInMessage,
} from "../../agent/slack-agent-utils.ts";
import { slackWebhookEvent } from "../../db/schema.ts";
import { getSlackAccessTokenForEstate } from "../../auth/token-utils.ts";
import type { AgentCoreEvent } from "../../agent/agent-core.ts";
import { getAgentStub, getOrCreateAgentStubByRoute } from "../../agent/agents/stub-getters.ts";

// Type alias for Slack message elements from ConversationsRepliesResponse
type SlackMessage = NonNullable<ConversationsRepliesResponse["messages"]>[number];

export const slackApp = new Hono<{ Bindings: CloudflareEnv }>();

/**
 * Resolves a Slack team ID (and optionally channel ID) to an estate ID.
 *
 * Resolution order:
 * 1. If channelId is provided, check slackChannelEstateOverride table first
 * 2. Fall back to providerEstateMapping (team_id → estate_id)
 *
 * @param db - Database connection
 * @param teamId - Slack team/workspace ID
 * @param channelId - Optional Slack channel ID for channel-specific routing
 * @returns Estate ID or null if not found
 */
async function slackTeamIdToEstateId({
  db,
  teamId,
  channelId,
}: {
  db: DB;
  teamId: string;
  channelId?: string;
}): Promise<string | null> {
  // First, check for channel-specific override if channelId is provided
  if (channelId) {
    const overrideResult = await db.query.slackChannelEstateOverride.findFirst({
      where: and(
        eq(schema.slackChannelEstateOverride.slackChannelId, channelId),
        eq(schema.slackChannelEstateOverride.slackTeamId, teamId),
      ),
      columns: {
        estateId: true,
      },
    });

    if (overrideResult) {
      logger.info(
        `Using channel override routing: channel=${channelId}, team=${teamId} → estate=${overrideResult.estateId}`,
      );
      return overrideResult.estateId;
    }
  }

  // Fall back to default team_id → estate_id mapping
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

/**
 * Just-in-time sync of a single Slack user who sent a message but isn't in our database yet.
 * This handles both internal users and external Slack Connect users.
 *
 * Returns true if user was successfully synced, false otherwise.
 */
export async function ensureUserSynced(params: {
  db: DB;
  estateId: string;
  slackUserId: string;
  botToken: string;
  syncingTeamId: string;
}): Promise<boolean> {
  const { db, estateId, slackUserId, botToken, syncingTeamId } = params;

  logger.info(
    `[JIT Sync] Starting sync for user ${slackUserId}, estate ${estateId}, syncingTeam ${syncingTeamId}`,
  );

  try {
    // Check if user already exists for this estate
    const existing = await db.query.providerUserMapping.findFirst({
      where: and(
        eq(schema.providerUserMapping.providerId, "slack-bot"),
        eq(schema.providerUserMapping.estateId, estateId),
        eq(schema.providerUserMapping.externalId, slackUserId),
      ),
    });

    if (existing) {
      logger.info(
        `[JIT Sync] User ${slackUserId} already synced for estate ${estateId} (internalUserId=${existing.internalUserId})`,
      );
      return true; // Already synced
    }

    logger.info(`[JIT Sync] User ${slackUserId} not in database, proceeding with sync`);

    // Check if this is a trial estate
    const estate = await db.query.estate.findFirst({
      where: eq(schema.estate.id, estateId),
      columns: { slackTrialConnectChannelId: true, organizationId: true },
    });

    const isTrialEstate = !!estate?.slackTrialConnectChannelId;

    // Fetch user info from Slack
    const slackAPI = new WebClient(botToken);
    let userInfoResponse;
    let userInfo: any = null;
    let hasFullUserInfo = false;

    try {
      userInfoResponse = await slackAPI.users.info({ user: slackUserId });
      hasFullUserInfo = userInfoResponse.ok && !!userInfoResponse.user;
      userInfo = userInfoResponse.user || null;

      if (!hasFullUserInfo) {
        logger.warn(
          `[JIT Sync] Limited user info for ${slackUserId} on estate ${estateId} (${userInfoResponse.error})`,
        );
      }
    } catch (error: any) {
      logger.warn(
        `[JIT Sync] Cannot fetch full user info for ${slackUserId} on estate ${estateId} (likely external Slack Connect user):`,
        error,
      );
      // For trial estates, this is expected - all users are external
      // Continue with minimal user record creation
      if (!isTrialEstate) {
        return false; // For non-trial estates, fail if we can't get user info
      }
    }

    // Determine user's home team ID (for external users)
    const userHomeTeamId = userInfo?.team_id;

    // Determine if user is external by comparing team IDs
    // For both trial and regular estates, users from other workspaces are external
    // For trial estates:
    //   - iterate team members are INTERNAL (same team ID as syncingTeamId)
    //   - trial users via Slack Connect are EXTERNAL (different team ID)
    //   - if we don't have userHomeTeamId, assume EXTERNAL (Slack Connect users have limited API access)
    const isExternalUser = isTrialEstate
      ? userHomeTeamId !== syncingTeamId // For trials, assume external unless proven internal
      : userHomeTeamId && userHomeTeamId !== syncingTeamId; // For regular estates, require proof

    logger.info(
      `[JIT Sync] User ${slackUserId}: homeTeam=${userHomeTeamId}, syncingTeam=${syncingTeamId}, isTrial=${isTrialEstate}, isExternal=${isExternalUser}, hasFullInfo=${hasFullUserInfo}`,
    );

    // Generate email using syncing team ID (not user's home team)
    // If we don't have full user info, always use synthetic email
    const email = userInfo?.profile?.email || `${slackUserId}@${syncingTeamId}.slack.iterate.com`;

    if (!estate) {
      logger.error(`[JIT Sync] Estate ${estateId} not found during JIT sync`);
      return false;
    }

    logger.info(
      `[JIT Sync] Creating user with email=${email}, name=${userInfo?.real_name || userInfo?.name || `User ${slackUserId}`}`,
    );

    // Sync user in transaction
    await db.transaction(async (tx) => {
      // Create user if doesn't exist
      await tx
        .insert(schema.user)
        .values({
          name: userInfo?.real_name || userInfo?.name || `User ${slackUserId}`,
          email: email,
          emailVerified: false,
          image: userInfo?.profile?.image_192,
          isBot: userInfo?.is_bot ?? false,
        })
        .onConflictDoNothing();

      // Get the user (either just created or already exists)
      const user = await tx.query.user.findFirst({
        where: eq(schema.user.email, email),
      });

      if (!user) {
        throw new Error(`User not found after insert for email ${email}`);
      }

      // Create provider mapping
      await tx
        .insert(schema.providerUserMapping)
        .values({
          providerId: "slack-bot",
          internalUserId: user.id,
          externalId: slackUserId,
          estateId: estateId,
          externalUserTeamId: isExternalUser && userHomeTeamId ? userHomeTeamId : null,
          providerMetadata: {
            ...(userInfo || {}),
            sourceTeamId: userHomeTeamId,
            isSlackConnect: isExternalUser,
            jitSynced: true,
            limitedUserInfo: !hasFullUserInfo,
          },
        })
        .onConflictDoUpdate({
          target: [
            schema.providerUserMapping.providerId,
            schema.providerUserMapping.estateId,
            schema.providerUserMapping.externalId,
          ],
          set: {
            providerMetadata: sql`excluded.provider_metadata`,
          },
        });

      // Determine role
      // For trial estates, everyone is a member (keep it simple)
      // For regular estates, use standard role logic
      const role = isTrialEstate
        ? "member"
        : isExternalUser
          ? "external"
          : userInfo?.is_ultra_restricted || userInfo?.is_restricted
            ? "guest"
            : "member";

      logger.info(
        `[JIT Sync] Assigning role="${role}" to user ${slackUserId} (isTrial=${isTrialEstate}, isExternal=${isExternalUser})`,
      );

      // Add to organization
      await tx
        .insert(schema.organizationUserMembership)
        .values({
          organizationId: estate.organizationId,
          userId: user.id,
          role: role as "guest" | "member" | "external",
        })
        .onConflictDoNothing();
    });

    logger.info(
      `[JIT Sync] ✅ Successfully synced user ${slackUserId} (${email}) for estate ${estateId}`,
    );
    return true;
  } catch (error) {
    logger.error(
      `[JIT Sync] Error syncing user ${slackUserId} for estate ${estateId}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

slackApp.post("/webhook", async (c) => {
  const db = getDb();

  // Get raw request body for signature verification
  const rawBody = await c.req.text();
  const signature = c.req.header("x-slack-signature");
  const requestTimestamp = c.req.header("x-slack-request-timestamp");
  if (!signature || !requestTimestamp) {
    return c.text("Slack webhook received without required signature headers", 400);
  }
  const signingSecret = c.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return c.text("SLACK_SIGNING_SECRET not configured", 500);
  }
  const verification = verifySlackRequest({
    signingSecret,
    body: rawBody,
    headers: {
      "x-slack-signature": signature,
      "x-slack-request-timestamp": requestTimestamp,
    },
  });
  if (!verification.success) {
    logger.warn("Slack webhook signature verification failed", verification);
    return c.text(
      verification.errorMessage ?? "Slack webhook signature verification failed",
      verification.httpStatusCode,
    );
  }

  // Parse the verified body
  const body = JSON.parse(rawBody) as SlackWebhookPayload;
  // Slack types say this doesn't exist but it was here in v1...
  if ("type" in body && body.type === "url_verification" && "challenge" in body) {
    return c.text(body.challenge as string);
  }

  // First we get a slack team ID
  if (!body.team_id || !body.event) {
    logger.warn("Slack webhook received without a team ID", body);
    return c.text("ok");
  }

  // Get message metadata first to extract the channel
  const messageMetadata = await getMessageMetadata(body.event, db);

  // Resolve estate ID, checking channel override first if we have a channel
  const estateId = await slackTeamIdToEstateId({
    db,
    teamId: body.team_id,
    channelId: messageMetadata.channel,
  });

  if (!estateId) {
    // console.warn(
    //   `Slack webhook received for team ${body.team_id} that doesn't map to a known estate`,
    //   body,
    // );
    return c.text("ok");
  }

  if (
    body.event?.type === "message" &&
    "subtype" in body.event &&
    body.event.subtype === "channel_join"
  ) {
    const joinedUserId = body.event.user;
    const botUserId = extractBotUserIdFromAuthorizations(body);

    if (joinedUserId === botUserId) {
      waitUntil(
        handleBotChannelJoin({
          db,
          estateId,
          channelId: body.event.channel,
          botUserId,
          teamId: body.team_id,
        }),
      );
    }
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

  const routingKey = getRoutingKey({
    estateId: estateId,
    threadTs: messageMetadata.threadTs,
  });

  // look up in the database to get all the agents by routing key (hydrate estate/org/config)
  const [agentRoute, ...rest] = await db.query.agentInstanceRoute.findMany({
    where: eq(schema.agentInstanceRoute.routingKey, routingKey),
    with: {
      agentInstance: {
        with: {
          estate: {
            with: {
              organization: true,
              iterateConfigs: true,
            },
          },
        },
      },
    },
  });

  if (rest.length > 0) {
    logger.error(`Multiple agents found for routing key ${routingKey}`);
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
      return c.text("ok");
    }
  }

  const agentStub = agentRoute?.agentInstance?.estate
    ? await getAgentStub("SlackAgent", {
        agentInitParams: {
          record: agentRoute.agentInstance,
          estate: agentRoute.agentInstance.estate,
          organization: agentRoute.agentInstance.estate.organization!,
          iterateConfig: agentRoute.agentInstance.estate.iterateConfigs?.[0]?.config ?? {},
        },
      })
    : await getOrCreateAgentStubByRoute("SlackAgent", {
        db,
        estateId,
        route: routingKey,
        reason: "Slack webhook received",
      });

  waitUntil((agentStub as unknown as SlackAgent).onSlackWebhookEventReceived(body));

  return c.text("ok");
});

slackApp.post("/interactive", async (c) => {
  return c.text("ok");
});

export function getRoutingKey({ estateId, threadTs }: { estateId: string; threadTs: string }) {
  const suffix = `slack-${estateId}`;
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

  const event = slackWebhookPayload.event;

  // Add eyes reaction when bot is mentioned in a human message
  if (
    event.type === "message" &&
    "user" in event &&
    event.user !== botUserId &&
    messageMetadata.channel &&
    messageMetadata.ts &&
    isBotMentionedInMessage(event, botUserId)
  ) {
    await slackAPI.reactions
      .add({
        channel: messageMetadata.channel,
        timestamp: messageMetadata.ts,
        name: "eyes",
      })
      .then(
        () => logger.info("[SlackAgent] Added eyes reaction"),
        (error) => logger.error("[SlackAgent] Failed to add eyes reaction", error),
      );
  }
}

/**
 * Syncs Slack channels for an estate.
 * Returns array of all channels and Set of shared channel IDs.
 */
export async function syncSlackChannels(
  db: DB,
  botToken: string,
  estateId: string,
): Promise<{
  allChannels: Array<{ id: string; name: string; isShared: boolean; isExtShared: boolean }>;
  sharedChannelIds: Set<string>;
}> {
  try {
    const authedWebClient = new WebClient(botToken);

    const accumulatedChannels = [];
    let cursor: string | undefined;

    do {
      const channelsResponse = await authedWebClient.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: false,
        limit: 200, // Max per page
        cursor,
      });

      if (!channelsResponse.ok || !channelsResponse.channels) {
        logger.error(
          "Failed to fetch Slack channels:",
          channelsResponse.error || "No channels returned",
        );
        return { allChannels: [], sharedChannelIds: new Set() };
      }

      accumulatedChannels.push(...channelsResponse.channels);
      cursor = channelsResponse.response_metadata?.next_cursor;
    } while (cursor);

    const channels = accumulatedChannels.filter((c) => c.id && c.name);

    if (channels.length === 0) {
      logger.info("No valid Slack channels to sync");
      return { allChannels: [], sharedChannelIds: new Set() };
    }

    await db.transaction(async (tx) => {
      const channelMappings = channels.map((channel) => ({
        estateId: estateId,
        externalId: channel.id!,
        name: channel.name!,
        isShared: channel.is_shared ?? false,
        isExtShared: channel.is_ext_shared ?? false,
        isPrivate: channel.is_private ?? false,
        isArchived: channel.is_archived ?? false,
        providerMetadata: channel,
      }));

      if (channelMappings.length > 0) {
        await tx
          .insert(schema.slackChannel)
          .values(channelMappings)
          .onConflictDoUpdate({
            target: [schema.slackChannel.estateId, schema.slackChannel.externalId],
            set: {
              name: sql`excluded.name`,
              isShared: sql`excluded.is_shared`,
              isExtShared: sql`excluded.is_ext_shared`,
              isPrivate: sql`excluded.is_private`,
              isArchived: sql`excluded.is_archived`,
              providerMetadata: sql`excluded.provider_metadata`,
            },
          });
      }

      logger.info(`Synced ${channelMappings.length} Slack channels for estate ${estateId}`);
    });

    const allChannels = channels.map((c) => ({
      id: c.id!,
      name: c.name!,
      isShared: c.is_shared ?? false,
      isExtShared: c.is_ext_shared ?? false,
    }));

    const sharedChannelIds = new Set(
      allChannels.filter((c) => c.isShared || c.isExtShared).map((c) => c.id),
    );

    return { allChannels, sharedChannelIds };
  } catch (error) {
    logger.error("Error syncing Slack channels:", error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * Syncs internal Slack workspace users for an estate.
 * Returns Set of Slack user IDs that are internal to the workspace.
 *
 * Email handling strategy:
 * - Regular users with email: Use their actual Slack profile email
 * - Users without emails: Generate synthetic email scoped to the syncing team: {slackUserId}@{teamId}.slack.iterate.com
 * - Slackbot: Generate team-specific email: slackbot@{teamId}.slack.iterate.com
 *
 * This ensures that the same Slack user synced from different teams gets unique emails and separate iterate user records.
 */
export async function syncSlackUsersInBackground(
  db: DB,
  botToken: string,
  estateId: string,
  teamId: string,
): Promise<Set<string>> {
  try {
    const authedWebClient = new WebClient(botToken);

    // Paginate through all users
    const allMembers = [];
    let cursor: string | undefined;

    do {
      const userListResponse = await authedWebClient.users.list({
        cursor,
        limit: 200,
      });

      if (!userListResponse.ok || !userListResponse.members) {
        logger.error(
          "Failed to fetch Slack users:",
          userListResponse.error || "No members returned",
        );
        return new Set();
      }

      allMembers.push(...userListResponse.members);
      cursor = userListResponse.response_metadata?.next_cursor;
    } while (cursor);

    // Filter out invalid members upfront
    // Include bots by allowing members without emails (we'll create synthetic emails for them)
    const validMembers = allMembers.filter(
      (member) => member.id && !member.deleted && (member.profile?.email || member.is_bot),
    );

    if (validMembers.length === 0) {
      logger.info("No valid Slack members to sync");
      return new Set();
    }

    await db.transaction(async (tx) => {
      // Get the organization ID from the estate
      const estate = await tx.query.estate.findFirst({
        where: eq(schema.estate.id, estateId),
        columns: {
          organizationId: true,
        },
      });

      if (!estate) {
        logger.error(`Estate ${estateId} not found`);
        return;
      }

      // Create emails for all members
      // Strategy: Always use syncing team ID for synthetic emails to ensure uniqueness per estate
      // - Regular users with email: Use actual email (globally unique across Slack)
      // - Users without email: Generate team-scoped synthetic email {userId}@{teamId}.slack.iterate.com
      // - Slackbot: Generate team-specific email slackbot@{teamId}.slack.iterate.com
      //
      // This means: If estate A and estate B both sync the same external user without email,
      // they will get different iterate user records (different emails), which is the desired behavior.
      const memberEmails = validMembers.map((m) => {
        if (m.id === "USLACKBOT") {
          // Special case: Team-scoped Slackbot email
          return `slackbot@${teamId}.slack.iterate.com`;
        }
        if (m.profile?.email) {
          return m.profile.email;
        }
        // Synthetic email scoped to the syncing team (not user's home team)
        return `${m.id}@${teamId}.slack.iterate.com`;
      });

      // Step 1: Create any missing users first (try to create all, onConflictDoNothing handles existing)
      try {
        await tx
          .insert(schema.user)
          .values(
            validMembers.map((member, index) => ({
              name: member.real_name || member.name || "",
              email: memberEmails[index],
              image: member.profile?.image_192,
              emailVerified: false,
              isBot: member.is_bot ?? false,
            })),
          )
          .onConflictDoNothing();
      } catch (error) {
        logger.error("Error creating users (will continue with existing ones):", error);
      }

      // Step 2: Fetch ALL users (both existing and newly created)
      const allUsers = await tx.query.user.findMany({
        where: inArray(schema.user.email, memberEmails),
      });
      const usersByEmail = new Map(allUsers.map((u) => [u.email, u]));

      // Step 3: Upsert all provider mappings at once
      const mappingsToUpsert = [];
      const organizationMembershipsToUpsert = [];

      for (let i = 0; i < validMembers.length; i++) {
        const member = validMembers[i];
        const memberEmail = memberEmails[i];
        const user = usersByEmail.get(memberEmail);

        if (!user) {
          logger.error(`User not found for email ${memberEmail}`);
          continue;
        }

        mappingsToUpsert.push({
          providerId: "slack-bot" as const,
          internalUserId: user.id,
          externalId: member.id!,
          estateId: estateId,
          externalUserTeamId: null, // Internal users have no external team
          providerMetadata: {
            ...member,
            sourceTeamId: teamId,
          },
        });

        // Determine role based on Slack restrictions or bot status
        const role = member.is_ultra_restricted || member.is_restricted ? "guest" : "member";

        organizationMembershipsToUpsert.push({
          organizationId: estate.organizationId,
          userId: user.id,
          role: role as "guest" | "member",
        });
      }

      logger.info(`Upserting ${mappingsToUpsert.length} provider mappings`);

      if (mappingsToUpsert.length > 0) {
        await tx
          .insert(schema.providerUserMapping)
          .values(mappingsToUpsert)
          .onConflictDoUpdate({
            target: [
              schema.providerUserMapping.providerId,
              schema.providerUserMapping.estateId,
              schema.providerUserMapping.externalId,
            ],
            set: {
              providerMetadata: sql`excluded.provider_metadata`,
            },
          });
      }

      // Step 4: Upsert organization memberships
      // Note: We use onConflictDoUpdate to ensure roles are updated when re-syncing
      // This is important for trial upgrades where users may have different roles in the new workspace
      logger.info(`Upserting ${organizationMembershipsToUpsert.length} organization memberships`);

      if (organizationMembershipsToUpsert.length > 0) {
        await tx
          .insert(schema.organizationUserMembership)
          .values(organizationMembershipsToUpsert)
          .onConflictDoUpdate({
            target: [
              schema.organizationUserMembership.organizationId,
              schema.organizationUserMembership.userId,
            ],
            set: {
              role: sql`excluded.role`,
            },
          });
      }

      // Log sync results
      const botCount = validMembers.filter((m) => m.is_bot).length;
      logger.info(
        `Slack sync complete: ${validMembers.length} members processed (${botCount} bots), ${mappingsToUpsert.length} mappings upserted, ${organizationMembershipsToUpsert.length} memberships upserted`,
      );

      // Proactively ensure Slackbot exists (it may not be in members list)
      const slackbotEmail = `slackbot@${teamId}.slack.iterate.com`;
      const slackbotExists = validMembers.some((m) => m.id === "USLACKBOT");

      if (!slackbotExists) {
        logger.info("Proactively creating Slackbot user record");

        // Create Slackbot user
        await tx
          .insert(schema.user)
          .values({
            name: "Slackbot",
            email: slackbotEmail,
            emailVerified: true,
            isBot: true,
          })
          .onConflictDoNothing();

        // Get the Slackbot user
        const slackbotUser = await tx.query.user.findFirst({
          where: eq(schema.user.email, slackbotEmail),
        });

        if (slackbotUser) {
          // Create provider mapping for Slackbot
          await tx
            .insert(schema.providerUserMapping)
            .values({
              providerId: "slack-bot",
              internalUserId: slackbotUser.id,
              externalId: "USLACKBOT",
              estateId: estateId,
              externalUserTeamId: null, // Slackbot is internal to the workspace
              providerMetadata: {
                isSlackbot: true,
                sourceTeamId: teamId,
                proactivelyCreated: true,
              },
            })
            .onConflictDoUpdate({
              target: [
                schema.providerUserMapping.providerId,
                schema.providerUserMapping.estateId,
                schema.providerUserMapping.externalId,
              ],
              set: {
                providerMetadata: sql`excluded.provider_metadata`,
              },
            });

          // Add Slackbot to organization (as a bot member)
          await tx
            .insert(schema.organizationUserMembership)
            .values({
              organizationId: estate.organizationId,
              userId: slackbotUser.id,
              role: "member",
            })
            .onConflictDoUpdate({
              target: [
                schema.organizationUserMembership.organizationId,
                schema.organizationUserMembership.userId,
              ],
              set: {
                role: sql`excluded.role`,
              },
            });

          logger.info("Slackbot user record created proactively");
        }
      }
    });

    // Return Set of all internal user IDs for Slack Connect detection
    // Include USLACKBOT explicitly
    const allUserIds = new Set(validMembers.map((m) => m.id!));
    allUserIds.add("USLACKBOT");
    return allUserIds;
  } catch (error) {
    logger.error("Error syncing Slack users:", error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * Orchestrates complete Slack sync for an estate:
 * 1. Syncs channels (parallel with users)
 * 2. Syncs internal workspace users (parallel with channels)
 * 3. Syncs external Slack Connect users from shared channels (sequential)
 */
export async function syncSlackForEstateInBackground(
  db: DB,
  botToken: string,
  estateId: string,
  teamId: string,
): Promise<{
  channels: { count: number; sharedCount: number };
  users: { internalCount: number; externalCount: number };
  errors: string[];
}> {
  try {
    logger.info(`Starting complete Slack sync for estate ${estateId}`);

    // Phase 1: Sync channels and internal users in parallel
    const [channelsResult, internalUserIds] = await Promise.all([
      syncSlackChannels(db, botToken, estateId),
      syncSlackUsersInBackground(db, botToken, estateId, teamId),
    ]);

    const { sharedChannelIds } = channelsResult;

    // Phase 2: Sync external users from shared channels (needs internal user IDs)
    const externalUsersResult = await syncSlackConnectUsers(
      db,
      botToken,
      estateId,
      teamId,
      sharedChannelIds,
      internalUserIds,
    );

    logger.info(
      `Complete Slack sync finished for estate ${estateId}: ${channelsResult.allChannels.length} channels (${sharedChannelIds.size} shared), ${internalUserIds.size} internal users, ${externalUsersResult.externalUserCount} external users`,
    );

    return {
      channels: {
        count: channelsResult.allChannels.length,
        sharedCount: sharedChannelIds.size,
      },
      users: {
        internalCount: internalUserIds.size,
        externalCount: externalUsersResult.externalUserCount,
      },
      errors: externalUsersResult.errors,
    };
  } catch (error) {
    logger.error(
      "Error in syncSlackForEstateInBackground:",
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}

/**
 * Syncs Slack Connect (external) users from shared channels.
 * Creates user records and marks them as "external" in organization membership.
 *
 * Email handling strategy:
 * - External users with email: Use their actual Slack profile email (globally unique)
 * - External users without email: Generate synthetic email scoped to the syncing team: {slackUserId}@{iterateTeamId}.slack.iterate.com
 *
 * Note: We use iterateTeamId (the syncing team) not externalUserTeamId (user's home team) for synthetic emails.
 * This ensures the same external user appears as different iterate users when synced from different estates.
 */
export async function syncSlackConnectUsers(
  db: DB,
  botToken: string,
  estateId: string,
  iterateTeamId: string,
  sharedChannelIds: Set<string>,
  internalUserIds: Set<string>,
): Promise<{ externalUserCount: number; errors: string[] }> {
  if (sharedChannelIds.size === 0) {
    logger.info("No shared channels to sync external users from");
    return { externalUserCount: 0, errors: [] };
  }

  const authedWebClient = new WebClient(botToken);
  const errors: string[] = [];
  const externalUsersByIdMap = new Map<
    string,
    { userInfo: any; externalUserTeamId?: string; discoveredInChannels: string[] }
  >();

  // Fetch members for each shared channel in parallel (with pagination)
  const channelMemberResults = await Promise.allSettled(
    Array.from(sharedChannelIds).map(async (channelId) => {
      try {
        const allMembers: string[] = [];
        let cursor: string | undefined;

        // Paginate through all members of the channel
        do {
          const membersResponse = await authedWebClient.conversations.members({
            channel: channelId,
            cursor,
            limit: 1000,
          });

          if (!membersResponse.ok || !membersResponse.members) {
            throw new Error(
              `Failed to fetch members for channel ${channelId}: ${membersResponse.error}`,
            );
          }

          allMembers.push(...membersResponse.members);
          cursor = membersResponse.response_metadata?.next_cursor;
        } while (cursor);

        return { channelId, members: allMembers };
      } catch (error) {
        const errorMsg = `Error fetching members for channel ${channelId}: ${error instanceof Error ? error.message : error}`;
        logger.error(errorMsg);
        errors.push(errorMsg);
        return null;
      }
    }),
  );

  // Identify external users (not in internal user list)
  for (const result of channelMemberResults) {
    if (result.status === "fulfilled" && result.value) {
      const { channelId, members } = result.value;

      for (const memberId of members) {
        if (!internalUserIds.has(memberId)) {
          // This is an external user
          if (externalUsersByIdMap.has(memberId)) {
            // Already found in another channel
            externalUsersByIdMap.get(memberId)!.discoveredInChannels.push(channelId);
          } else {
            externalUsersByIdMap.set(memberId, {
              userInfo: null, // Will fetch later
              discoveredInChannels: [channelId],
            });
          }
        }
      }
    }
  }

  if (externalUsersByIdMap.size === 0) {
    logger.info("No external Slack Connect users found in shared channels");
    return { externalUserCount: 0, errors };
  }

  // Fetch user info for all external users in parallel
  const userInfoResults = await Promise.allSettled(
    Array.from(externalUsersByIdMap.keys()).map(async (userId) => {
      try {
        const userInfoResponse = await authedWebClient.users.info({ user: userId });
        if (!userInfoResponse.ok || !userInfoResponse.user) {
          throw new Error(`Failed to fetch user info: ${userInfoResponse.error}`);
        }
        // Extract team_id from user info - this is the external user's home team
        const externalUserTeamId = userInfoResponse.user.team_id;
        if (!externalUserTeamId) {
          throw new Error(`No team_id found for external user ${userId}`);
        }
        return { userId, userInfo: userInfoResponse.user, externalUserTeamId };
      } catch (error) {
        const errorMsg = `Error fetching user info for ${userId}: ${error instanceof Error ? error.message : error}`;
        logger.error(errorMsg);
        errors.push(errorMsg);
        return null;
      }
    }),
  );

  // Update map with fetched user info and team ID
  for (const result of userInfoResults) {
    if (result.status === "fulfilled" && result.value) {
      const { userId, userInfo, externalUserTeamId } = result.value;
      const existing = externalUsersByIdMap.get(userId)!;
      existing.userInfo = userInfo;
      existing.externalUserTeamId = externalUserTeamId;
    }
  }

  // Insert/update external users in database
  await db.transaction(async (tx) => {
    const estate = await tx.query.estate.findFirst({
      where: eq(schema.estate.id, estateId),
      columns: { organizationId: true },
    });

    if (!estate) {
      throw new Error(`Estate ${estateId} not found`);
    }

    for (const [
      externalUserId,
      { userInfo, externalUserTeamId, discoveredInChannels },
    ] of externalUsersByIdMap) {
      if (!userInfo) {
        logger.warn(`Skipping external user ${externalUserId} - no user info available`);
        continue;
      }

      if (!externalUserTeamId) {
        logger.error(`Skipping external user ${externalUserId} - no team ID available`);
        continue;
      }

      // Use actual email from Slack profile, or generate synthetic email scoped to the syncing team
      // Pattern: {slackUserId}@{iterateTeamId}.slack.iterate.com
      // This ensures external users get unique emails per syncing estate
      const email =
        userInfo.profile?.email || `${externalUserId}@${iterateTeamId}.slack.iterate.com`;

      // Create or get user
      try {
        await tx
          .insert(schema.user)
          .values({
            name: userInfo.real_name || userInfo.name || "External User",
            email: email,
            emailVerified: false,
            image: userInfo.profile?.image_192,
            isBot: userInfo.is_bot ?? false,
          })
          .onConflictDoNothing();
      } catch (error) {
        logger.error(`Error creating external user ${externalUserId}:`, error);
        continue;
      }

      // Get the user we just created/found
      const user = await tx.query.user.findFirst({
        where: eq(schema.user.email, email),
      });

      if (!user) {
        logger.error(`User not found after insert for email ${email}`);
        continue;
      }

      // Upsert provider mapping
      await tx
        .insert(schema.providerUserMapping)
        .values({
          providerId: "slack-bot",
          internalUserId: user.id,
          externalId: externalUserId,
          estateId: estateId, // The estate that discovered this external user
          externalUserTeamId, // Their actual home team
          providerMetadata: {
            ...userInfo,
            sourceTeamId: externalUserTeamId,
            isSlackConnect: true,
            discoveredInChannels: discoveredInChannels.map((channelId) => ({
              channelId,
              teamId: iterateTeamId,
            })),
          },
        })
        .onConflictDoUpdate({
          target: [
            schema.providerUserMapping.providerId,
            schema.providerUserMapping.estateId,
            schema.providerUserMapping.externalId,
          ],
          set: {
            providerMetadata: sql`excluded.provider_metadata`,
          },
        });

      // Create organization membership with "external" role
      await tx
        .insert(schema.organizationUserMembership)
        .values({
          organizationId: estate.organizationId,
          userId: user.id,
          role: "external",
        })
        .onConflictDoNothing(); // Don't override if already a member with different role
    }

    logger.info(
      `Synced ${externalUsersByIdMap.size} external Slack Connect users for estate ${estateId}`,
    );
  });

  return { externalUserCount: externalUsersByIdMap.size, errors };
}

async function handleBotChannelJoin(params: {
  db: DB;
  estateId: string;
  channelId: string;
  botUserId: string;
  teamId: string;
}) {
  const { db, estateId, channelId, botUserId } = params;

  const slackToken = await getSlackAccessTokenForEstate(db, estateId);
  if (!slackToken) {
    logger.error("No Slack token available for channel join handling");
    return;
  }

  const slackAPI = new WebClient(slackToken);

  const history = await slackAPI.conversations.history({
    channel: channelId,
    limit: 5,
  });

  if (!history.ok || !history.messages) {
    logger.error("Failed to fetch channel history");
    return;
  }

  const validMessages = history.messages.filter((m) => m.ts);
  const threadsByTs = R.groupBy(validMessages, (m) => m.thread_ts || m.ts!);

  const threadEntries = Object.entries(threadsByTs);
  const threadRepliesResults = await Promise.allSettled(
    threadEntries.map(async ([threadTs]) => {
      const threadHistory = await slackAPI.conversations.replies({
        channel: channelId,
        ts: threadTs,
        inclusive: true,
        limit: 100,
      });

      if (!threadHistory.ok || !threadHistory.messages) {
        throw new Error(`Failed to fetch thread history for ${threadTs}`);
      }

      return { threadTs, threadHistory };
    }),
  );

  const threadsWithMentions = R.pipe(
    threadRepliesResults,
    R.filter(
      (
        result,
      ): result is PromiseFulfilledResult<{
        threadTs: string;
        threadHistory: ConversationsRepliesResponse;
      }> => result.status === "fulfilled",
    ),
    R.map((result) => result.value),
    R.filter(
      ({ threadHistory }) =>
        threadHistory.messages?.some((m) => isBotMentionedInMessage(m, botUserId)) ?? false,
    ),
  );

  await Promise.allSettled(
    threadsWithMentions.map(async ({ threadTs, threadHistory }) => {
      const routingKey = getRoutingKey({ estateId, threadTs });

      const threadContext = R.pipe(
        threadHistory.messages ?? [],
        R.filter((msg): msg is SlackMessage => Boolean(msg.user && msg.text && msg.ts && msg.type)),
        R.sortBy((msg) => parseFloat(msg.ts!)),
        R.map((msg) => ({
          user: msg.user!,
          text: msg.text!,
          ts: msg.ts!,
          type: msg.type!,
          timestamp: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
        })),
      );

      const contextEvents: AgentCoreEvent[] = [
        {
          type: "CORE:LLM_INPUT_ITEM",
          data: {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: `The bot was just added to this Slack channel and is joining an existing thread where it was mentioned. Here is the thread history:\n\n${JSON.stringify(threadContext, null, 2)}\n\nThe bot should acknowledge it's joining an existing conversation and respond helpfully to any questions or requests in the thread above.`,
              },
            ],
          },
          triggerLLMRequest: true,
        },
      ];

      const mentionMessage = R.pipe(
        threadHistory.messages ?? [],
        R.reverse(),
        R.find((m) => isBotMentionedInMessage(m, botUserId)),
      );

      const [agentStub] = await Promise.allSettled([
        getOrCreateAgentStubByRoute("SlackAgent", {
          db,
          estateId,
          route: routingKey,
          reason: "Bot joined channel with existing mention",
        }) as unknown as Promise<SlackAgent>,
        mentionMessage?.ts
          ? slackAPI.reactions
              .add({
                channel: channelId,
                timestamp: mentionMessage.ts,
                name: "eyes",
              })
              .catch((error) => {
                logger.error("[SlackAgent] Failed to add reaction:", error);
              })
          : Promise.resolve(),
      ]);

      if (agentStub.status === "fulfilled") {
        const initEvents = await agentStub.value.initSlack(channelId, threadTs);

        const participantEvents = mentionMessage?.user
          ? await agentStub.value.getParticipantJoinedEvents(mentionMessage.user, botUserId)
          : [];

        await agentStub.value.addEvents([...initEvents, ...participantEvents, ...contextEvents]);
      } else {
        logger.error("[SlackAgent] Failed to create agent stub:", agentStub.reason);
      }
    }),
  );
}

/**
 * Verifies the signature of an incoming request from Slack.
 * Returns a structured result and avoids throwing for control flow.
 */
export function verifySlackRequest(options: {
  signingSecret: string;
  body: string;
  headers: {
    "x-slack-signature": string;
    "x-slack-request-timestamp": number | string;
  };
  nowMilliseconds?: number;
}): { success: true } | { success: false; httpStatusCode: 400 | 401; errorMessage: string } {
  const verifyErrorPrefix = "Slack request verification";
  const requestTimestampRaw = options.headers["x-slack-request-timestamp"];
  const requestTimestampSec =
    typeof requestTimestampRaw === "string"
      ? parseInt(requestTimestampRaw, 10)
      : requestTimestampRaw;
  const signature = options.headers["x-slack-signature"];

  if (Number.isNaN(requestTimestampSec)) {
    return {
      success: false,
      httpStatusCode: 400,
      errorMessage: `${verifyErrorPrefix}: header x-slack-request-timestamp did not have the expected type (${requestTimestampRaw})`,
    };
  }

  // Calculate time-dependent values
  const nowMs = options.nowMilliseconds ?? Date.now();
  const requestTimestampMaxDeltaMin = 5;
  const fiveMinutesAgoSec = Math.floor(nowMs / 1000) - 60 * requestTimestampMaxDeltaMin;

  // Rule 1: Check staleness
  if (requestTimestampSec < fiveMinutesAgoSec) {
    return {
      success: false,
      httpStatusCode: 401,
      errorMessage: `${verifyErrorPrefix}: x-slack-request-timestamp must differ from system time by no more than ${requestTimestampMaxDeltaMin} minutes or request is stale`,
    };
  }

  // Rule 2: Check signature
  const [signatureVersion, signatureHash] = signature.split("=");
  if (signatureVersion !== "v0") {
    return {
      success: false,
      httpStatusCode: 401,
      errorMessage: `${verifyErrorPrefix}: unknown signature version`,
    };
  }

  const hmac = createHmac("sha256", options.signingSecret);
  hmac.update(`${signatureVersion}:${requestTimestampSec}:${options.body}`);
  const ourSignatureHash = hmac.digest("hex");
  if (
    !signatureHash ||
    !timingSafeEqual(Buffer.from(signatureHash), Buffer.from(ourSignatureHash))
  ) {
    return {
      success: false,
      httpStatusCode: 401,
      errorMessage: `${verifyErrorPrefix}: signature mismatch`,
    };
  }

  return { success: true };
}
