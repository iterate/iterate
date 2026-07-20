// The repo processor CONTRACT. Self-contained: state schema, events,
// consumes/emits, deps — schemas are spelled INLINE in the contract; the
// schemas it genuinely uses twice (the birth certificate, the GitHub link,
// the task-change payload, the import-request coordinates) are hoisted
// functions defined below the contract, so the contract still opens the file.
//
// One stream per repo (`/repos/<name>`). The events tell the repo's whole
// story: birth (`repo/created`), the backing Cloudflare Artifacts repository
// coming up (`repo/ready`), Git pushes observed through the Artifacts event
// queue (`repo/cloudflare-artifact-event-received` → `repo/commit-completed`
// → `repo/task-*` facts), and the optional GitHub mirror: link lifecycle,
// mirror-push outcomes, and the durable default-branch import obligation
// (`github-import-requested/started/completed/failed`) opened by cross-posted
// GitHub push webhooks.

import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

export const RepoProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.3.0",
  description:
    "Projects repo lifecycle, Git activity, task changes, and linked GitHub default-branch imports.",
  stateSchema: z.object({
    birthCertificate: repoBirthCertificateSchema().nullable().default(null).meta({
      description:
        "Existence marker: null until repo/created reduces; then the exact created payload.",
    }),
    artifactName: z.string().nullable().default(null).meta({
      description: "The backing Cloudflare Artifacts repository name, recorded by repo/ready.",
    }),
    ready: z.boolean().default(false).meta({
      description:
        "True once repo/ready reduced: the backing artifact exists and the repo can serve Git.",
    }),
    defaultBranch: z.string().nullable().default(null).meta({
      description:
        "The branch whose pushes produce commit-completed and task facts (from repo/ready).",
    }),
    github: githubLinkSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "The linked GitHub repository, from the latest repo/github-link-configured event; " +
          "null when unlinked.",
      }),
    githubImport: z
      .object({
        branch: z.string().meta({ description: "The branch being imported." }),
        requestId: z.string().meta({
          description:
            "The obligation's identity: the coordinates (path:offset) of the webhook event " +
            "that requested it.",
        }),
        requestedCommitOid: z
          .string()
          .meta({ description: "The GitHub head the push delivery announced." }),
        status: z.enum(["requested", "started"]).meta({
          description:
            "requested = no attempt has durably begun; started = an attempt journaled its " +
            "started fact (a started import with no live driver is re-driven — the sync is an " +
            "idempotent current-head fast-forward).",
        }),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "The one open GitHub default-branch import obligation, or null. The webhook is " +
          "first normalized into github-import-requested; the at-head pass then drives the " +
          "vendor sync without holding the stream cursor.",
      }),
    initialized: z
      .boolean()
      .default(false)
      .meta({
        description:
          "True once the underlying stream's stream/created event reduced. Nothing reads it " +
          "today; kept because the reduced state is public itx surface.",
      }),
    lastGithubPush: z
      .object({
        at: z.string().meta({ description: "When the outcome was recorded (event createdAt)." }),
        branch: z.string().meta({ description: "The branch the mirror push targeted." }),
        commitOid: z.string().nullable().meta({
          description:
            "The head that was pushed, or null when the push failed before resolving one.",
        }),
        error: z.string().nullable().meta({ description: "What went wrong, or null on success." }),
        ok: z.boolean().meta({ description: "Whether the newest mirror push succeeded." }),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "The NEWEST mirror-push outcome (completed, failed, or synced), for status surfaces; " +
          "cleared when the link changes.",
      }),
    remote: z.string().nullable().default(null).meta({
      description: "The backing artifact's Git remote URL, recorded by repo/ready.",
    }),
  }),
  events: {
    "events.iterate.com/repo/created": {
      description: "Creates a repo processor on this stream.",
      payloadSchema: repoBirthCertificateSchema(),
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
        artifactName: z.string().meta({ description: "The Cloudflare Artifacts repository name." }),
        defaultBranch: z
          .string()
          .meta({ description: "The branch commit and task facts derive from." }),
        path: z.string().meta({ description: "The repo's stream path." }),
        projectId: z
          .string()
          .nullable()
          .meta({ description: "Owning project, or null on a deployment-root repo." }),
        remote: z.string().meta({ description: "The artifact's Git remote URL." }),
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
          artifactName: z
            .string()
            .meta({ description: "The Artifacts repository the event is about." }),
          body: z.object({}).loose().meta({ description: "Cloudflare's event body, verbatim." }),
          cloudflareEventType: z
            .string()
            .optional()
            .meta({ description: "Cloudflare's event type, when the queue surfaced one." }),
          namespace: z.string().meta({ description: "The Artifacts namespace (per deployment)." }),
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
      payloadSchema: z.object({
        beforeCommitOid: z.string().trim().min(1).nullable().meta({
          description: "The branch head before the push, or null for a newly created ref.",
        }),
        branch: z.string().trim().min(1).meta({ description: "The branch that advanced." }),
        commitOid: z.string().trim().min(1).meta({ description: "The new branch head." }),
      }),
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
      payloadSchema: taskFileChangedSchema(),
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
      payloadSchema: taskFileChangedSchema(),
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
      payloadSchema: taskFileChangedSchema(),
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
      payloadSchema: githubLinkSchema(),
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
        connection: z.string().meta({ description: "The GitHub connection that was unlinked." }),
        owner: z.string().meta({ description: "GitHub owner of the unlinked repository." }),
        repo: z.string().meta({ description: "GitHub name of the unlinked repository." }),
        repositoryId: z
          .number()
          .int()
          .positive()
          .meta({ description: "GitHub's numeric repository id." }),
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
        branch: z.string().meta({ description: "The branch that was mirrored." }),
        commitOid: z.string().meta({ description: "The head that was pushed to GitHub." }),
        owner: z.string().meta({ description: "GitHub owner of the mirror target." }),
        repo: z.string().meta({ description: "GitHub name of the mirror target." }),
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
        branch: z.string().meta({ description: "The branch the push targeted." }),
        commitOid: z.string().nullable().meta({
          description: "The head being pushed, or null when the push failed before resolving one.",
        }),
        error: z.string().meta({ description: "What GitHub (or token minting) reported." }),
        owner: z.string().meta({ description: "GitHub owner of the mirror target." }),
        repo: z.string().meta({ description: "GitHub name of the mirror target." }),
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
        branch: z.string().meta({ description: "The branch that was synced." }),
        commitOid: z.string().meta({ description: "The adopted GitHub head." }),
        forced: z
          .boolean()
          .meta({ description: "True when diverged local history was overwritten." }),
        owner: z.string().meta({ description: "GitHub owner of the sync source." }),
        previousCommitOid: z.string().nullable().meta({
          description: "The local head before the sync, or null when the branch was empty.",
        }),
        repo: z.string().meta({ description: "GitHub name of the sync source." }),
        reset: z.boolean().optional().meta({
          description: "True when the artifact was destroyed and recreated (resetFromGithub).",
        }),
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
      payloadSchema: githubImportRequestSchema(),
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
      description:
        "The repo processor durably began a GitHub import attempt — journaled BEFORE the sync body runs, so an attempt that dies with its incarnation is visibly owed.",
      payloadSchema: githubImportRequestSchema(),
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
        branch: z.string().trim().min(1).meta({ description: "The imported branch." }),
        commitOid: z
          .string()
          .trim()
          .min(1)
          .meta({
            description:
              "The head Artifacts now holds — the CURRENT GitHub head, which may be newer than " +
              "the requested one (out-of-order deliveries are satisfied by any newer head).",
          }),
        requestId: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "The settled obligation's identity." }),
        requestedCommitOid: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "The head the original push delivery announced." }),
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
        branch: z.string().trim().min(1).meta({ description: "The branch the import targeted." }),
        error: z.string().meta({ description: "What the sync reported." }),
        requestId: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "The settled obligation's identity." }),
        requestedCommitOid: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "The head the original push delivery announced." }),
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
      payloadSchema: z
        .object({
          body: z
            .object({
              repository: z
                .object({
                  id: z
                    .number()
                    .int()
                    .positive()
                    .meta({ description: "GitHub's numeric repository id." }),
                })
                .loose()
                .meta({ description: "The repository the delivery is about." }),
            })
            .loose()
            .meta({ description: "GitHub's webhook body, verbatim." }),
          delivery: z.object({
            id: z
              .string()
              .trim()
              .min(1)
              .meta({ description: "GitHub's unique delivery id (X-GitHub-Delivery)." }),
            name: z
              .string()
              .trim()
              .min(1)
              .meta({ description: 'GitHub\'s event name (X-GitHub-Event), e.g. "push".' }),
          }),
          installationId: z
            .string()
            .trim()
            .min(1)
            .meta({ description: "The GitHub App installation the delivery was routed by." }),
        })
        .loose(),
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
    // The stream's own birth fact (core-owned): reduces `initialized`.
    "events.iterate.com/stream/created",
    // Core lifecycle RE-CHECK signals: neither reduces into state, but their
    // at-head delivery gives the state-derived pass a guaranteed
    // consumed-at-head turn — `stream/woken` on a stream (re)start,
    // `subscriber-connected` on a runner (re)attach. That extra turn is what
    // retries an obligation whose background append failed transiently while
    // the cursor already sat at head.
    "events.iterate.com/stream/woken",
    "events.iterate.com/stream/subscriber-connected",
    // The platform revival fact (core-owned). MUST be consumed (the runner
    // throws at construction otherwise): its ordinary delivery is the
    // guaranteed at-head turn where `processEvent` under `delivery.caughtUp`
    // re-drives the open obligations — an unseeded artifact is created, an
    // orphaned GitHub import is re-driven (the sync is an idempotent
    // current-head fast-forward).
    "events.iterate.com/stream/processor-revived",
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

