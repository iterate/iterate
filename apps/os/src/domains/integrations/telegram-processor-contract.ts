// Contract for the "telegram" webhook-router processor mounted on each
// per-project `/integrations/telegram/{connection}` stream — the Telegram
// sibling of SlackProcessorContract.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

const TelegramBirthCertificate = z.object({
  config: z.object({ connection: z.string() }),
});

export const TelegramAllowedUserIds = z
  .array(z.string().trim().regex(/^\d+$/, "Telegram user IDs contain digits only"))
  .transform((ids) => [...new Set(ids)]);

export const TelegramAgentBirthCertificate = z.object({
  config: z.object({
    connection: z.string(),
    chatId: z.string(),
    messageThreadId: z.string().optional(),
  }),
});
export type TelegramAgentBirthCertificate = z.output<typeof TelegramAgentBirthCertificate>;

/** One `/new` session start, ordered by `(date, messageId)`: `date` is unix
 * seconds so same-second ties are possible; `message_id` is strictly
 * increasing per chat and breaks them. `sessionPath` is the routed stream. */
const SessionStart = z.object({
  date: z.number(),
  messageId: z.number(),
  senderId: z.string(),
  sessionPath: z.string(),
});

/**
 * Processor mounted on `/integrations/telegram/{connection}`, armed at connect
 * time by connectTelegram's `recordConnection` processorSubscription.
 *
 * This processor is only a Telegram webhook router. Its folded state is the
 * thread model (the Slack router's `routes` table, reshaped for Telegram's
 * primitives):
 *
 * - `sessionsByChat`: per-chat `/new` session starts, folded straight from the
 *   webhook events on this stream. Every update routes to the LATEST session
 *   (ordered by `(date, message_id)`); a chat with no `/new` yet routes to the
 *   bare chat path — session zero, the v1 shape.
 * - `sentMessages`: `chatId:messageId → sessionPath` provenance for bot-sent
 *   messages, folded from the `message-sent` claims the telegram-agent
 *   processor cross-posts here after each journaled send. Replies to bot
 *   messages get EXACT thread hints from this map; replies to user messages
 *   fall back to "latest session started at or before the replied-to date".
 *
 * reply_to does NOT route (a reply-to-quote and a reply-to-continue are the
 * same gesture — a routing rule cannot disambiguate them); it becomes a HINT
 * on the forwarded payload (`replyHint`) that the agent transcription renders.
 *
 * The intended flow is:
 *
 * 1. The webhook door appends the raw Telegram Update to
 *    `/integrations/telegram/{connection}` as
 *    `events.iterate.com/telegram/webhook-received`.
 * 2. This processor forwards the event (plus `replyHint`, when the update is
 *    a reply) to the latest session's agent stream. It explicitly creates the
 *    Agent, CapabilityHost, and Telegram facet and installs all three
 *    subscriptions before forwarding; the `telegram-agent` processor does
 *    the transcription.
 */
