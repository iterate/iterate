// Contract for the "slack-agent" processor that runs on one routed Slack
// agent stream (`/agents/slack/<channel>/ts-<threadTs>`).
//
// Rewritten new-style for itx from the pre-migration (git history)
// reference. Its one owned event closes the durable status-clear obligation;
// everything else belongs to the Slack router, agent processor, or itx
// processor contracts.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { SlackProcessorContract } from "./slack-processor-contract.ts";

/**
 * The processor-scoped revival fact `durableObjectRecovery` appends when an
 * incarnation died owing background work (stream-processor-runner.ts's
 * `ProcessorRecovery`) — here, the armed status-clear debounce timer whose
 * `status-clear-due` append is the open obligation's only driver. The
 * contract CONSUMES it — the runner's construction check requires that — but
 * never emits it: the recovery adapter appends it raw, as the runtime
 * speaking. Its ordinary delivery is the guaranteed turn that drives the
 * runner to the stream head, where `onCaughtUp` re-derives the pending clear
 * from the fold; no per-event handling is needed (reduce ignores it).
 */
export const SLACK_AGENT_REVIVED_EVENT_TYPE = "events.iterate.com/slack-agent/revived";

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
  version: "0.3.0",
  description: "Handles Slack-specific behavior for one routed Slack agent stream.",
  stateSchema: z.object({
    activeLlmRequestOffsets: z.array(z.number().int().nonnegative()).default([]),
    activeScriptExecutionIds: z.array(z.string()).default([]),
    botBotId: z.string().optional(),
    botUserId: z.string().optional(),
    channel: z.string().optional(),
    latestMessageTs: z.string().optional(),
    pendingStatusClear: z
      .object({
        due: z.boolean().default(false),
        latestMessageTs: z.string().optional(),
        requestedAt: z.string(),
        triggerOffset: z.number().int().positive(),
      })
      .optional(),
    streamPath: z.string().optional(),
    threadTs: z.string().optional(),
  }),
  events: {
    "events.iterate.com/slack-agent/status-clear-due": {
      description:
        "The status-clear debounce elapsed. The at-head reconciler clears Slack only if this lifecycle generation is still the folded idle state.",
      payloadSchema: z.object({ triggerOffset: z.number().int().positive() }),
      examples: [
        {
          description: "The debounce opened by lifecycle event 84 elapsed.",
          payload: { triggerOffset: 84 },
        },
      ],
    },
    "events.iterate.com/slack-agent/status-clear-completed": {
      description:
        "The debounced Slack assistant-status clear completed. Its triggerOffset identifies the lifecycle fact that opened the durable obligation.",
      payloadSchema: z.object({ triggerOffset: z.number().int().positive() }),
      examples: [
        {
          description: "The status clear opened by lifecycle event 84 reached Slack.",
          payload: { triggerOffset: 84 },
        },
      ],
    },
    [SLACK_AGENT_REVIVED_EVENT_TYPE]: {
      description:
        'The slack-agent processor was revived after its incarnation died owing background work (an armed status-clear debounce timer lost to an eviction). Appended by the platform\'s recovery alarm, not by the processor; its delivery guarantees a caught-up pass that re-derives the pending status clear from the fold — without it, a thread whose agent died between the completion and the clear shows "is thinking..." forever.',
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
            "The keepalive alarm revived this thread's slack-agent after an eviction took its status-clear timer.",
          payload: { processorSlug: "slack-agent", revivals: 1, version: "2026-07-14.1" },
        },
      ],
    },
  },
  processorDeps: [AgentProcessorContract, CapabilityHostProcessorContract, SlackProcessorContract],
  consumes: [
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/capability-host/script-execution-requested",
    "events.iterate.com/capability-host/script-execution-completed",
    "events.iterate.com/slack-agent/status-clear-due",
    "events.iterate.com/slack-agent/status-clear-completed",
    // The revival fact MUST be consumed (the runner throws at construction
    // otherwise): a revival nobody consumes recovers nothing. See the
    // constant's doc for why it is absent from `emits`.
    SLACK_AGENT_REVIVED_EVENT_TYPE,
  ],
  emits: [
    "events.iterate.com/agents/message-received",
    "events.iterate.com/capability-host/script-execution-requested",
    "events.iterate.com/slack-agent/status-clear-due",
    "events.iterate.com/slack-agent/status-clear-completed",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<SlackAgentProcessorContract>`,
 * `ConsumedEvent<SlackAgentProcessorContract>`, `ProcessorEvent<SlackAgentProcessorContract, T>`.
 */
export type SlackAgentProcessorContract = typeof SlackAgentProcessorContract;

export type SlackAgentProcessorState = z.infer<typeof SlackAgentProcessorContract.stateSchema>;
