// Contract for the "telegram-agent" processor that runs on one routed Telegram
// agent stream (`/agents/telegram/<connection>/chat-<chatId>[/topic-<id>]
// [/session-<unixSeconds>]`) — the Telegram sibling of
// SlackAgentProcessorContract.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "iterate/processors";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import {
  TelegramAgentBirthCertificate,
  TelegramProcessorContract,
} from "./telegram-processor-contract.ts";

/**
 * Processor for one Telegram-backed agent stream (one chat session).
 *
 * The upstream `telegram` router has already forwarded this session's raw
 * webhook updates here. This processor owns the Telegram-specific in-chat
 * behavior:
 *
 * - transcribing updates into agent context (ignoring the bot's own messages),
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
  version: "0.3.0",
  description: "Handles Telegram-specific behavior for one routed Telegram agent stream.",
  stateSchema: z.object({
    birthCertificate: TelegramAgentBirthCertificate.nullable().default(null),
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
        "The journaled-send intent: a plain Bot API sendMessage payload (text plus any optional params) appended to the session stream by the agent (or the processor's fixed `/new` acknowledgement). Thread-bound: `chat_id`/`message_thread_id` are FORCED from the stream path (payload values are ignored — the message-sent claim records this stream as the message's thread, so a send that went elsewhere would corrupt provenance; use the raw itx.integrations.telegram sendMessage to post to a different chat). The telegram-agent processor is OBLIGED to deliver it and mark it with a `message-sent` event.",
      payloadSchema: z.object({ text: z.string() }).loose(),
      examples: [
        {
          description:
            "An agent reply on its own session stream; chat_id is filled from the path on delivery.",
          payload: { text: "The deploy is green — all three checks passed." },
        },
      ],
    },
  },
  // CoreProcessorContract brings the platform revival fact into scope (see
  // `consumes`).
  processorDeps: [
    AgentProcessorContract,
    CapabilityHostProcessorContract,
    TelegramProcessorContract,
    CoreProcessorContract,
  ],
  consumes: [
    "events.iterate.com/telegram-agent/created",
    "events.iterate.com/telegram/webhook-received",
    "events.iterate.com/telegram/send-requested",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/capability-host/script-run-requested",
    // The platform revival fact (core-owned, ONE type for every recovery-wired
    // processor; the payload's processorSlug names which). MUST be consumed
    // (the runner throws at construction otherwise): appended when an
    // incarnation died owing work — a journaled send lost to a simultaneous
    // Agent+Stream DO death — the append cold-boots the Stream DO so the
    // unacknowledged frame redelivers and the blocking send re-runs.
    // At-least-once at the Telegram boundary is the accepted caveat
    // (sendMessage has no idempotency key — the journal is exactly-once, the
    // send is not). Never emitted by the processor: the recovery adapter
    // appends it raw, as the runtime speaking.
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: [
    "events.iterate.com/agents/context-added",
    "events.iterate.com/telegram/send-requested",
    "events.iterate.com/telegram/message-sent",
    "events.iterate.com/capability-host/script-run-requested",
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
