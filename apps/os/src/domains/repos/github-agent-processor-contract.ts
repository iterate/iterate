// Contract for the "github-agent" processor that runs on one routed PR
// agent stream (`/agents/repos/<slug>/pull-requests/<n>`), shaped after the
// email-agent processor contract. Routed webhooks own the bounded PR
// projection and model-visible conversational inputs. Automatic review
// policy is ordinary project userspace: config-repo workers append review
// tasks directly when their own repository rules say to do so.

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import {
  CoreProcessorContract,
  STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
} from "../streams/core-processor-contract.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";

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

/**
 * Processor for one pull-request agent stream.
 *
 * The upstream repo processor has already routed this PR's webhooks here.
 * This processor owns the GitHub-specific in-thread behavior: recording the
 * PR route context and a bounded projection of its webhook timeline. Raw
 * webhook events remain observable on the stream, but they are not copied one
 * by one into the LLM's permanent history. A turn gets one compact current
 * snapshot when a trusted human mentions the agent or on later trusted comments
 * in that activated PR conversation. Review automation is deliberately absent:
 * project config workers consume the same webhooks and append their own review
 * tasks. Replies leave through the named GitHub connection's
 * `itx.integrations.github.get(connection).octokit` capability.
 */
export const GithubAgentProcessorContract = defineProcessorContract({
  slug: "github-agent",
  version: "0.3.0",
  description: "Handles GitHub-specific behavior for one routed pull-request agent stream.",
  stateSchema: z.object({
    connection: z.string().optional(),
    conversationActive: z.boolean().default(false),
    installationId: z.string().optional(),
    number: z.number().optional(),
    owner: z.string().optional(),
    pullRequest: PullRequestProjection.nullable().default(null),
    recentActivity: z.array(PullRequestActivity).default([]),
    repo: z.string().optional(),
    repoPath: z.string().optional(),
    streamPath: z.string().optional(),
  }),
  events: {
    "events.iterate.com/github-agent/repository-collaborator-verified": {
      description:
        "Internal audit fact recording that GitHub verified a human trigger source as a repository collaborator when its webhook author_association was inconclusive.",
      payloadSchema: z.object({
        actor: z.string().min(1),
        routeKey: z.string().min(1),
        sourceOffset: z.number().int().positive(),
      }),
    },
  },
  // CoreProcessorContract brings the platform revival fact into scope (see
  // `consumes`).
  processorDeps: [AgentProcessorContract, RepoProcessorContract, CoreProcessorContract],
  consumes: [
    "events.iterate.com/github-agent/repository-collaborator-verified",
    "events.iterate.com/github-agent/route-configured",
    "events.iterate.com/github/webhook-received",
    // The platform revival fact (core-owned, ONE type for every recovery-wired
    // processor; the payload's processorSlug names which). MUST be consumed
    // (the runner throws at construction otherwise): appended when an
    // incarnation died owing work — a collaborator verification or turn
    // append lost to a simultaneous Agent+Stream DO death — the append
    // cold-boots the Stream DO so the unacknowledged frame redelivers and the
    // blocking verification + turn append re-run. Never emitted by the
    // processor: the recovery adapter appends it raw, as the runtime speaking.
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: [
    // Route context stays a plain model-visible input; policy-triggered
    // snapshots are inbound messages from their GitHub sender.
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agents/message-received",
    "events.iterate.com/github-agent/repository-collaborator-verified",
    "events.iterate.com/agent/status-changed",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<GithubAgentProcessorContract>`,
 * `ConsumedEvent<GithubAgentProcessorContract>`.
 */
export type GithubAgentProcessorContract = typeof GithubAgentProcessorContract;

export type GithubAgentProcessorState = z.infer<typeof GithubAgentProcessorContract.stateSchema>;
