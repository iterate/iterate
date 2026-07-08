import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "../streams/processor-contracts.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

/**
 * The GitHub repository one repo mirrors to: a named GitHub connection (the
 * App installation whose token authenticates pushes) plus the owner/repo
 * coordinates. Folded from the latest `repo/github-link-configured` event.
 */
const GithubLinkPayload = z.object({
  connection: z.string().trim().min(1),
  installationId: z.string().trim().min(1),
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
});

export const RepoProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.1.0",
  description: "Tiny fake repo projection for the ITX reference implementation.",
  stateSchema: z.object({
    artifactName: z.string().nullable().default(null),
    created: z.boolean().default(false),
    defaultBranch: z.string().nullable().default(null),
    github: GithubLinkPayload.nullable().default(null),
    initialized: z.boolean().default(false),
    lastGithubPush: z
      .object({
        at: z.string(),
        branch: z.string(),
        commitOid: z.string().nullable(),
        error: z.string().nullable(),
        ok: z.boolean(),
      })
      .nullable()
      .default(null),
    remote: z.string().nullable().default(null),
  }),
  events: {
    "events.iterate.com/repo/create-requested": {
      description: "A repo creation was requested.",
      payloadSchema: z.object({
        projectId: z.string().nullable(),
        path: z.string(),
      }),
    },
    "events.iterate.com/repo/created": {
      description: "The repo was created.",
      payloadSchema: z.object({
        artifactName: z.string(),
        defaultBranch: z.string(),
        path: z.string(),
        projectId: z.string().nullable(),
        remote: z.string(),
      }),
    },
    "events.iterate.com/repo/github-link-configured": {
      description: "The repo was linked to a GitHub repository (mirror-out on every commit).",
      payloadSchema: GithubLinkPayload,
    },
    "events.iterate.com/repo/github-unlinked": {
      description: "The repo's GitHub link was removed.",
      payloadSchema: z.object({
        connection: z.string(),
        owner: z.string(),
        repo: z.string(),
      }),
    },
    "events.iterate.com/repo/github-push-completed": {
      description: "A mirror push delivered the branch head to the linked GitHub repository.",
      payloadSchema: z.object({
        branch: z.string(),
        commitOid: z.string(),
        owner: z.string(),
        repo: z.string(),
      }),
    },
    "events.iterate.com/repo/github-push-failed": {
      description:
        "A mirror push to the linked GitHub repository failed. Best-effort mirroring self-heals: the next commit's push carries every missing commit, and repo.pushToGithub() repairs on demand.",
      payloadSchema: z.object({
        branch: z.string(),
        commitOid: z.string().nullable(),
        error: z.string(),
        owner: z.string(),
        repo: z.string(),
      }),
    },
    "events.iterate.com/repo/github-synced": {
      description: "The repo adopted the linked GitHub repository's branch head (syncFromGithub).",
      payloadSchema: z.object({
        branch: z.string(),
        commitOid: z.string(),
        forced: z.boolean(),
        owner: z.string(),
        previousCommitOid: z.string().nullable(),
        repo: z.string(),
      }),
    },
  },
  processorDeps: [CoreProcessorContract],
  consumes: [
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/repo/created",
    "events.iterate.com/repo/github-link-configured",
    "events.iterate.com/repo/github-unlinked",
    "events.iterate.com/repo/github-push-completed",
    "events.iterate.com/repo/github-push-failed",
    "events.iterate.com/repo/github-synced",
    "events.iterate.com/stream/created",
  ],
  emits: ["events.iterate.com/repo/created"],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<RepoProcessorContract>`,
 * `ConsumedEvent<RepoProcessorContract>`, `ProcessorEvent<RepoProcessorContract, T>`.
 */
export type RepoProcessorContract = typeof RepoProcessorContract;

/**
 * The repo processor's reduced state, inferred from the contract's
 * `stateSchema` — the one definition of the shape.
 */
export type RepoProcessorState = ProcessorState<RepoProcessorContract>;
