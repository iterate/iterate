// The repo processor CONTRACT. Self-contained: state schema, events,
// consumes/emits, deps — schemas are spelled INLINE in the contract; the
// schemas it genuinely uses twice (the creation request, the birth
// certificate, the creation failure, the GitHub link, the import-request
// coordinates) are hoisted functions defined below the contract, so the
// contract still opens the file.
//
// One stream per repo (`/repos/<name>`). The events tell the repo's whole
// story: the creation saga (`repos/create-requested` → `repos/created` |
// `repos/create-failed` — the terminal certificate carries the backing
// Cloudflare Artifacts coordinates), Git pushes observed through the
// Artifacts event queue (`repo/cloudflare-artifact-event-received` →
// `repo/commit-completed`), and the optional GitHub mirror: link lifecycle,
// mirror-push outcomes, and the durable default-branch import obligation
// (`github-import-requested/started/completed/failed`) opened by received
// GitHub push webhooks.

import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
import { isSafeConfigRepoTemplatePath } from "../../lib/config-repo-template-reference.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

export const RepoProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.8.0",
  description: "Projects repo lifecycle, Git activity, and linked GitHub default-branch imports.",
  stateSchema: z.object({
    createRequest: repoCreateRequestSchema().nullable().default(null).meta({
      description:
        "The durable creation intent, from repos/create-requested; null until the saga opens.",
    }),
    createFailure: repoCreateFailureSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "The terminal creation failure, from repos/create-failed; a failed repo is closed for " +
          "good (fail-closed) — nothing else ever reacts on its stream.",
      }),
    birthCertificate: repoBirthCertificateSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until repos/created reduces; then the exact terminal " +
          "certificate — the creation request plus the backing Artifacts coordinates.",
      }),
    artifactName: z.string().nullable().default(null).meta({
      description: "The backing Cloudflare Artifacts repository name, recorded by repos/created.",
    }),
    defaultBranch: z
      .string()
      .nullable()
      .default(null)
      .meta({
        description:
          "The branch whose pushes produce commit-completed and task facts. Set to main the " +
          "moment create-requested reduces (every creation mode targets main), confirmed by " +
          "repos/created.",
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
      description: "The backing artifact's Git remote URL, recorded by repos/created.",
    }),
    templateSource: resolvedGithubTemplateSourceSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "The immutable source commit selected for a GitHub config-template request. " +
          "Journaled before any file body is fetched so recovery never follows a moved ref.",
      }),
  }),
  events: {
    "events.iterate.com/repos/create-requested": {
      description:
        "Requests the repo creation saga: seed an empty repo, copy a public GitHub template " +
        "subtree, import a private GitHub repo at depth one, or import a public GitHub repo " +
        "through Cloudflare Artifacts (full history unless depth is set). Terminates in " +
        "repos/created or repos/create-failed.",
      payloadSchema: repoCreateRequestSchema(),
    },
    "events.iterate.com/repos/template-source-resolved": {
      description:
        "Locks a public GitHub template request to one immutable source commit before file " +
        "materialization begins. This is provenance for a one-time copy, not a GitHub link.",
      payloadSchema: resolvedGithubTemplateSourceSchema(),
    },
    "events.iterate.com/repos/created": {
      description:
        "The repo creation saga completed and its backing Artifact is ready — the repo's birth certificate.",
      payloadSchema: repoBirthCertificateSchema(),
    },
    "events.iterate.com/repos/create-failed": {
      description:
        "The repo creation saga reached a terminal failure and did not declare the repo created. Fail-closed: nothing else ever reacts on a failed repo's stream.",
      payloadSchema: repoCreateFailureSchema(),
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
    },
    "events.iterate.com/repo/commit-completed": {
      description:
        "The repo's default branch advanced. OS-owned writes append this fact directly; Cloudflare Artifacts pushed events normalize external Git writes into the same fact.",
      payloadSchema: z.object({
        beforeCommitOid: z.string().trim().min(1).nullable().meta({
          description: "The branch head before the push, or null for a newly created ref.",
        }),
        branch: z.string().trim().min(1).meta({ description: "The branch that advanced." }),
        commitOid: z.string().trim().min(1).meta({ description: "The new branch head." }),
      }),
    },
    "events.iterate.com/repo/github-link-configured": {
      description:
        "The repo was linked to a GitHub repository (mirror commits out and import fast-forward default-branch pushes).",
      payloadSchema: githubLinkSchema(),
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
    },
    "events.iterate.com/repo/github-push-completed": {
      description: "A mirror push delivered the branch head to the linked GitHub repository.",
      payloadSchema: z.object({
        branch: z.string().meta({ description: "The branch that was mirrored." }),
        commitOid: z.string().meta({ description: "The head that was pushed to GitHub." }),
        owner: z.string().meta({ description: "GitHub owner of the mirror target." }),
        repo: z.string().meta({ description: "GitHub name of the mirror target." }),
      }),
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
    },
    "events.iterate.com/repo/github-import-requested": {
      description: "A linked GitHub default-branch push opened a durable import obligation.",
      payloadSchema: githubImportRequestSchema(),
    },
    "events.iterate.com/repo/github-import-started": {
      description:
        "The repo processor durably began a GitHub import attempt — journaled BEFORE the sync body runs, so an attempt that dies with its incarnation is visibly owed.",
      payloadSchema: githubImportRequestSchema(),
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
    },
    "events.iterate.com/github/webhook-received": {
      description:
        "One GitHub push delivery, captured as decoded JSON on the connection stream and copied here by the repo's linkGithub subscription. The trusted envelope is structural while the vendor body stays loose.",
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
    },
  },
  processorDeps: [CoreProcessorContract],
  consumes: [
    "events.iterate.com/repos/create-requested",
    "events.iterate.com/repos/template-source-resolved",
    "events.iterate.com/repos/created",
    "events.iterate.com/repos/create-failed",
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
    // Recovery's eventless at-head pass re-drives open creation and GitHub
    // import obligations without consuming the platform revival fact.
  ],
  emits: [
    "events.iterate.com/repos/template-source-resolved",
    "events.iterate.com/repos/created",
    "events.iterate.com/repos/create-failed",
    "events.iterate.com/repo/commit-completed",
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
 * The creation request's TYPE, derived from the contract. The runtime schema
 * is reached through the contract:
 * `RepoProcessorContract.events["events.iterate.com/repos/create-requested"].payloadSchema`.
 */
export type RepoCreateRequest = z.output<
  RepoProcessorContract["events"]["events.iterate.com/repos/create-requested"]["payloadSchema"]
>;

/**
 * The creation request — the whole saga's durable intent. Used four times:
 * the create-requested payload, inside the birth certificate and the failure
 * record, and the reduced state's createRequest slot.
 */
function repoCreateRequestSchema() {
  return z.discriminatedUnion("type", [
    z
      .strictObject({
        type: z.literal("empty"),
      })
      .meta({ description: "Seed a fresh repo with iterate's starter files." }),
    z
      .strictObject({
        type: z.literal("github-public-template"),
        owner: z.string().trim().min(1).meta({ description: "GitHub owner (org or user)." }),
        path: z
          .string()
          .trim()
          .min(1)
          .refine(isSafeConfigRepoTemplatePath, {
            error: "Template path must stay within the public repository and outside .git.",
          })
          .optional()
          .meta({ description: "Repository-relative directory copied as the new repo root." }),
        ref: z.string().trim().min(1).optional().meta({
          description: "Branch, tag, or commit to resolve once; default branch if omitted.",
        }),
        repo: z.string().trim().min(1).meta({ description: "GitHub repository name." }),
      })
      .meta({
        description:
          "Copy one public GitHub repository subtree at a commit resolved during the durable " +
          "creation saga into a fresh Artifact root commit.",
      }),
    z
      .strictObject({
        type: z.literal("github-private"),
        connection: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "The named GitHub connection (App installation) minting tokens." }),
        owner: z.string().trim().min(1).meta({ description: "GitHub owner (org or user)." }),
        repo: z.string().trim().min(1).meta({ description: "GitHub repository name." }),
      })
      .meta({
        description:
          "Seed an empty Artifact, link the GitHub repository, then pull its default branch " +
          "through the Worker at depth one.",
      }),
    z
      .strictObject({
        type: z.literal("github-public"),
        connection: z
          .string()
          .trim()
          .min(1)
          .optional()
          .meta({
            description:
              "Optional named GitHub connection (App installation) to link after the import — " +
              "enables webhook ingestion and sync. Omit for a plain public clone (Artifacts " +
              "clones public repos unauthenticated; link later with linkGithub).",
          }),
        depth: z.number().int().positive().optional().meta({
          description:
            "Shallow-import depth; omit to let Cloudflare Artifacts import the full history.",
        }),
        owner: z.string().trim().min(1).meta({ description: "GitHub owner (org or user)." }),
        repo: z.string().trim().min(1).meta({ description: "GitHub repository name." }),
      })
      .meta({
        description:
          "Have Cloudflare Artifacts clone the public GitHub repository directly (no transfer " +
          "through the Worker), then link it when a connection is given.",
      }),
  ]);
}

