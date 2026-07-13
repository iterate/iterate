// Contract for the "github-agent" processor that runs on one routed PR
// agent stream (`/agents/repos/<slug>/pull-requests/<n>`), shaped after the
// email-agent processor contract. One configuration fact owns all project
// policy; routed webhooks own per-PR controls and model-visible inputs belong
// to the agent contract.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";

/** The complete project-owned policy for one GitHub agent. This is one value,
 * not a family of enable/disable facts: configuring again replaces it. */
export const GithubAgentConfiguration = z.object({
  automaticReview: z
    .object({
      enabled: z.boolean().default(false),
      /** Project-owned review rules become task context only for a review
       * turn, rather than permanent system-prompt ballast. */
      instructions: z
        .string()
        .trim()
        .min(1)
        .default(
          "Review the complete pull-request diff for correctness, security, regressions, and missing tests. Report only specific actionable findings supported by the changed code.",
        ),
    })
    .prefault({}),
});

export type GithubAgentConfiguration = z.infer<typeof GithubAgentConfiguration>;
/** Partial GitHub pull-request agent policy accepted by agent defaults and configuration calls. */
export type GithubAgentConfigurationInput = z.input<typeof GithubAgentConfiguration>;

const PullRequestProjection = z.object({
  author: z.string().optional(),
  baseRef: z.string().optional(),
  baseSha: z.string().optional(),
  body: z.string().optional(),
  draft: z.boolean().optional(),
  headRef: z.string().optional(),
  headRepo: z.string().optional(),
  headRepoOwner: z.string().optional(),
  headSha: z.string().optional(),
  labels: z.array(z.string()).default([]),
  state: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
});

const PullRequestActivity = z.object({
  action: z.string().optional(),
  actor: z.string().optional(),
  authorAssociation: z.string().optional(),
  at: z.string(),
  kind: z.string(),
  offset: z.number().int().positive(),
  securityWarning: z.string().optional(),
  summary: z.string(),
  trustedInstructionSource: z.boolean().default(false),
});

const ReviewCandidate = z.object({
  draft: z.boolean(),
  headSha: z.string(),
  offset: z.number().int().positive(),
  supersededHeadSha: z.string().optional(),
});

/**
 * Processor for one pull-request agent stream.
 *
 * The upstream repo processor has already routed this PR's webhooks here.
 * This processor owns the GitHub-specific in-thread behavior: recording the
 * PR route context and a bounded projection of its webhook timeline. Raw
 * webhook events remain observable on the stream, but they are not copied one
 * by one into the LLM's permanent history. A turn gets one compact current
 * snapshot when a trusted human mentions the agent, on later trusted comments
 * in that activated PR conversation, or when project policy asks for an automatic
 * review of a new head. Replies leave through the named GitHub connection's
 * `itx.integrations.github.get(connection).octokit` capability.
 */
export const GithubAgentProcessorContract = defineProcessorContract({
  slug: "github-agent",
  version: "0.2.0",
  description: "Handles GitHub-specific behavior for one routed pull-request agent stream.",
  stateSchema: z.object({
    configuration: GithubAgentConfiguration.prefault({}),
    connection: z.string().optional(),
    conversationActive: z.boolean().default(false),
    installationId: z.string().optional(),
    number: z.number().optional(),
    owner: z.string().optional(),
    pullRequest: PullRequestProjection.nullable().default(null),
    recentActivity: z.array(PullRequestActivity).default([]),
    repo: z.string().optional(),
    repoPath: z.string().optional(),
    reviewCandidate: ReviewCandidate.nullable().default(null),
    streamPath: z.string().optional(),
  }),
  events: {
    "events.iterate.com/github-agent/configure": {
      description:
        "The complete project-owned policy for one GitHub pull-request agent. A later fact replaces every option together.",
      payloadSchema: GithubAgentConfiguration,
      examples: [
        {
          description:
            "Automatic reviews interrupt obsolete work on every non-draft head; trusted human mentions queue.",
          payload: {
            automaticReview: {
              enabled: true,
              instructions:
                "Every new public event needs a schema example, documentation, and a reducer test.",
            },
          },
        },
      ],
    },
  },
  processorDeps: [AgentProcessorContract, RepoProcessorContract],
  consumes: [
    "events.iterate.com/github-agent/configure",
    "events.iterate.com/github-agent/route-configured",
    "events.iterate.com/github/webhook-received",
  ],
  emits: [
    // Route context stays a plain model-visible input; policy-triggered
    // snapshots are inbound messages from their GitHub sender.
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agents/message-received",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<GithubAgentProcessorContract>`,
 * `ConsumedEvent<GithubAgentProcessorContract>`.
 */
export type GithubAgentProcessorContract = typeof GithubAgentProcessorContract;

export type GithubAgentProcessorState = z.infer<typeof GithubAgentProcessorContract.stateSchema>;
