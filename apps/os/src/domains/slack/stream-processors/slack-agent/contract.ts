// Contract for the "slack-agent" processor that runs on one routed Slack
// agent stream.
//
// The stream processor host announces contracts after each subscription
// handshake; the reducer lives on the `SlackAgentProcessor` class.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import { SlackProcessorContract } from "../slack/contract.ts";
import { AgentProcessorContract } from "~/domains/agents/stream-processors/agent/contract.ts";

/**
 * Processor for one Slack-backed agent stream.
 *
 * The upstream `slack` processor has already routed raw Slack webhooks to this
 * stream. This processor owns the Slack-specific in-thread behavior: recording
 * route context, transcribing Slack messages into agent input, generating
 * bang-command codemode scripts, handling Slack-facing status side effects
 * through host-provided dependencies, and serving event-based
 * `itx.slack.*` capability calls.
 */
export const SlackAgentProcessorContract = defineProcessorContract({
  slug: "slack-agent",
  version: "0.1.0",
  description: "Handles Slack-specific behavior for one routed Slack agent stream.",
  stateSchema: z.object({
    botBotId: z.string().optional(),
    botUserId: z.string().optional(),
    channel: z.string().optional(),
    latestMessageTs: z.string().optional(),
    streamPath: z.string().optional(),
    threadTs: z.string().optional(),
  }),
  initialState: {},
  processorDeps: [AgentProcessorContract, SlackProcessorContract],
  events: {
    "events.iterate.com/itx/script-execution-requested": {
      description:
        "An itx script execution record/queue entry on this stream. With `enqueued: true` the itx processor runs it; otherwise it is the runner's own record (itx-next.md §4).",
      payloadSchema: z.object({
        code: z.string(),
        context: z.string().optional(),
        enqueued: z.boolean().optional(),
        executionId: z.string(),
        vars: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    "events.iterate.com/itx/script-execution-completed": {
      description: "The settled outcome of an itx script execution on this stream.",
      payloadSchema: z.object({
        context: z.string().optional(),
        durationMs: z.number().optional(),
        error: z.unknown().optional(),
        executionId: z.string(),
        logs: z.array(z.string()).optional(),
        ok: z.boolean(),
        result: z.unknown().optional(),
        stack: z.string().optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
    "events.iterate.com/agent/status-updated",
    "events.iterate.com/itx/script-execution-requested",
    "events.iterate.com/itx/script-execution-completed",
  ],
  emits: [
    "events.iterate.com/agent/input-added",
    "events.iterate.com/itx/script-execution-requested",
  ],
});

export type SlackAgentProcessorState = z.infer<typeof SlackAgentProcessorContract.stateSchema>;
