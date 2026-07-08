// Contract for the "github-pr-agent" processor that runs on one routed PR
// agent stream (`/agents/repos/<slug>/pull-requests/<n>`), shaped after the
// email-agent processor contract. It owns no event types of its own:
// everything it consumes and emits belongs to the repo router or the agent
// contracts.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";

/**
 * Processor for one pull-request agent stream.
 *
 * The upstream repo processor has already routed this PR's webhooks here.
 * This processor owns the GitHub-specific in-thread behavior: recording the
 * PR route context and transcribing webhooks into agent input. Only human
 * comments that mention the agent trigger an LLM turn — every other webhook
 * is recorded as silent context. Replies leave through the named GitHub
 * connection's `itx.integrations.github[connection]` Octokit capability,
 * instructed by the PR agent system prompt rather than a dedicated send door.
 */
export const PrAgentProcessorContract = defineProcessorContract({
  slug: "github-pr-agent",
  version: "0.1.0",
  description: "Handles GitHub-specific behavior for one routed pull-request agent stream.",
  stateSchema: z.object({
    connection: z.string().optional(),
    installationId: z.string().optional(),
    number: z.number().optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    repoPath: z.string().optional(),
    streamPath: z.string().optional(),
  }),
  events: {},
  processorDeps: [AgentProcessorContract, RepoProcessorContract],
  consumes: [
    "events.iterate.com/github-pr/route-configured",
    "events.iterate.com/github/webhook-received",
  ],
  emits: ["events.iterate.com/agent/input-added"],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<PrAgentProcessorContract>`,
 * `ConsumedEvent<PrAgentProcessorContract>`.
 */
export type PrAgentProcessorContract = typeof PrAgentProcessorContract;

export type PrAgentProcessorState = z.infer<typeof PrAgentProcessorContract.stateSchema>;
