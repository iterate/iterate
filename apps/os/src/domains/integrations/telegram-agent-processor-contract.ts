// Contract for the "telegram-agent" processor that runs on one routed Telegram
// agent stream (`/agents/telegram/<connection>/chat-<chatId>[/topic-<id>]
// [/session-<unixSeconds>]`) — the Telegram sibling of
// SlackAgentProcessorContract.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { TelegramProcessorContract } from "./telegram-processor-contract.ts";

/**
 * Processor for one Telegram-backed agent stream (one chat session).
 *
 * The upstream `telegram` router has already forwarded this session's raw
 * webhook updates here. This processor owns the Telegram-specific in-chat
 * behavior:
 *
 * - transcribing updates into agent input (ignoring the bot's own messages),
 *   including reply-thread hints the router attached and `/new` handling (a
 *   FIXED acknowledgement message — not an agent greeting — plus the trailing
 *   text as the fresh session's first message);
 * - the "typing…" chat action while the agent works (best-effort);
 * - the journaled send: it consumes `telegram/send-requested` under
 *   `blockProcessorWhile` — Bot API call, then the `telegram/message-sent`
 *   marker here plus the provenance claim on the connection stream. A request
 *   without a marker is an unmet obligation (crash → checkpoint held →
 *   retried); at-least-once at the Telegram boundary is the accepted caveat
 *   (sendMessage has no idempotency key — the JOURNAL is exactly-once, the
 *   send is not).
 */
export const TelegramAgentProcessorContract = defineProcessorContract({
  slug: "telegram-agent",
  version: "0.2.0",
  description: "Handles Telegram-specific behavior for one routed Telegram agent stream.",
  stateSchema: z.object({
    botId: z.string().optional(),
    chatId: z.string().optional(),
    messageThreadId: z.string().optional(),
    /** message_id of the newest human message seen on this session — one half
     * of the deterministic reply_to_message_id rule. */
    latestInboundMessageId: z.number().optional(),
    /** {@link latestInboundMessageId} snapshotted when the current LLM turn
     * started (llm-request-requested): the message the turn is answering. A
     * send quotes it (`reply_to_message_id`) only when newer messages have
     * arrived since — quoting the latest message is noise, quoting a stale
     * one disambiguates. */
    answeringMessageId: z.number().optional(),
  }),
  events: {
    "events.iterate.com/telegram/send-requested": {
      description:
        "The journaled-send intent: a plain Bot API sendMessage payload (text plus any optional params) appended to the session stream by the agent (or the processor's fixed `/new` acknowledgement). `chat_id`/`message_thread_id` default from the stream path; the telegram-agent processor is OBLIGED to deliver it and mark it with a `message-sent` event.",
      payloadSchema: z.object({ text: z.string() }).loose(),
    },
  },
  processorDeps: [
    AgentProcessorContract,
    CapabilityHostProcessorContract,
    TelegramProcessorContract,
  ],
  consumes: [
    "events.iterate.com/telegram/webhook-received",
    "events.iterate.com/telegram/send-requested",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/capability-host/script-execution-requested",
  ],
  emits: [
    "events.iterate.com/agent/input-added",
    "events.iterate.com/telegram/send-requested",
    "events.iterate.com/telegram/message-sent",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<TelegramAgentProcessorContract>`,
 * `ConsumedEvent<TelegramAgentProcessorContract>`.
 */
export type TelegramAgentProcessorContract = typeof TelegramAgentProcessorContract;

export type TelegramAgentProcessorState = z.infer<
  typeof TelegramAgentProcessorContract.stateSchema
>;
