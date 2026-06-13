// Implements the "repo" processor — where the repo's LOGIC lives, including
// its GITHUB REMOTES. Hosted on RepoDurableObject (the host supplies the one
// capability only it has: pulling file contents from GitHub and committing
// them to the artifact repo).
//
// A remote is journaled configuration: `repo/remote-configured` declares
// "this repo mirrors github owner/name (via integration account X), pull on
// push / push on push". The reactions are all stream-processor land:
//
//   remote-configured ──▶ `github/repo-route-configured` appended to the
//                         github ACCOUNT stream, so the github-route
//                         processor forwards that repository's webhooks HERE
//   integration/event-received (a push to the linked default branch, pull
//                         policy "auto") ──▶ `repo/remote-sync-requested`
//   remote-sync-requested ──▶ host dep pulls the changed files from GitHub
//                         (chain-fetched with a placeholder token — the repo
//                         never holds credentials) and commits them to the
//                         artifact ──▶ `repo/remote-synced` | `repo/remote-sync-failed`
//   repo/remote-push-requested ──▶ host dep pushes the artifact to GitHub
//                         (the reverse mirror; the seam exists, transport
//                         lands with the workspace-git wiring)
//
// Every reaction is idempotency-keyed from its source event; replays dedupe.

import { z } from "zod";
import type { PushEvent } from "@octokit/webhooks-types";
import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import {
  assertNever,
  buildProcessorIdempotencyKey,
  defineProcessorContract,
} from "@iterate-com/streams/shared/stream-processors";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { GithubRouteProcessorContract } from "~/domains/integrations/stream-processors/github-route/contract.ts";
import {
  IntegrationEventReceivedPayload,
  integrationAccountStreamPath,
} from "~/domains/integrations/integration-events.ts";

export function repoStreamPath(repoSlug: string) {
  return StreamPath.parse(`/repos/${repoSlug}`);
}

export const RepoRemote = z.object({
  provider: z.literal("github"),
  /** The integration ACCOUNT whose installation/token covers this repo. */
  account: z.string(),
  owner: z.string(),
  repo: z.string(),
  /** Branch to mirror; defaults to the webhook's repository.default_branch. */
  branch: z.string().optional(),
  sync: z.object({
    /** "auto": a GitHub push to the branch syncs the artifact. */
    pull: z.enum(["auto", "manual"]).default("auto"),
    /** "auto": an artifact push mirrors back to GitHub (transport pending). */
    push: z.enum(["auto", "manual"]).default("manual"),
  }),
});
export type RepoRemote = z.infer<typeof RepoRemote>;

export function repoRemoteKey(remote: Pick<RepoRemote, "owner" | "repo">): string {
  return `github:${remote.owner}/${remote.repo}`.toLowerCase();
}

export const RepoStreamProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.2.0",
  description:
    "Tracks Repo lifecycle facts, Git access state, and GitHub remotes — and reacts to linked repositories' webhooks by mirroring.",
  stateSchema: z.object({
    repo: z
      .object({
        defaultBranch: z.string().trim().min(1),
        remote: z.string().url(),
        slug: z.string().trim().min(1),
        tokenExpiresAt: z.iso.datetime().nullable(),
      })
      .nullable()
      .default(null),
    /** Configured GitHub remotes, keyed by repoRemoteKey (last write wins). */
    remotes: z.record(z.string(), RepoRemote).default({}),
    lastSync: z
      .object({
        headSha: z.string(),
        at: z.string(),
        status: z.enum(["synced", "failed"]),
        reason: z.string().optional(),
      })
      .optional(),
  }),
  initialState: {
    repo: null,
  },
  // github-route owns `github/repo-route-configured`, which this processor
  // emits onto the github account stream when a remote is configured.
  processorDeps: [GithubRouteProcessorContract],
  events: {
    "events.iterate.com/repo/created": {
      description: "A Repo was created and its initial Git access details were recorded.",
      payloadSchema: z.object({
        defaultBranch: z.string().trim().min(1),
        remote: z.string().url(),
        slug: z.string().trim().min(1),
        tokenExpiresAt: z.iso.datetime().nullable(),
      }),
    },
    "events.iterate.com/repo/remote-configured": {
      description:
        "Links this repo to a GitHub repository (a REMOTE with a sync policy). The processor reacts by registering the webhook route on the github account stream.",
      payloadSchema: RepoRemote,
    },
    "events.iterate.com/integration/event-received": {
      description:
        "A GitHub webhook about a LINKED repository, forwarded here by the github-route processor.",
      payloadSchema: IntegrationEventReceivedPayload,
    },
    "events.iterate.com/repo/remote-sync-requested": {
      description:
        "Fresh commits exist on the linked GitHub branch (a push webhook, or a manual request). The processor reacts by pulling the changed files into the artifact.",
      payloadSchema: z.object({
        remoteKey: z.string(),
        headSha: z.string(),
        /** Net changed paths across the push's commits, in order. */
        changedPaths: z.array(z.object({ path: z.string(), change: z.enum(["upsert", "delete"]) })),
      }),
    },
    "events.iterate.com/repo/remote-synced": {
      description: "The artifact now mirrors the linked branch at headSha.",
      payloadSchema: z.object({
        remoteKey: z.string(),
        headSha: z.string(),
        commitOid: z.string().nullable(),
        at: z.string(),
      }),
    },
    "events.iterate.com/repo/remote-sync-failed": {
      description: "A mirror attempt failed; the journal keeps the reason.",
      payloadSchema: z.object({
        remoteKey: z.string(),
        headSha: z.string(),
        reason: z.string(),
        at: z.string(),
      }),
    },
    "events.iterate.com/repo/remote-push-requested": {
      description:
        "Mirror the artifact OUT to the linked GitHub repository (the reverse direction; transport lands with workspace-git wiring).",
      payloadSchema: z.object({ remoteKey: z.string() }),
    },
  },
  consumes: [
    "events.iterate.com/repo/created",
    "events.iterate.com/repo/remote-configured",
    "events.iterate.com/integration/event-received",
    "events.iterate.com/repo/remote-sync-requested",
    "events.iterate.com/repo/remote-synced",
    "events.iterate.com/repo/remote-sync-failed",
    "events.iterate.com/repo/remote-push-requested",
  ],
  emits: [
    "events.iterate.com/github/repo-route-configured",
    "events.iterate.com/github/repo-route-removed",
    "events.iterate.com/repo/remote-sync-requested",
    "events.iterate.com/repo/remote-synced",
    "events.iterate.com/repo/remote-sync-failed",
  ],
});

