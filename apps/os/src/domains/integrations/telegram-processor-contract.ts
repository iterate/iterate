// Contract for the "telegram" webhook-router processor mounted on each
// per-project `/integrations/telegram/{connection}` stream — the Telegram
// sibling of SlackProcessorContract.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";

/**
 * Processor mounted on `/integrations/telegram/{connection}`, armed at connect
 * time by connectTelegram's `recordConnection` processorSubscription.
 *
 * This processor is only a Telegram webhook router. Unlike Slack it keeps NO
 * routing table: a Telegram update's destination is a pure function of its
 * chat (`/agents/telegram/{connection}/chat-{chatId}`, plus `/topic-{id}` for
 * forum topics), so there is nothing to remember. The intended flow is:
 *
 * 1. The webhook door appends the raw Telegram Update to
 *    `/integrations/telegram/{connection}` as
 *    `events.iterate.com/telegram/webhook-received`.
 * 2. This processor forwards the event verbatim to the routed chat's agent
 *    stream. The `telegram-agent` processor on that stream does the actual
 *    agent transcription; the project processor's child-stream-created lane
 *    gives the routed stream its subscriptions.
 */
export const TelegramProcessorContract = defineProcessorContract({
  slug: "telegram",
  version: "0.1.0",
  description: "Routes raw Telegram webhook updates into Telegram-backed agent streams.",
  stateSchema: z.object({}),
  events: {
    "events.iterate.com/telegram/webhook-received": {
      description:
        "Raw Telegram Update, appended by the webhook door to `/integrations/telegram/{connection}` and forwarded unchanged to routed chat streams. `botId` is the receiving bot's numeric id (the webhook path segment).",
      payloadSchema: z
        .object({ body: z.record(z.string(), z.unknown()), botId: z.string() })
        .loose(),
    },
  },
  consumes: ["events.iterate.com/telegram/webhook-received"],
  emits: ["events.iterate.com/telegram/webhook-received"],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<TelegramProcessorContract>`,
 * `ConsumedEvent<TelegramProcessorContract>`.
 */
export type TelegramProcessorContract = typeof TelegramProcessorContract;

export type TelegramProcessorState = z.infer<typeof TelegramProcessorContract.stateSchema>;