function resolvedGithubTemplateSourceSchema() {
  return z.strictObject({
    branch: z.string().trim().min(1).optional().meta({
      description:
        "Advertised source branch eligible for a server-side shallow import; omitted for tags and commits.",
    }),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .meta({ description: "Immutable source commit selected from the requested ref." }),
    owner: z.string().trim().min(1).meta({ description: "GitHub owner from the request." }),
    path: z.string().trim().min(1).optional().meta({
      description: "Repository-relative source directory, or omitted for the repository root.",
    }),
    ref: z.string().trim().min(1).optional().meta({
      description: "Requested branch, tag, or commit; omitted when the default branch was used.",
    }),
    repo: z.string().trim().min(1).meta({ description: "GitHub repository from the request." }),
  });
}

/**
 * The terminal birth certificate — used twice (the repos/created payload and
 * the reduced state's birthCertificate slot): the creation request plus the
 * backing Cloudflare Artifacts coordinates the saga established.
 */
function repoBirthCertificateSchema() {
  return z.strictObject({
    request: repoCreateRequestSchema().meta({
      description: "The creation request this certificate settles.",
    }),
    artifactName: z
      .string()
      .trim()
      .min(1)
      .meta({ description: "The Cloudflare Artifacts repository name." }),
    defaultBranch: z
      .string()
      .trim()
      .min(1)
      .meta({ description: "The branch commit and task facts derive from." }),
    remote: z.string().url().meta({ description: "The artifact's Git remote URL." }),
    seededHead: z
      .strictObject({
        branch: z.string().trim().min(1),
        commitOid: z.string().trim().min(1),
        contentHash: z.string().trim().min(1),
      })
      .optional()
      .meta({
        description:
          "The deterministic creation push, when seeding happened outside the Repo actor. " +
          "Its consumed fact establishes the actor's read-your-write floor before birth.",
      }),
  });
}

/** The terminal creation failure — used twice (the repos/create-failed
 * payload and the reduced state's createFailure slot). */
function repoCreateFailureSchema() {
  return z.strictObject({
    error: z
      .string()
      .trim()
      .min(1)
      .meta({ description: "What the failed creation attempt reported." }),
    request: repoCreateRequestSchema().meta({
      description: "The creation request that failed.",
    }),
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
