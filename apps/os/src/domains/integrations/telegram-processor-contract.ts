// Contract for the "telegram" webhook-router processor mounted on each
// per-project `/integrations/telegram/{connection}` stream — the Telegram
// sibling of SlackProcessorContract.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";

/** One `/new` session start, ordered by `(date, messageId)`: `date` is unix
 * seconds so same-second ties are possible; `message_id` is strictly
 * increasing per chat and breaks them. `sessionPath` is the routed stream. */
const SessionStart = z.object({
  date: z.number(),
  messageId: z.number(),
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
 *    a reply) to the latest session's agent stream. The `telegram-agent`
 *    processor on that stream does the actual agent transcription; the
 *    project processor's child-stream-created lane gives the routed stream
 *    its subscriptions.
 */
export const TelegramProcessorContract = defineProcessorContract({
  slug: "telegram",
  version: "0.2.0",
  description: "Routes raw Telegram webhook updates into Telegram-backed agent streams.",
  stateSchema: z.object({
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
    "events.iterate.com/telegram/webhook-received": {
      description:
        "Raw Telegram Update, appended by the webhook door to `/integrations/telegram/{connection}` and forwarded (plus `replyHint` when the update replies to an earlier message) to routed chat/session streams. `botId` is the receiving bot's numeric id (the webhook path segment).",
      payloadSchema: z
        .object({ body: z.record(z.string(), z.unknown()), botId: z.string() })
        .loose(),
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
    },
  },
  consumes: [
    "events.iterate.com/telegram/webhook-received",
    "events.iterate.com/telegram/message-sent",
  ],
  emits: ["events.iterate.com/telegram/webhook-received"],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<TelegramProcessorContract>`,
 * `ConsumedEvent<TelegramProcessorContract>`.
 */
export type TelegramProcessorContract = typeof TelegramProcessorContract;

export type TelegramProcessorState = z.infer<typeof TelegramProcessorContract.stateSchema>;