export type RepoStreamProcessorContract = typeof RepoStreamProcessorContract;

export type RepoReducedState = z.infer<typeof RepoStreamProcessorContract.stateSchema>;

export type RepoStreamProcessorDeps = {
  /**
   * Pull the changed files from GitHub at headSha (chain-fetched with the
   * account's placeholder token — material never enters the repo host) and
   * commit them to the artifact. Host-supplied (RepoDurableObject).
   */
  pullFromGithub?(input: {
    remote: RepoRemote;
    headSha: string;
    changedPaths: { path: string; change: "upsert" | "delete" }[];
  }): Promise<{ commitOid: string | null }>;
  /** The reverse mirror (artifact → GitHub). Seam only in the spike. */
  pushToGithub?(input: { remote: RepoRemote }): Promise<void>;
};

export class RepoStreamProcessor extends StreamProcessor<
  RepoStreamProcessorContract,
  RepoStreamProcessorDeps
> {
  readonly contract = RepoStreamProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<RepoStreamProcessorContract>["reduce"]>[0],
  ): RepoReducedState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/repo/created":
        return { ...state, repo: event.payload };
      case "events.iterate.com/repo/remote-configured":
        return {
          ...state,
          remotes: { ...state.remotes, [repoRemoteKey(event.payload)]: event.payload },
        };
      case "events.iterate.com/repo/remote-synced":
        return {
          ...state,
          lastSync: { headSha: event.payload.headSha, at: event.payload.at, status: "synced" },
        };
      case "events.iterate.com/repo/remote-sync-failed":
        return {
          ...state,
          lastSync: {
            headSha: event.payload.headSha,
            at: event.payload.at,
            status: "failed",
            reason: event.payload.reason,
          },
        };
      case "events.iterate.com/integration/event-received":
      case "events.iterate.com/repo/remote-sync-requested":
      case "events.iterate.com/repo/remote-push-requested":
        return state;
      default:
        return assertNever(event);
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<RepoStreamProcessorContract>["processEvent"]>[0],
  ): void {
    const { event, state } = args;

    // Linking a remote registers the webhook route on the github account
    // stream — github-route forwards that repository's events here from then on.
    if (event.type === "events.iterate.com/repo/remote-configured") {
      const remote = event.payload;
      const slug = state.repo?.slug;
      if (slug == null) return;
      // Reconfiguring the SAME repo (key is owner/repo) onto a DIFFERENT github
      // account moves the route. Release the link on the prior account first,
      // or its github-route fold keeps forwarding this repository's webhooks
      // here after the remote fold has moved on.
      const prior = args.previousState.remotes[repoRemoteKey(remote)];
      const movedAccount = prior != null && prior.account !== remote.account ? prior : null;
      args.blockProcessorWhile(async () => {
        if (movedAccount != null) {
          await this.ctx.stream.append({
            streamPath: integrationAccountStreamPath("github", movedAccount.account),
            event: {
              type: "events.iterate.com/github/repo-route-removed",
              idempotencyKey: `github-repo-route-removed:${repoRemoteKey(remote)}:${slug}:${movedAccount.account}`,
              payload: {
                fullName: `${movedAccount.owner}/${movedAccount.repo}`,
                repoStreamPath: repoStreamPath(slug),
              },
            },
          });
        }
        await this.ctx.stream.append({
          streamPath: integrationAccountStreamPath("github", remote.account),
          event: {
            type: "events.iterate.com/github/repo-route-configured",
            idempotencyKey: `github-repo-route:${repoRemoteKey(remote)}:${slug}`,
            payload: {
              fullName: `${remote.owner}/${remote.repo}`,
              repoStreamPath: repoStreamPath(slug),
            },
          },
        });
      });
      return;
    }

    // A forwarded GitHub webhook: a push to the mirrored branch of an
    // auto-pull remote becomes a sync request (a fact, so retries dedupe and
    // the journal shows WHY the artifact changed).
    if (event.type === "events.iterate.com/integration/event-received") {
      const push = parseGithubPush(event.payload.body);
      if (push == null) return;
      const remote = state.remotes[`github:${push.fullName}`.toLowerCase()];
      if (remote == null || remote.sync.pull !== "auto") return;
      const branch = remote.branch ?? push.defaultBranch;
      if (push.ref !== `refs/heads/${branch}`) return;
      args.blockProcessorWhile(async () => {
        await this.ctx.stream.append({
          event: {
            type: "events.iterate.com/repo/remote-sync-requested",
            idempotencyKey: buildProcessorIdempotencyKey({
              processor: this.contract,
              key: "sync-request",
              sourceEvent: event,
            }),
            payload: {
              remoteKey: repoRemoteKey(remote),
              headSha: push.headSha,
              changedPaths: push.changedPaths,
            },
          },
        });
      });
      return;
    }

    if (event.type === "events.iterate.com/repo/remote-sync-requested") {
      const remote = state.remotes[event.payload.remoteKey];
      args.blockProcessorWhile(async () => {
        const outcome = await this.attemptPull(remote, event.payload);
        await this.ctx.stream.append({
          event: {
            ...outcome,
            idempotencyKey: buildProcessorIdempotencyKey({
              processor: this.contract,
              key: "sync-outcome",
              sourceEvent: event,
            }),
          },
        });
      });
      return;
    }

    if (event.type === "events.iterate.com/repo/remote-push-requested") {
      const remote = state.remotes[event.payload.remoteKey];
      if (remote == null || this.deps.pushToGithub == null) return;
      args.runInBackground(async () => {
        await this.deps.pushToGithub?.({ remote });
      });
    }
  }

  private async attemptPull(
    remote: RepoRemote | undefined,
    request: {
      remoteKey: string;
      headSha: string;
      changedPaths: { path: string; change: "upsert" | "delete" }[];
    },
  ) {
    const base = { remoteKey: request.remoteKey, headSha: request.headSha };
    if (remote == null) {
      return {
        type: "events.iterate.com/repo/remote-sync-failed" as const,
        payload: { ...base, reason: "remote is not configured", at: new Date().toISOString() },
      };
    }
    if (this.deps.pullFromGithub == null) {
      return {
        type: "events.iterate.com/repo/remote-sync-failed" as const,
        payload: {
          ...base,
          reason: "host has no pullFromGithub dep",
          at: new Date().toISOString(),
        },
      };
    }
    try {
      const { commitOid } = await this.deps.pullFromGithub({
        remote,
        headSha: request.headSha,
        changedPaths: request.changedPaths,
      });
      return {
        type: "events.iterate.com/repo/remote-synced" as const,
        payload: { ...base, commitOid, at: new Date().toISOString() },
      };
    } catch (error) {
      return {
        type: "events.iterate.com/repo/remote-sync-failed" as const,
        payload: {
          ...base,
          reason: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        },
      };
    }
  }
}

