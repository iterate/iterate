import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type ConversationsRepliesResponse } from "@slack/web-api";
import { waitUntil } from "cloudflare:workers";
import * as R from "remeda";
import { type CloudflareEnv } from "../../../env.ts";
import type { SlackWebhookPayload } from "../../agent/slack.types.ts";
import { getDb, type DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { SlackAgent } from "../../agent/slack-agent.ts";
import { logger as console } from "../../tag-logger.ts";
import {
  extractBotUserIdFromAuthorizations,
  extractUserId,
  getMessageMetadata,
  isBotMentionedInMessage,
} from "../../agent/slack-agent-utils.ts";
import { slackWebhookEvent } from "../../db/schema.ts";
import { getSlackAccessTokenForEstate } from "../../auth/token-utils.ts";
import { shouldIncludeEventInConversation } from "../../agent/slack-agent-utils.ts";
import type { AgentCoreEventInput } from "../../agent/agent-core.ts";
import { createSlackWebClient } from "./slack-web-client.ts";

// Type alias for Slack message elements from ConversationsRepliesResponse
type SlackMessage = NonNullable<ConversationsRepliesResponse["messages"]>[number];

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
    console.warn("Slack webhook signature verification failed", verification);
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
    console.warn("Slack webhook received without a team ID", body);
    return c.text("ok");
  }

  const [estateId, messageMetadata] = await Promise.all([
    slackTeamIdToEstateId({ db, teamId: body.team_id }),
    getMessageMetadata(body.event, db),
  ]);

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
        }),
      );
    }
  }

  waitUntil(
    // deterministically react to the webhook as early as possible (eyes emoji)
    getSlackAccessTokenForEstate(db, estateId).then(async (slackToken) => {
      if (slackToken) {
        await reactToSlackWebhook(body, createSlackWebClient(slackToken), messageMetadata);
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
      return c.text("ok");
    }
  }

  const agentStub = await SlackAgent.getOrCreateStubByRoute({
    db,
    estateId,
    route: routingKey,
    reason: "Slack webhook received",
  });

  waitUntil((agentStub as unknown as SlackAgent).onSlackWebhookEventReceived(body));

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

export async function syncSlackUsersInBackground(db: DB, botToken: string) {
  try {
    const authedWebClient = createSlackWebClient(botToken);
    const userListResponse = await authedWebClient.users.list({});

    if (!userListResponse.ok || !userListResponse.members) {
      console.error(
        "Failed to fetch Slack users:",
        userListResponse.error || "No members returned",
      );
      return;
    }

    // Filter out invalid members upfront
    const validMembers = userListResponse.members.filter(
      (member) => member.id && member.profile?.email && !member.deleted,
    );

    if (validMembers.length === 0) {
      console.log("No valid Slack members to sync");
      return;
    }

    await db.transaction(async (tx) => {
      const emails = validMembers.map((m) => m.profile!.email!);

      // Step 1: Create any missing users first (try to create all, onConflictDoNothing handles existing)
      try {
        await tx
          .insert(schema.user)
          .values(
            validMembers.map((member) => ({
              name: member.real_name || member.name || "",
              email: member.profile!.email!,
              image: member.profile?.image_192,
              emailVerified: false,
            })),
          )
          .onConflictDoNothing();
      } catch (error) {
        console.error("Error creating users (will continue with existing ones):", error);
      }

      // Step 2: Fetch ALL users (both existing and newly created)
      const allUsers = await tx.query.user.findMany({
        where: inArray(schema.user.email, emails),
      });
      const usersByEmail = new Map(allUsers.map((u) => [u.email, u]));

      // Step 3: Upsert all provider mappings at once
      const mappingsToUpsert = [];

      for (const member of validMembers) {
        const user = usersByEmail.get(member.profile!.email!);

        if (!user) {
          console.error(`User not found for email ${member.profile!.email!}`);
          continue;
        }

        mappingsToUpsert.push({
          providerId: "slack-bot" as const,
          internalUserId: user.id,
          externalId: member.id!,
          providerMetadata: member,
        });
      }

      console.log(`Upserting ${mappingsToUpsert.length} provider mappings`);

      if (mappingsToUpsert.length > 0) {
        await tx
          .insert(schema.providerUserMapping)
          .values(mappingsToUpsert)
          .onConflictDoUpdate({
            target: [schema.providerUserMapping.providerId, schema.providerUserMapping.externalId],
            set: {
              providerMetadata: sql`excluded.provider_metadata`,
            },
          });
      }

      // Log sync results
      console.log(
        `Slack sync complete: ${validMembers.length} members processed, ${mappingsToUpsert.length} mappings upserted`,
      );
    });
  } catch (error) {
    console.error("Error syncing Slack users:", error instanceof Error ? error.message : error);
    throw error;
  }
}

async function handleBotChannelJoin(params: {
  db: DB;
  estateId: string;
  channelId: string;
  botUserId: string;
}) {
  const { db, estateId, channelId, botUserId } = params;

  const slackToken = await getSlackAccessTokenForEstate(db, estateId);
  if (!slackToken) {
    console.error("No Slack token available for channel join handling");
    return;
  }

  const slackAPI = createSlackWebClient(slackToken);

  const history = await slackAPI.conversations.history({
    channel: channelId,
    limit: 5,
  });

  if (!history.ok || !history.messages) {
    console.error("Failed to fetch channel history");
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

      const contextEvents: AgentCoreEventInput[] = [
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
        SlackAgent.getOrCreateStubByRoute({
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
                console.error("[SlackAgent] Failed to add reaction:", error);
              })
          : Promise.resolve(),
      ]);

      if (agentStub.status === "fulfilled") {
        const initEvents = await agentStub.value.initSlack(channelId, threadTs);
        await agentStub.value.addEvents([...initEvents, ...contextEvents]);
      } else {
        console.error("[SlackAgent] Failed to create agent stub:", agentStub.reason);
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
