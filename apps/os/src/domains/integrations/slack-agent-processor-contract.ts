// Contract for the "slack-agent" processor that runs on one routed Slack
// agent stream (`/agents/slack/<channel>/ts-<threadTs>`).
//
// Rewritten new-style for itx from the pre-migration (git history)
// reference. It owns no event types of its own: everything it consumes and
// emits belongs to the slack router, the agent processor, or the itx
// processor contracts.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { SlackProcessorContract } from "./slack-processor-contract.ts";

/**
 * Processor for one Slack-backed agent stream.
 *
 * The upstream `slack` processor has already routed raw Slack webhooks to this
 * stream. This processor owns the Slack-specific in-thread behavior: recording
 * route context, transcribing Slack messages into agent input, generating
 * bang-command codemode scripts, and Slack-facing status side effects through
 * host-provided dependencies.
 */
export const SlackAgentProcessorContract = defineProcessorContract({
  slug: "slack-agent",
  version: "0.2.0",
  description: "Handles Slack-specific behavior for one routed Slack agent stream.",
  stateSchema: z.object({
    botBotId: z.string().optional(),
    botUserId: z.string().optional(),
    channel: z.string().optional(),
    latestMessageTs: z.string().optional(),
    streamPath: z.string().optional(),
    threadTs: z.string().optional(),
  }),
  events: {},
  processorDeps: [AgentProcessorContract, CapabilityHostProcessorContract, SlackProcessorContract],
  consumes: [
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/capability-host/script-execution-requested",
    "events.iterate.com/capability-host/script-execution-completed",
  ],
  emits: [
    "events.iterate.com/agent/input-added",
    "events.iterate.com/capability-host/script-execution-requested",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<SlackAgentProcessorContract>`,
 * `ConsumedEvent<SlackAgentProcessorContract>`, `ProcessorEvent<SlackAgentProcessorContract, T>`.
 */
export type SlackAgentProcessorContract = typeof SlackAgentProcessorContract;

export type SlackAgentProcessorState = z.infer<typeof SlackAgentProcessorContract.stateSchema>;
