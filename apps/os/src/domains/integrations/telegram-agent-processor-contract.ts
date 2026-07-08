// Contract for the "telegram-agent" processor that runs on one routed Telegram
// agent stream (`/agents/telegram/<connection>/chat-<chatId>[/topic-<id>]`) —
// the Telegram sibling of SlackAgentProcessorContract. It owns no event types
// of its own: everything it consumes and emits belongs to the telegram router,
// the agent processor, or the capability-host contracts.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { TelegramProcessorContract } from "./telegram-processor-contract.ts";

/**
 * Processor for one Telegram-backed agent stream.
 *
 * The upstream `telegram` router has already forwarded this chat's raw webhook
 * updates here. This processor owns the Telegram-specific in-chat behavior:
 * transcribing updates into agent input (ignoring the bot's own messages) and
 * the "typing…" chat action while the agent works, through a host-provided
 * dependency. Replies are NOT its job — the agent itself posts via
 * itx.integrations.telegram["<connection>"].sendMessage.
 */
export const TelegramAgentProcessorContract = defineProcessorContract({
  slug: "telegram-agent",
  version: "0.1.0",
  description: "Handles Telegram-specific behavior for one routed Telegram agent stream.",
  stateSchema: z.object({
    botId: z.string().optional(),
    chatId: z.string().optional(),
    messageThreadId: z.string().optional(),
  }),
  events: {},
  processorDeps: [
    AgentProcessorContract,
    CapabilityHostProcessorContract,
    TelegramProcessorContract,
  ],
  consumes: [
    "events.iterate.com/telegram/webhook-received",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/capability-host/script-execution-requested",
  ],
  emits: ["events.iterate.com/agent/input-added"],
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
