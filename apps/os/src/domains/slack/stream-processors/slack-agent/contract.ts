// Contract for the "slack-agent" processor that runs on one routed Slack
// agent stream.
//
// Migrated from `packages/shared/src/stream-processors/slack-agent/contract.ts`
// onto the class-based StreamProcessor model. Event wire formats (types +
// payload schemas) are unchanged. The standardProcessorBehavior registration
// slice is gone: the stream processor host announces contracts after each
// subscription handshake instead (migration log D11), and the reducer now
// lives on the `SlackAgentProcessor` class.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import { AgentProcessorContract } from "@iterate-com/shared/stream-processors/agent/contract";
import { CodemodeProcessorContract } from "@iterate-com/shared/stream-processors/codemode/contract";
import { SlackProcessorContract } from "../slack/contract.ts";

/**
 * Processor for one Slack-backed agent stream.
 *
 * The upstream `slack` processor has already routed raw Slack webhooks to this
 * stream. This processor owns the Slack-specific in-thread behavior: recording
 * route context, transcribing Slack messages into agent input, generating
 * bang-command codemode scripts, handling Slack-facing status side effects
 * through host-provided dependencies, and serving event-based
 * `ctx.slack.agent.*` codemode functions.
 */
export const SlackAgentProcessorContract = defineProcessorContract({
  slug: "slack-agent",
  version: "0.1.0",
  description: "Handles Slack-specific behavior for one routed Slack agent stream.",
  stateSchema: z.object({
    botUserId: z.string().optional(),
    channel: z.string().optional(),
    latestMessageTs: z.string().optional(),
    streamPath: z.string().optional(),
    threadTs: z.string().optional(),
  }),
  initialState: {},
  processorDeps: [AgentProcessorContract, CodemodeProcessorContract, SlackProcessorContract],
  events: {},
  consumes: [
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
    "events.iterate.com/agent/status-updated",
    "events.iterate.com/codemode/script-execution-requested",
    "events.iterate.com/codemode/script-execution-completed",
    "events.iterate.com/codemode/function-call-requested",
  ],
  emits: [
    "events.iterate.com/agent/input-added",
    "events.iterate.com/codemode/tool-provider-registered",
    "events.iterate.com/codemode/script-execution-requested",
    "events.iterate.com/codemode/function-call-completed",
  ],
});

export type SlackAgentProcessorState = z.infer<typeof SlackAgentProcessorContract.stateSchema>;
