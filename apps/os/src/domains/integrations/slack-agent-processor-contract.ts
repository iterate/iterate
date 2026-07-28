// Contract for the "slack-agent" processor that runs on one routed Slack
// agent stream (`/agents/slack/{connection}/{channel}/ts-{threadTs}`). The
// processor owns NO event types of its own: even its birth certificate
// (`slack-agent/created`) belongs to the upstream slack router's contract —
// the router is what appends it, inside the creation batch it sends to a
// fresh thread stream — and this contract reaches through
// `SlackProcessorContract.events[...]` for the schema. Everything else it
// consumes or emits resolves through `processorDeps`.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { AgentSummary } from "../agents/agent-presence.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { SlackProcessorContract } from "./slack-processor-contract.ts";

export const SlackAgentProcessorContract = defineProcessorContract({
  slug: "slack-agent",
  // 0.11.0: dropped the never-read `streamPath` state field — a version bump
  // refolds persisted reduction checkpoints, which is safe here by design
  // (every vendor lane is idempotency-keyed, freshness-gated, or
  // latest-fact-wins; see the refold tests).
  version: "0.11.0",
  description:
    "Handles Slack-specific behavior for one routed Slack agent stream: transcribes " +
    "forwarded webhooks into agent context (mention-gated LLM wake), compiles !bang " +
    "commands into script runs, and paints the agent's summary/runtime onto Slack's " +
    "assistant thread UI.",
  stateSchema: z.object({
    birthCertificate: SlackProcessorContract.events[
      "events.iterate.com/slack-agent/created"
    ].payloadSchema
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until slack-agent/created reduces. Carries the named " +
          "connection every Slack call posts through, plus the bound channel/thread.",
      }),
    summary: AgentSummary.prefault({}).meta({
      description:
        "The agent's canonical summary (title, activity, waitingFor), reduced from " +
        "agent/summary-updated patches. Slack presentation is a pure paint of this record: " +
        "the title goes to assistant.threads.setTitle, the activity text rides the " +
        "transient thread status.",
    }),
    botBotId: z
      .string()
      .optional()
      .meta({
        description:
          "Our Slack app's bot_id, learned from webhook authorizations; identifies our own " +
          "bot-authored messages so the agent never wakes itself.",
      }),
    botUserId: z
      .string()
      .optional()
      .meta({
        description:
          "Our Slack app's bot user id (the <@U…> mention target), learned from webhook " +
          "authorizations; drives the mention gate and self-action filtering.",
      }),
    channel: z.string().optional().meta({
      description: "Slack channel id of the bound thread, from the route/webhook facts.",
    }),
    channelType: z
      .string()
      .optional()
      .meta({
        description:
          "Slack's conversation type from the routed message webhook. Assistant thread UI " +
          "methods (setStatus/setTitle) are valid for app DMs (`im`), not channel mentions.",
      }),
    conversationActive: z
      .boolean()
      .default(false)
      .meta({
        description:
          "True after this thread has seen an @mention / app_mention of our bot. Unlocks " +
          "follow-up turns without re-mentioning; pre-activation traffic is transcribed as " +
          "non-triggering history.",
      }),
    eyesReactionMessageTs: z
      .string()
      .optional()
      .meta({
        description:
          "Message that actually received this bot's transient 👀 reaction. Ambient " +
          "follow-ups must not replace it: settlement removes the reaction from the message " +
          "we acknowledged, not merely the newest message seen.",
      }),
    threadTs: z.string().optional().meta({
      description: "Slack thread timestamp of the bound thread, from the route/webhook facts.",
    }),
  }),
  events: {},
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
    "events.iterate.com/agent/summary-updated",
    // The platform revival fact (core-owned, ONE type for every recovery-wired
    // processor; the payload's processorSlug names which). Consumption is
    // optional in general, but intentional here: processEvent reacts to this
    // fact by clearing or restoring presentation left by the dead incarnation,
    // then its at-head repaint re-derives assistant status from the reduced
    // summary. Never emitted by the processor: the recovery adapter appends it
    // raw, as the runtime speaking.
    "events.iterate.com/stream/processor-revived",
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
