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
 * The processor-scoped revival fact `durableObjectRecovery` appends when an
 * incarnation died owing work (stream-processor-runner.ts's
 * `ProcessorRecovery`) — here, the journaled send running under
 * `blockProcessorWhile`. The held cursor alone is not enough: a SIMULTANEOUS
 * Agent+Stream DO death (a deploy evicts both) leaves nothing armed to dial
 * either side again, so the unmet send obligation strands on a quiet thread.
 * The keepalive alarm survives that death; its revival appends this fact,
 * which cold-boots the Stream DO (the append's `woken` fan-out restores the
 * spine), and the ordinary redelivery of the UNACKNOWLEDGED frame re-runs the
 * blocking send. The contract CONSUMES it — the runner's construction check
 * requires that — but never emits it: the recovery adapter appends it raw, as
 * the runtime speaking. The fact itself is only a wake trigger; no per-event
 * handling is needed (reduce ignores it).
 */
export const TELEGRAM_AGENT_REVIVED_EVENT_TYPE = "events.iterate.com/telegram-agent/revived";

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
  version: "0.3.0",
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
    [TELEGRAM_AGENT_REVIVED_EVENT_TYPE]: {
      description:
        "The telegram-agent processor was revived after its incarnation died owing work (a journaled send in flight when an eviction took both the agent and stream DOs). Appended by the platform's recovery alarm, not by the processor; the append cold-boots the stream so the unacknowledged frame redelivers and the blocking send re-runs. At-least-once at the Telegram boundary is the accepted caveat: a send that reached the Bot API before the cursor committed is re-sent (sendMessage has no idempotency key — the journal is exactly-once, the send is not).",
      // Loose ON PURPOSE: the payload is authored by the shared recovery
      // adapter (durableObjectRecovery.appendRevived), and future fields it
      // grows must not turn historical revivals into parse failures.
      payloadSchema: z.looseObject({
        processorSlug: z.string(),
        revivals: z.number(),
        version: z.string(),
      }),
      examples: [
        {
          description:
            "The keepalive alarm revived this session's telegram-agent after an eviction took its in-flight send.",
          payload: { processorSlug: "telegram-agent", revivals: 1, version: "2026-07-15.1" },
        },
      ],
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
    // The revival fact MUST be consumed (the runner throws at construction
    // otherwise): a revival nobody consumes recovers nothing. See the
    // constant's doc for why it is absent from `emits`.
    TELEGRAM_AGENT_REVIVED_EVENT_TYPE,
  ],
  emits: [
    "events.iterate.com/agents/message-received",
    "events.iterate.com/telegram/send-requested",
    "events.iterate.com/telegram/message-sent",
    "events.iterate.com/capability-host/script-execution-requested",
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
