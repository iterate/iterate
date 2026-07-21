// Contract for the "telegram-agent" processor that runs on one routed Telegram
// agent stream (`/agents/telegram/<connection>/chat-<chatId>[/topic-<id>]
// [/session-<unixSeconds>]`) — the Telegram sibling of
// SlackAgentProcessorContract. The birth-certificate payload is OWNED by the
// router contract (`telegram-agent/created` is an event the router emits onto
// this stream); this contract reaches through
// `TelegramProcessorContract.events[...]` for it instead of a second export.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { TelegramProcessorContract } from "./telegram-processor-contract.ts";

export const TelegramAgentProcessorContract = defineProcessorContract({
  slug: "telegram-agent",
  version: "0.3.0",
  description: "Handles Telegram-specific behavior for one routed Telegram agent stream.",
  stateSchema: z.object({
    birthCertificate: TelegramProcessorContract.events[
      "events.iterate.com/telegram-agent/created"
    ].payloadSchema
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until telegram-agent/created reduces. The immutable chat " +
          "coordinates every journaled send is forced to.",
      }),
    botId: z.string().optional().meta({
      description: "The receiving bot's numeric id, remembered from the newest forwarded webhook.",
    }),
    chatId: z
      .string()
      .optional()
      .meta({
        description:
          "The chat the newest forwarded webhook belonged to — the typing action's target " +
          "before/beside the birth certificate's coordinates.",
      }),
    messageThreadId: z.string().optional().meta({
      description: "The forum-topic thread id of the newest forwarded webhook, if any.",
    }),
    latestInboundMessageId: z
      .number()
      .optional()
      .meta({
        description:
          "message_id of the newest human message seen on this session — one half of the " +
          "deterministic reply_to_message_id rule.",
      }),
    answeringMessageId: z
      .number()
      .optional()
      .meta({
        description:
          "latestInboundMessageId snapshotted when the current LLM turn started " +
          "(llm-request-requested): the message the turn is answering. A send quotes it " +
          "(reply_to_message_id) only when newer messages have arrived since — quoting the " +
          "latest message is noise, quoting a stale one disambiguates.",
      }),
  }),
  events: {
    "events.iterate.com/telegram/send-requested": {
      description:
        "The journaled-send intent: a plain Bot API sendMessage payload (text plus any optional params) appended to the session stream by the agent (or the processor's fixed `/new` acknowledgement). Thread-bound: `chat_id`/`message_thread_id` are FORCED from the stream path (payload values are ignored — the message-sent claim records this stream as the message's thread, so a send that went elsewhere would corrupt provenance; use the raw itx.integrations.telegram sendMessage to post to a different chat). The telegram-agent processor is OBLIGED to deliver it and mark it with a `message-sent` event.",
      payloadSchema: z
        .object({
          text: z.string().meta({ description: "The message text to deliver." }),
        })
        .loose(),
    },
  },
  // TelegramProcessorContract brings the forwarded webhook, the send marker,
  // and the facet birth certificate into scope; CoreProcessorContract brings
  // the platform revival fact (see `consumes`).
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
    // (sendMessage has no idempotency key — the stream is exactly-once, the
    // send is not). Never emitted by the processor: the recovery adapter
    // appends it raw, as the runtime speaking.
    "events.iterate.com/stream/processor-revived",
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

export type TelegramAgentProcessorState = z.output<
  typeof TelegramAgentProcessorContract.stateSchema
>;