/**
 * Net file changes across a push's commits, in commit order — last change to
 * a path wins, so add-then-delete nets to delete and vice versa. Typed by
 * GitHub's OFFICIAL webhook types (@octokit/webhooks-types); the runtime
 * guard only checks the push discriminants since the body arrived from
 * GitHub's signed webhook.
 */
function parseGithubPush(body: unknown): {
  fullName: string;
  ref: string;
  headSha: string;
  defaultBranch: string;
  changedPaths: { path: string; change: "upsert" | "delete" }[];
} | null {
  if (!isGithubPushEvent(body)) return null;

  const net = new Map<string, "upsert" | "delete">();
  for (const commit of body.commits) {
    for (const path of [...commit.added, ...commit.modified]) net.set(path, "upsert");
    for (const path of commit.removed) net.set(path, "delete");
  }
  if (net.size === 0) return null;

  return {
    fullName: body.repository.full_name,
    ref: body.ref,
    headSha: body.after,
    defaultBranch: body.repository.default_branch ?? "main",
    changedPaths: [...net.entries()].map(([path, change]) => ({ path, change })),
  };
}

function isGithubPushEvent(body: unknown): body is PushEvent {
  if (body == null || typeof body !== "object") return false;
  const candidate = body as Partial<PushEvent>;
  return (
    typeof candidate.ref === "string" &&
    typeof candidate.after === "string" &&
    Array.isArray(candidate.commits) &&
    typeof candidate.repository?.full_name === "string"
  );
}
