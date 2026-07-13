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
  description: "Tiny fake repo projection for the itx reference implementation.",
  stateSchema: z.object({
    artifactName: z.string().nullable().default(null),
    /** An open creation OBLIGATION: `create-requested` folded, `created` not
     * yet. The end-of-batch reconciler compares this pair at head — never
     * event-time state, which a journal refold replays with `created` still
     * false (docs/writing-stream-processors.md, "Refold safety"). */
    createRequested: z.boolean().default(false),
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
      examples: [
        {
          description: 'Project bootstrap requested the config repo at path "/repos/config".',
          payload: {
            projectId: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha",
            path: "/repos/config",
          },
        },
      ],
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
      examples: [
        {
          description:
            "The project's config repo finished bootstrapping: its git remote is a Cloudflare Artifacts repository named after the project id and path.",
          payload: {
            artifactName: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha--L3JlcG9zL2NvbmZpZw",
            defaultBranch: "main",
            path: "/repos/config",
            projectId: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha",
            remote:
              "https://6d7f0e2c4b9a5138f2ce7a1b8d3e4f50.artifacts.cloudflare.net/git/os-prd-repos/prj_01jzp3v9qkfxeb2m4n8r7wd5ha--L3JlcG9zL2NvbmZpZw.git",
          },
        },
      ],
    },
    "events.iterate.com/repo/github-link-configured": {
      description: "The repo was linked to a GitHub repository (mirror-out on every commit).",
      payloadSchema: GithubLinkPayload,
      examples: [
        {
          description:
            "The repo was linked to acme-inc/acme-config through the GitHub App installation's connection.",
          payload: {
            connection: "install-87654321",
            installationId: "87654321",
            owner: "acme-inc",
            repo: "acme-config",
          },
        },
      ],
    },
    "events.iterate.com/repo/github-unlinked": {
      description: "The repo's GitHub link was removed.",
      payloadSchema: z.object({
        connection: z.string(),
        owner: z.string(),
        repo: z.string(),
      }),
      examples: [
        {
          description: "The link to acme-inc/acme-config was removed; mirroring stops.",
          payload: {
            connection: "install-87654321",
            owner: "acme-inc",
            repo: "acme-config",
          },
        },
      ],
    },
    "events.iterate.com/repo/github-push-completed": {
      description: "A mirror push delivered the branch head to the linked GitHub repository.",
      payloadSchema: z.object({
        branch: z.string(),
        commitOid: z.string(),
        owner: z.string(),
        repo: z.string(),
      }),
      examples: [
        {
          description: "The default branch's new head was mirrored to GitHub after a commit.",
          payload: {
            branch: "main",
            commitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
            owner: "acme-inc",
            repo: "acme-config",
          },
        },
      ],
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
      examples: [
        {
          description:
            "GitHub rejected the mirror push as non-fast-forward: GitHub has commits this repo does not.",
          payload: {
            branch: "main",
            commitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
            error:
              'Error: GitHub push of main was rejected (non-fast-forward means GitHub has commits this repo does not; use syncFromGithub() to adopt them or pushToGithub({ force: true }) to overwrite): {"refs/heads/main":"fetch first"}',
            owner: "acme-inc",
            repo: "acme-config",
          },
        },
        {
          description:
            "The push failed before a head was resolved (null commitOid): the connection's installation token could not be minted.",
          payload: {
            branch: "main",
            commitOid: null,
            error:
              'Error: GitHub connection "install-87654321" has no usable installation token (HttpError: Not Found). Use itx.integrations.list() to see connections.',
            owner: "acme-inc",
            repo: "acme-config",
          },
        },
      ],
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
      examples: [
        {
          description: "A fast-forward sync adopted GitHub's newer branch head.",
          payload: {
            branch: "main",
            commitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
            forced: false,
            owner: "acme-inc",
            previousCommitOid: "4c1a9b0e2d3f5a6b7c8d9e0f1a2b3c4d5e6f7a80",
            repo: "acme-config",
          },
        },
        {
          description: "A forced sync overwrote diverged local history with GitHub's branch head.",
          payload: {
            branch: "main",
            commitOid: "b7e2f0a9c8d14e3fa6570b2c9d8e1f4a3b5c6d70",
            forced: true,
            owner: "acme-inc",
            previousCommitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
            repo: "acme-config",
          },
        },
      ],
    },
    "events.iterate.com/github/webhook-received": {
      description:
        "One GitHub webhook delivery, captured verbatim on the connection stream and cross-posted here by the repo's linkGithub rule. Maximally loose: bodies are GitHub's, stored rows must always re-parse.",
      payloadSchema: z.object({}).loose(),
      examples: [
        {
          description:
            "A push delivery (trimmed): GitHub's webhook body under `body`, plus the delivery headers and the routing installation id.",
          payload: {
            body: {
              ref: "refs/heads/main",
              before: "4c1a9b0e2d3f5a6b7c8d9e0f1a2b3c4d5e6f7a80",
              after: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
              commits: [
                {
                  id: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
                  message: "Update worker routing",
                  author: { name: "Jane Doe", email: "jane@acme-inc.com" },
                },
              ],
              repository: { full_name: "acme-inc/acme-config" },
              sender: { login: "jane-doe" },
              installation: { id: 87654321 },
            },
            headers: {
              githubDelivery: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
              githubEvent: "push",
            },
            installationId: "87654321",
          },
        },
      ],
    },
    "events.iterate.com/github-agent/route-configured": {
      description:
        "Binds one PR agent stream to its pull request: the GitHub coordinates (via the repo's link), the PR number, and the repo path the webhooks route from. Appended to the agent stream by the repo processor's PR webhook forward.",
      payloadSchema: z
        .object({
          connection: z.string(),
          installationId: z.string(),
          number: z.number(),
          owner: z.string(),
          repo: z.string(),
          repoPath: z.string(),
          streamPath: z.string(),
        })
        .loose(),
      examples: [
        {
          description:
            "The first PR webhook for acme-inc/acme-config#42 bound its agent stream to the pull request.",
          payload: {
            connection: "install-87654321",
            installationId: "87654321",
            number: 42,
            owner: "acme-inc",
            repo: "acme-config",
            repoPath: "/repos/config",
            streamPath: "/agents/repos/config/pull-requests/42",
          },
        },
      ],
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
    "events.iterate.com/github/webhook-received",
    "events.iterate.com/stream/created",
  ],
  emits: [
    "events.iterate.com/repo/created",
    "events.iterate.com/github/webhook-received",
    "events.iterate.com/github-agent/route-configured",
  ],
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
