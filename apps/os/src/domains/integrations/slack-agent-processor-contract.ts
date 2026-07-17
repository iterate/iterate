// Contract for the "slack-agent" processor that runs on one routed Slack
// agent stream (`/agents/slack/<channel>/ts-<threadTs>`).
//
// Rewritten new-style for itx from the pre-migration (git history)
// reference. The processor owns no event types of its own: Slack presentation
// is a pure paint of the agent's canonical metadata and exact runtime counts.

import { z } from "zod";
import { AgentRuntimeChange } from "@iterate-com/shared/agent-events";
import { defineProcessorContract, STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "iterate/processors";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { AgentMetadata } from "../agents/agent-presence.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { SlackAgentBirthCertificate, SlackProcessorContract } from "./slack-processor-contract.ts";

/**
 * Processor for one Slack-backed agent stream.
 *
 * The upstream `slack` processor has already routed raw Slack webhooks to this
 * stream. This processor owns the Slack-specific in-thread behavior: recording
 * route context, transcribing Slack messages into agent context, generating
 * bang-command codemode scripts, and painting active runtime onto Slack's
 * transient assistant status through host-provided dependencies.
 *
 * LLM turns are mention-gated: a human must @mention the bot (or Slack must
 * deliver `app_mention`) before the agent is woken. After
 * that activation, later messages in the same thread also queue turns so
 * multi-turn conversation does not require re-mentioning on every reply.
 * Unmentioned traffic before activation is still transcribed as
 * `dont-trigger-request` history so a later mention has thread context — it
 * never spends model tokens by itself.
 */
export const SlackAgentProcessorContract = defineProcessorContract({
  slug: "slack-agent",
  version: "0.8.0",
  description: "Handles Slack-specific behavior for one routed Slack agent stream.",
  stateSchema: z.object({
    birthCertificate: SlackAgentBirthCertificate.nullable().default(null),
    metadata: AgentMetadata.prefault({}),
    runtimeChange: AgentRuntimeChange.optional(),
    botBotId: z.string().optional(),
    botUserId: z.string().optional(),
    channel: z.string().optional(),
    /** Slack's conversation type from the routed message webhook. Assistant
     * thread UI methods are valid for app DMs (`im`), not channel mentions. */
    channelType: z.string().optional(),
    /**
     * True after this thread has seen an @mention / app_mention of our bot.
     * Unlocks follow-up turns without re-mentioning.
     */
    conversationActive: z.boolean().default(false),
    /** Message that actually received this bot's transient eyes reaction.
     * Ambient follow-ups must not replace it: settlement removes the reaction
     * from the message we acknowledged, not merely the newest message seen. */
    eyesReactionMessageTs: z.string().optional(),
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
    "events.iterate.com/slack-agent/created",
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
    "events.iterate.com/agent/metadata-changed",
    "events.iterate.com/agent/runtime-changed",
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
    "events.iterate.com/agents/context-added",
    "events.iterate.com/capability-host/script-run-requested",
    "events.iterate.com/agent/binding-set",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<SlackAgentProcessorContract>`,
 * `ConsumedEvent<SlackAgentProcessorContract>`.
 */
export type SlackAgentProcessorContract = typeof SlackAgentProcessorContract;

export type SlackAgentProcessorState = z.infer<typeof SlackAgentProcessorContract.stateSchema>;
