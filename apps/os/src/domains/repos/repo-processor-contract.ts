import { z } from "zod";
import {
  defineProcessorContract,
  STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  type ProcessorState,
} from "iterate/processors";
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
  repositoryId: z.number().int().positive(),
});

const RepoTaskChangedPayload = z.object({
  branch: z.string().trim().min(1),
  commitOid: z.string().trim().min(1),
  path: z.string().trim().min(1),
});

const RepoCommitCompletedPayload = z.object({
  beforeCommitOid: z.string().trim().min(1).nullable(),
  branch: z.string().trim().min(1),
  commitOid: z.string().trim().min(1),
});

export const RepoBirthConfig = z.strictObject({
  github: z
    .strictObject({
      owner: z.string().trim().min(1),
      repo: z.string().trim().min(1),
      artifactImport: z
        .strictObject({
          branch: z.string().trim().min(1),
          depth: z.number().int().positive(),
        })
        .optional(),
    })
    .optional(),
});

export type RepoBirthConfig = z.infer<typeof RepoBirthConfig>;

/** Repo creation is idempotent only when a retry names the same durable
 * source. GitHub coordinates use GitHub's case-insensitive identity.
 * Connection names deliberately are not part of that identity: another
 * authorized installation may safely finish the same creation after birth
 * has committed. */
export function sameRepoBirthConfig(left: RepoBirthConfig | undefined, right: RepoBirthConfig) {
  if (left?.github === undefined || right.github === undefined) {
    return left?.github === right.github;
  }
  return (
    left.github.owner.toLowerCase() === right.github.owner.toLowerCase() &&
    left.github.repo.toLowerCase() === right.github.repo.toLowerCase() &&
    left.github.artifactImport?.branch === right.github.artifactImport?.branch &&
    left.github.artifactImport?.depth === right.github.artifactImport?.depth
  );
}

const RepoBirthCertificate = z.strictObject({ config: RepoBirthConfig });

const GithubWebhookReceivedPayload = z
  .object({
    body: z
      .object({
        repository: z.object({ id: z.number().int().positive() }).loose(),
      })
      .loose(),
    delivery: z.object({
      id: z.string().trim().min(1),
      name: z.string().trim().min(1),
    }),
    installationId: z.string().trim().min(1),
  })
  .loose();