export const TelegramProcessorContract = defineProcessorContract({
  slug: "telegram",
  version: "0.4.0",
  description: "Routes raw Telegram webhook updates into Telegram-backed agent streams.",
  stateSchema: z.object({
    birthCertificate: TelegramBirthCertificate.nullable().default(null),
    /** False only while replaying a legacy journal that predates access
     * policy events. The first policy filters that reconstructed session
     * history to newly authorized senders; subsequent policy edits do not
     * erase sessions created while those senders were authorized. */
    accessPolicyConfigured: z.boolean().default(false),
    /** Immutable Telegram user ids authorized to reach project agents through
     * this bot connection. Empty is deliberately deny-all. */
    allowedUserIds: z.array(z.string()).default([]),
    /**
     * Per-chat `/new` session starts, oldest first, keyed by the chat's path
     * suffix (`chat-{chatId}` or `chat-{chatId}/topic-{threadId}`). The last
     * entry is the live session; the history serves reply-date fallback
     * resolution ("latest session started at or before the replied-to date").
     */
    sessionsByChat: z.record(z.string(), z.array(SessionStart)).default({}),
    /**
     * Bot-message provenance: `{chatId}:{messageId}` → the session stream the
     * send-requested lived on. Folded from this stream's `message-sent`
     * claims.
     */
    sentMessages: z.record(z.string(), z.object({ sessionPath: z.string() })).default({}),
  }),
  events: {
    "events.iterate.com/telegram/created": {
      description: "Birth certificate for this Telegram webhook router.",
      payloadSchema: TelegramBirthCertificate,
      examples: [
        {
          description: "A Telegram connection router is born for one bot connection.",
          payload: { config: { connection: "support-bot" } },
        },
      ],
    },
    "events.iterate.com/telegram/access-configured": {
      description:
        "Replaces the Telegram user-id allowlist for this bot connection. Empty denies every inbound user.",
      payloadSchema: z.object({
        allowedUserIds: TelegramAllowedUserIds,
      }),
      examples: [
        {
          description: "Two Telegram users may talk to this project bot.",
          payload: { allowedUserIds: ["555123", "777456"] },
        },
      ],
    },
    "events.iterate.com/telegram-agent/created": {
      description: "Birth certificate for the Telegram facet on an agent stream.",
      payloadSchema: TelegramAgentBirthCertificate,
      examples: [
        {
          description: "A Telegram facet binds an agent stream to one chat topic.",
          payload: {
            config: { connection: "support-bot", chatId: "555123", messageThreadId: "42" },
          },
        },
      ],
    },
    "events.iterate.com/telegram/webhook-received": {
      description:
        "Raw Telegram Update, appended by the webhook door to `/integrations/telegram/{connection}` and forwarded (plus `replyHint` when the update replies to an earlier message) to routed chat/session streams. `botId` is the receiving bot's numeric id (the webhook path segment).",
      payloadSchema: z
        .object({ body: z.record(z.string(), z.unknown()), botId: z.string() })
        .loose(),
      examples: [
        {
          description: "A private-chat text message, as Telegram's Bot API delivers it.",
          payload: {
            botId: "7000001",
            body: {
              update_id: 100001,
              message: {
                message_id: 42,
                from: { id: 555123, is_bot: false, first_name: "Misha", username: "misha" },
                chat: { id: 555123, type: "private" },
                date: 1_751_980_451,
                text: "Hey, can you check the deploy status?",
              },
            },
          },
        },
      ],
    },
    "events.iterate.com/telegram/message-sent": {
      description:
        "One journaled send delivered to Telegram. On the session stream it is the effect marker satisfying the send-requested at `requestOffset`; on the connection stream it is the provenance claim (`messageId`, `chatId`, `sessionPath`, `request`) the router folds so replies to bot messages resolve to their exact thread.",
      payloadSchema: z
        .object({
          messageId: z.number(),
          chatId: z.string().optional(),
          requestOffset: z.number().optional(),
          request: z.object({ offset: z.number(), stream: z.string() }).optional(),
          sessionPath: z.string().optional(),
        })
        .loose(),
      examples: [
        {
          description:
            "The connection-stream provenance claim: bot message_id → the session stream its send-requested lived on.",
          payload: {
            messageId: 9001,
            chatId: "555123",
            sessionPath: "/agents/telegram/mishas-helper-bot/chat-555123/session-1751980500",
            request: {
              offset: 7,
              stream: "/agents/telegram/mishas-helper-bot/chat-555123/session-1751980500",
            },
          },
        },
      ],
    },
  },
  consumes: [
    "events.iterate.com/telegram/created",
    "events.iterate.com/telegram/access-configured",
    "events.iterate.com/telegram/webhook-received",
    "events.iterate.com/telegram/message-sent",
  ],
  processorDeps: [AgentProcessorContract, CapabilityHostProcessorContract, CoreProcessorContract],
  emits: [
    "events.iterate.com/agent/created",
    "events.iterate.com/agents/context-added",
    "events.iterate.com/capability-host/created",
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/telegram-agent/created",
    "events.iterate.com/telegram/webhook-received",
    "events.iterate.com/stream/subscription-configured",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<TelegramProcessorContract>`,
 * `ConsumedEvent<TelegramProcessorContract>`.
 */
export type TelegramProcessorContract = typeof TelegramProcessorContract;

export type TelegramProcessorState = z.infer<typeof TelegramProcessorContract.stateSchema>;
