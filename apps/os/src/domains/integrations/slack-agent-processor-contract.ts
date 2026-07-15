// Contract for the "slack-agent" processor that runs on one routed Slack
// agent stream (`/agents/slack/<channel>/ts-<threadTs>`).
//
// Rewritten new-style for itx from the pre-migration (git history)
// reference. The processor owns no event types: the assistant status is a
// pure PAINT of the agent's own status-changed announcements (which carry
// their debounce at the source), so there is no Slack-side clear obligation
// left to journal.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract, AgentStatusRecord } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { SlackAgentBirthCertificate, SlackProcessorContract } from "./slack-processor-contract.ts";

/**
 * Processor for one Slack-backed agent stream.
 *
 * The upstream `slack` processor has already routed raw Slack webhooks to this
 * stream. This processor owns the Slack-specific in-thread behavior: recording
 * route context, transcribing Slack messages into agent context, generating
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
  version: "0.5.0",
  description: "Handles Slack-specific behavior for one routed Slack agent stream.",
  stateSchema: z.object({
    birthCertificate: SlackAgentBirthCertificate.nullable().default(null),
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
  processorDeps: [AgentProcessorContract, CapabilityHostProcessorContract, SlackProcessorContract],
  consumes: [
    "events.iterate.com/slack-agent/created",
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
    "events.iterate.com/agent/status-changed",
  ],
  emits: [
    "events.iterate.com/agents/context-added",
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