export const RepoProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.3.0",
  description:
    "Projects repo lifecycle, Git activity, task changes, and linked GitHub default-branch imports.",
  stateSchema: z.object({
    birthCertificate: RepoBirthCertificate.nullable().default(null),
    artifactName: z.string().nullable().default(null),
    ready: z.boolean().default(false),
    defaultBranch: z.string().nullable().default(null),
    github: GithubLinkPayload.nullable().default(null),
    /** A GitHub default-branch import obligation. The webhook is first
     * normalized into `github-import-requested`; the at-head reconciler then
     * drives the vendor sync without holding the stream checkpoint. */
    githubImport: z
      .object({
        branch: z.string(),
        requestId: z.string(),
        requestedCommitOid: z.string(),
        status: z.enum(["requested", "started"]),
      })
      .nullable()
      .default(null),
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
    "events.iterate.com/repo/created": {
      description: "Creates a repo processor on this stream.",
      payloadSchema: RepoBirthCertificate,
      examples: [
        {
          description: "A repo is born; its backing artifact is established asynchronously.",
          payload: { config: {} },
        },
      ],
    },
    "events.iterate.com/repo/ready": {
      description: "The repo's backing artifact is ready.",
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
    "events.iterate.com/repo/cloudflare-artifact-event-received": {
      description:
        "A Cloudflare Artifacts lifecycle or Git event captured from the deployment's event queue and routed to this repo stream.",
      payloadSchema: z
        .object({
          artifactName: z.string(),
          body: z.object({}).loose(),
          cloudflareEventType: z.string().optional(),
          namespace: z.string(),
        })
        .loose(),
      examples: [
        {
          description:
            "Cloudflare Artifacts reported that main advanced; the repo processor compares the before and after task trees.",
          payload: {
            artifactName: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha--L3JlcG9zL2NvbmZpZw",
            body: {
              type: "cf.artifacts.repo.pushed",
              payload: {
                after: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
                before: "4c1a9b0e2d3f5a6b7c8d9e0f1a2b3c4d5e6f7a80",
                ref: "refs/heads/main",
              },
            },
            cloudflareEventType: "cf.artifacts.repo.pushed",
            namespace: "os-prd-repos",
          },
        },
      ],
    },
    "events.iterate.com/repo/commit-completed": {
      description:
        "The repo's default branch advanced, normalized from a Cloudflare Artifacts pushed event. This includes pushes made outside OS through Git.",
      payloadSchema: RepoCommitCompletedPayload,
      examples: [
        {
          description: "An external Git push advanced main by one or more commits.",
          payload: {
            beforeCommitOid: "4c1a9b0e2d3f5a6b7c8d9e0f1a2b3c4d5e6f7a80",
            branch: "main",
            commitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
          },
        },
      ],
    },
    "events.iterate.com/repo/task-created": {
      description: "A Markdown task file was created on the repo's default branch.",
      payloadSchema: RepoTaskChangedPayload,
      examples: [
        {
          description: "A new root task became durable on main.",
          payload: {
            branch: "main",
            commitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
            path: "tasks/ship-board.md",
          },
        },
      ],
    },
    "events.iterate.com/repo/task-updated": {
      description: "A Markdown task file changed on the repo's default branch.",
      payloadSchema: RepoTaskChangedPayload,
      examples: [
        {
          description: "Moving a board card changed the task's state frontmatter on main.",
          payload: {
            branch: "main",
            commitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
            path: "apps/os/tasks/ship-board.md",
          },
        },
      ],
    },
    "events.iterate.com/repo/task-deleted": {
      description: "A Markdown task file was deleted from the repo's default branch.",
      payloadSchema: RepoTaskChangedPayload,
      examples: [
        {
          description: "A completed task file was removed from main.",
          payload: {
            branch: "main",
            commitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
            path: "tasks/old-task.md",
          },
        },
      ],
    },
    "events.iterate.com/repo/github-link-configured": {
      description:
        "The repo was linked to a GitHub repository (mirror commits out and import fast-forward default-branch pushes).",
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
            repositoryId: 123456789,
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
        repositoryId: z.number().int().positive(),
      }),
      examples: [
        {
          description: "The link to acme-inc/acme-config was removed; mirroring stops.",
          payload: {
            connection: "install-87654321",
            owner: "acme-inc",
            repo: "acme-config",
            repositoryId: 123456789,
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
      description:
        "The repo adopted the linked GitHub repository's branch head (syncFromGithub or resetFromGithub).",
      payloadSchema: z.object({
        branch: z.string(),
        commitOid: z.string(),
        forced: z.boolean(),
        owner: z.string(),
        previousCommitOid: z.string().nullable(),
        repo: z.string(),
        reset: z.boolean().optional(),
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
    "events.iterate.com/repo/github-import-requested": {
      description: "A linked GitHub default-branch push opened a durable import obligation.",
      payloadSchema: z.object({
        branch: z.string().trim().min(1),
        requestId: z.string().trim().min(1),
        requestedCommitOid: z.string().trim().min(1),
      }),
      examples: [
        {
          description: "A GitHub push requested that main be adopted into Artifacts.",
          payload: {
            branch: "main",
            requestId: "/repos/config:42",
            requestedCommitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
          },
        },
      ],
    },
    "events.iterate.com/repo/github-import-started": {
      description: "The repo processor started a GitHub import attempt.",
      payloadSchema: z.object({
        branch: z.string().trim().min(1),
        requestId: z.string().trim().min(1),
        requestedCommitOid: z.string().trim().min(1),
      }),
      examples: [
        {
          description: "The durable GitHub import attempt began.",
          payload: {
            branch: "main",
            requestId: "/repos/config:42",
            requestedCommitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
          },
        },
      ],
    },
    "events.iterate.com/repo/github-import-completed": {
      description:
        "A GitHub import obligation completed, including when Artifacts was already at the current GitHub head.",
      payloadSchema: z.object({
        branch: z.string().trim().min(1),
        commitOid: z.string().trim().min(1),
        requestId: z.string().trim().min(1),
        requestedCommitOid: z.string().trim().min(1),
      }),
      examples: [
        {
          description: "Artifacts now contains the current GitHub main head.",
          payload: {
            branch: "main",
            commitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
            requestId: "/repos/config:42",
            requestedCommitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
          },
        },
      ],
    },
    "events.iterate.com/repo/github-import-failed": {
      description:
        "A GitHub import obligation failed without blocking later repo events; a later push or explicit sync can retry.",
      payloadSchema: z.object({
        branch: z.string().trim().min(1),
        error: z.string(),
        requestId: z.string().trim().min(1),
        requestedCommitOid: z.string().trim().min(1),
      }),
      examples: [
        {
          description: "GitHub and Artifacts had diverged, so the automatic import failed closed.",
          payload: {
            branch: "main",
            error: 'Error: syncFromGithub is not a fast-forward (GitHub says "diverged").',
            requestId: "/repos/config:42",
            requestedCommitOid: "9f8d2c4b1e7a6a53c0d4e8b2f19a7c3d5e6f8a01",
          },
        },
      ],
    },
    "events.iterate.com/github/webhook-received": {
      description:
        "One GitHub push delivery, captured as decoded JSON on the connection stream and cross-posted here by the repo's linkGithub subscription. The trusted envelope is structural while the vendor body stays loose.",
      payloadSchema: GithubWebhookReceivedPayload,
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
              repository: { full_name: "acme-inc/acme-config", id: 123456789 },
              sender: { login: "jane-doe" },
              installation: { id: 87654321 },
            },
            delivery: {
              id: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
              name: "push",
            },
            installationId: "87654321",
          },
        },
      ],
    },
  },
  processorDeps: [CoreProcessorContract],
  consumes: [
    "events.iterate.com/repo/created",
    "events.iterate.com/repo/ready",
    "events.iterate.com/repo/cloudflare-artifact-event-received",
    "events.iterate.com/repo/commit-completed",
    "events.iterate.com/repo/github-link-configured",
    "events.iterate.com/repo/github-unlinked",
    "events.iterate.com/repo/github-push-completed",
    "events.iterate.com/repo/github-push-failed",
    "events.iterate.com/repo/github-synced",
    "events.iterate.com/repo/github-import-requested",
    "events.iterate.com/repo/github-import-started",
    "events.iterate.com/repo/github-import-completed",
    "events.iterate.com/repo/github-import-failed",
    "events.iterate.com/github/webhook-received",
    "events.iterate.com/stream/created",
    "events.iterate.com/stream/woken",
    "events.iterate.com/stream/subscriber-connected",
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: [
    "events.iterate.com/repo/created",
    "events.iterate.com/repo/ready",
    "events.iterate.com/repo/commit-completed",
    "events.iterate.com/repo/task-created",
    "events.iterate.com/repo/task-updated",
    "events.iterate.com/repo/task-deleted",
    "events.iterate.com/repo/github-import-requested",
    "events.iterate.com/repo/github-import-started",
    "events.iterate.com/repo/github-import-completed",
    "events.iterate.com/repo/github-import-failed",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<RepoProcessorContract>`,
 * `ConsumedEvent<RepoProcessorContract>`.
 */
export type RepoProcessorContract = typeof RepoProcessorContract;

/**
 * The repo processor's reduced state, inferred from the contract's
 * `stateSchema` — the one definition of the shape.
 */
export type RepoProcessorState = ProcessorState<RepoProcessorContract>;
