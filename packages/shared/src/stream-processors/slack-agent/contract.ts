import { z } from "zod";
import { AgentProcessorContract } from "../agent/contract.ts";
import { CodemodeProcessorContract } from "../codemode/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { SlackProcessorContract } from "../slack/contract.ts";
import { defineProcessorContract } from "../stream-processor.ts";

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
    ...standardProcessorBehavior.stateShape,
    channel: z.string().optional(),
    latestMessageTs: z.string().optional(),
    streamPath: z.string().optional(),
    threadTs: z.string().optional(),
  }),
  initialState: standardProcessorBehavior.initialState,
  processorDeps: [
    ...standardProcessorBehavior.processorDeps,
    AgentProcessorContract,
    CodemodeProcessorContract,
    SlackProcessorContract,
  ],
  events: {},
  consumes: [
    ...standardProcessorBehavior.consumes,
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
    "events.iterate.com/agent/status-updated",
    "events.iterate.com/codemode/script-execution-requested",
    "events.iterate.com/codemode/script-execution-completed",
    "events.iterate.com/codemode/function-call-requested",
  ],
  emits: [
    ...standardProcessorBehavior.emits,
    "events.iterate.com/agent/input-added",
    "events.iterate.com/codemode/tool-provider-registered",
    "events.iterate.com/codemode/script-execution-requested",
    "events.iterate.com/codemode/function-call-completed",
  ],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({ contract, state, event });

    switch (event.type) {
      case "events.iterate.com/slack/thread-route-configured":
        return {
          ...nextState,
          channel: event.payload.channel,
          streamPath: event.payload.streamPath,
          threadTs: event.payload.threadTs,
        };
      case "events.iterate.com/slack/webhook-received": {
        const target = slackTargetFromPayload(event.payload);
        if (target == null) return nextState;
        return {
          ...nextState,
          channel: target.channel,
          ...(target.messageTs == null ? {} : { latestMessageTs: target.messageTs }),
          threadTs: target.threadTs,
        };
      }
      default:
        return nextState;
    }
  },
});

function slackTargetFromPayload(payload: unknown): {
  channel: string;
  messageTs?: string;
  threadTs: string;
} | null {
  const body = readRecord(readRecord(payload)?.body);
  const slackEvent = readRecord(body?.event);
  if (slackEvent == null) return null;

  const item = readRecord(slackEvent.item);
  const message = readRecord(slackEvent.message);
  const channel =
    readString(slackEvent.channel) ?? readString(item?.channel) ?? readString(message?.channel);
  const threadTs =
    readString(slackEvent.thread_ts) ??
    readString(message?.thread_ts) ??
    readString(slackEvent.ts) ??
    readString(item?.ts) ??
    readString(message?.ts);
  if (channel == null || threadTs == null) return null;

  const messageTs = readString(slackEvent.ts) ?? readString(message?.ts);
  return {
    channel,
    ...(messageTs == null ? {} : { messageTs }),
    threadTs,
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
