// Contract for the "slack-agent" processor that runs on one routed Slack
// agent stream (`/agents/slack/<channel>/ts-<threadTs>`).
//
// Rewritten new-style for itx from the pre-migration (git history)
// reference. The processor owns no event types of its own: the assistant
// status is a pure PAINT of the agent's own status-changed announcements
// (which carry their debounce at the source), so there is no Slack-side clear
// obligation left to journal.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import {
  CoreProcessorContract,
  STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
} from "../streams/core-processor-contract.ts";
import { AgentProcessorContract, AgentStatusRecord } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { SlackProcessorContract } from "./slack-processor-contract.ts";

/**
 * Processor for one Slack-backed agent stream.
 *
 * The upstream `slack` processor has already routed raw Slack webhooks to this
 * stream. This processor owns the Slack-specific in-thread behavior: recording
 * route context, transcribing Slack messages into agent input, generating
 * bang-command codemode scripts, and painting the agent's announced busy/idle
 * status onto the Slack assistant status through host-provided dependencies.
 *
 * LLM turns are mention-gated (mirrors github-agent): a human must @mention the
 * bot (or Slack must deliver `app_mention`) before the agent is woken. After
 * that activation, later messages in the same thread also queue turns so
 * multi-turn conversation does not require re-mentioning on every reply.
 * Unmentioned traffic before activation is still transcribed as
 * `dont-trigger-request` history so a later mention has thread context — it
 * never spends model tokens by itself.
 */
export const SlackAgentProcessorContract = defineProcessorContract({
  slug: "slack-agent",
  version: "0.4.0",
  description: "Handles Slack-specific behavior for one routed Slack agent stream.",
  stateSchema: z.object({
    /**
     * The agent's merged status record — what the assistant thread should
     * show. Folded from agent/status-changed patches with the contract's
     * shared merge (mergeAgentStatusPatch): busy patches are
     * sinceOffset-guarded, authored title/note/shortStatus are
     * last-write-wins.
     */
    status: AgentStatusRecord.optional(),
    botBotId: z.string().optional(),
    botUserId: z.string().optional(),
    channel: z.string().optional(),
    /**
     * True after this thread has seen an @mention / app_mention of our bot.
     * Unlocks follow-up turns without re-mentioning (same shape as
     * github-agent's conversationActive).
     */
    conversationActive: z.boolean().default(false),
    latestMessageTs: z.string().optional(),
    streamPath: z.string().optional(),
    threadTs: z.string().optional(),
  }),
  events: {},
  // CoreProcessorContract brings the platform revival fact into scope (see
  // `consumes`).
  processorDeps: [
    AgentProcessorContract,
    CapabilityHostProcessorContract,
    SlackProcessorContract,
    CoreProcessorContract,
  ],
  consumes: [
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
    "events.iterate.com/agent/status-changed",
    // The platform revival fact (core-owned, ONE type for every recovery-wired
    // processor; the payload's processorSlug names which). MUST be consumed
    // (the runner throws at construction otherwise): appended when an
    // incarnation died owing in-flight work — a frame's blocking Slack
    // paints/acks lost to a simultaneous Agent+Stream DO death — its delivery
    // guarantees a caught-up pass whose at-head repaint re-derives the
    // assistant status from the folded status record. Never emitted by the
    // processor: the recovery adapter appends it raw, as the runtime speaking.
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: [
    "events.iterate.com/agents/message-received",
    "events.iterate.com/capability-host/script-execution-requested",
    "events.iterate.com/agent/status-changed",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<SlackAgentProcessorContract>`,
 * `ConsumedEvent<SlackAgentProcessorContract>`, `ProcessorEvent<SlackAgentProcessorContract, T>`.
 */
export type SlackAgentProcessorContract = typeof SlackAgentProcessorContract;

export type SlackAgentProcessorState = z.infer<typeof SlackAgentProcessorContract.stateSchema>;