/**
 * The immutable birth certificate — used twice (the repo/created payload and
 * the reduced state's birthCertificate slot). The nested config is reserved:
 * every existing stream carries `{}`.
 */
function repoBirthCertificateSchema() {
  return z.strictObject({
    config: z
      .strictObject({})
      .meta({ description: "Reserved for future repo configuration; always {} today." }),
  });
}

/**
 * The GitHub repository one repo mirrors to — used twice (the
 * repo/github-link-configured payload and the reduced state's github slot): a
 * named GitHub connection (the App installation whose token authenticates
 * pushes) plus the owner/repo coordinates.
 */
function githubLinkSchema() {
  return z.object({
    connection: z
      .string()
      .trim()
      .min(1)
      .meta({ description: "The named GitHub connection (App installation) minting tokens." }),
    installationId: z
      .string()
      .trim()
      .min(1)
      .meta({ description: "The GitHub App installation id webhook deliveries are routed by." }),
    owner: z.string().trim().min(1).meta({ description: "GitHub owner (org or user)." }),
    repo: z.string().trim().min(1).meta({ description: "GitHub repository name." }),
    repositoryId: z
      .number()
      .int()
      .positive()
      .meta({
        description:
          "GitHub's numeric repository id — the identity webhook deliveries are matched on " +
          "(names can be reused; ids cannot).",
      }),
  });
}

/** One task-file change on the default branch — used by all three
 * repo/task-created|updated|deleted facts. */
function taskFileChangedSchema() {
  return z.object({
    branch: z
      .string()
      .trim()
      .min(1)
      .meta({ description: "The branch the change landed on (always the default branch)." }),
    commitOid: z
      .string()
      .trim()
      .min(1)
      .meta({ description: "The commit that made the change durable." }),
    path: z.string().trim().min(1).meta({ description: "The task file's repo-relative path." }),
  });
}

/** The import obligation's coordinates — used twice (github-import-requested
 * opens the obligation; github-import-started marks a durable attempt). */
function githubImportRequestSchema() {
  return z.object({
    branch: z.string().trim().min(1).meta({ description: "The branch to import." }),
    requestId: z
      .string()
      .trim()
      .min(1)
      .meta({
        description:
          "The obligation's identity: the coordinates (path:offset) of the webhook event that " +
          "opened it — no synthetic ids.",
      }),
    requestedCommitOid: z
      .string()
      .trim()
      .min(1)
      .meta({ description: "The GitHub head the push delivery announced." }),
  });
}
