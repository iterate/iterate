import type { ProcessorEvent } from "../streams/processor-contracts.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";
import { githubAgentSubscriptionConfiguredEvent } from "./github-agent-mechanics.ts";
import { githubAgentPath, pullRequestNumbersFromWebhookBody } from "./github-agent-utils.ts";
import {
  repoArtifactPushFromEventPayload,
  repoGithubPushFromWebhookPayload,
  type RepoCommittedFileChange,
} from "./repo-task-events.ts";

/** The one event this processor acts on, narrowed from the contract by its type string. */
type RepoCreateRequested = ProcessorEvent<
  RepoProcessorContract,
  "events.iterate.com/repo/create-requested"
>;

type RepoProcessorDeps = {
  createRepoArtifact(input: { path: string; projectId: string | null }): Promise<{
    artifactName: string;
    defaultBranch: string;
    remote: string;
  }>;
  taskChangesForArtifactPush(input: {
    afterCommitOid: string | null;
    beforeCommitOid: string | null;
    branch: string;
  }): Promise<RepoCommittedFileChange[]>;
  syncFromGithubPush(input: {
    afterCommitOid: string;
    branch: string;
  }): Promise<{ commitOid: string }>;
};

export class RepoProcessor extends StreamProcessor<RepoProcessorContract, RepoProcessorDeps> {
  readonly contract = RepoProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<RepoProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/repo/create-requested":
        return { ...state, createRequested: true };
      case "events.iterate.com/repo/created":
        return {
          ...state,
          artifactName: event.payload.artifactName,
          created: true,
          defaultBranch: event.payload.defaultBranch,
          remote: event.payload.remote,
        };
      case "events.iterate.com/repo/github-link-configured":
        return { ...state, github: event.payload, githubImport: null, lastGithubPush: null };
      case "events.iterate.com/repo/github-unlinked":
        return { ...state, github: null, githubImport: null, lastGithubPush: null };
      case "events.iterate.com/repo/github-push-completed":
        return {
          ...state,
          lastGithubPush: {
            at: event.createdAt,
            branch: event.payload.branch,
            commitOid: event.payload.commitOid,
            error: null,
            ok: true,
          },
        };
      case "events.iterate.com/repo/github-push-failed":
        return {
          ...state,
          lastGithubPush: {
            at: event.createdAt,
            branch: event.payload.branch,
            commitOid: event.payload.commitOid,
            error: event.payload.error,
            ok: false,
          },
        };
      case "events.iterate.com/repo/github-synced":
        return {
          ...state,
          lastGithubPush: {
            at: event.createdAt,
            branch: event.payload.branch,
            commitOid: event.payload.commitOid,
            error: null,
            ok: true,
          },
        };
      case "events.iterate.com/repo/github-import-requested":
        return {
          ...state,
          githubImport: { ...event.payload, status: "requested" as const },
        };
      case "events.iterate.com/repo/github-import-started":
        return state.githubImport?.requestId === event.payload.requestId
          ? {
              ...state,
              githubImport: { ...state.githubImport, status: "started" as const },
            }
          : state;
      case "events.iterate.com/repo/github-import-completed":
      case "events.iterate.com/repo/github-import-failed":
        return state.githubImport?.requestId === event.payload.requestId
          ? { ...state, githubImport: null }
          : state;
      case "events.iterate.com/stream/created":
        return { ...state, initialized: true };
      default:
        return state;
    }
  }

  protected override processEvent({
    blockProcessorWhile,
    event,
    state,
    append,
    appendTo,
  }: Parameters<StreamProcessor<RepoProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type === "events.iterate.com/repo/cloudflare-artifact-event-received") {
      const push = repoArtifactPushFromEventPayload(event.payload);
      const commitOid = push?.afterCommitOid;
      if (
        push === null ||
        commitOid === null ||
        commitOid === undefined ||
        state.defaultBranch === null ||
        push.branch !== state.defaultBranch
      ) {
        return;
      }
      blockProcessorWhile(async () => {
        await append({
          type: "events.iterate.com/repo/commit-completed",
          idempotencyKey: this.idempotencyKey(
            `commit-completed:${push.beforeCommitOid ?? "none"}:${commitOid}:${push.branch}`,
          ),
          payload: {
            beforeCommitOid: push.beforeCommitOid,
            branch: push.branch,
            commitOid,
          },
        });
      });
      return;
    }

    if (event.type === "events.iterate.com/repo/commit-completed") {
      if (state.defaultBranch === null || event.payload.branch !== state.defaultBranch) return;
      blockProcessorWhile(async () => {
        const taskChanges = await this.deps.taskChangesForArtifactPush({
          afterCommitOid: event.payload.commitOid,
          beforeCommitOid: event.payload.beforeCommitOid,
          branch: event.payload.branch,
        });
        if (taskChanges.length === 0) return;
        await append(
          ...taskChanges.map((change) => ({
            type: `events.iterate.com/repo/task-${change.kind}` as
              | "events.iterate.com/repo/task-created"
              | "events.iterate.com/repo/task-updated"
              | "events.iterate.com/repo/task-deleted",
            idempotencyKey: this.idempotencyKey(
              `task-${change.kind}:${event.payload.beforeCommitOid ?? "none"}:${event.payload.commitOid}:${change.path}`,
            ),
            payload: {
              branch: event.payload.branch,
              commitOid: event.payload.commitOid,
              path: change.path,
            },
          })),
        );
      });
      return;
    }

    if (event.type === "events.iterate.com/github/webhook-received") {
      const push = repoGithubPushFromWebhookPayload(event.payload);
      if (
        push !== null &&
        state.github !== null &&
        state.defaultBranch !== null &&
        push.branch === state.defaultBranch
      ) {
        // GitHub is an ingress lane, not a second source of commit facts. The
        // webhook opens an obligation; the at-head reconciler imports GitHub
        // without holding the stream checkpoint. The resulting Artifacts
        // queue event remains the ONLY source of commit-completed/task facts.
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/repo/github-import-requested",
            idempotencyKey: this.idempotencyKey("github-import-requested", event),
            payload: {
              branch: push.branch,
              requestId: `${event.path}:${event.offset}`,
              requestedCommitOid: push.afterCommitOid,
            },
          }),
        );
      }

      // PR webhooks route to a per-PR agent stream, everything else (pushes,
      // stars, plain issues) stays a repo-stream fact. The first forward's
      // route event births the agent (child-stream-created lane) and durably
      // records which PR it serves; idempotency keys make replays and repeat
      // deliveries fold to nothing.
      const prNumbers = pullRequestNumbersFromWebhookBody(
        (event.payload as { body?: unknown }).body,
      );
      const github = state.github;
      if (prNumbers.length === 0 || github === null) return;
      const projectId = this.projectId;
      if (projectId === null) {
        throw new Error(`GitHub PR routing requires a project-scoped repo: ${this.path}`);
      }
      // Durable obligation, not best-effort: this forward is the webhook's
      // only path to the PR agent (the Slack router once lost a message to a
      // fire-and-forget append). A check/workflow delivery may name several
      // PRs, so every target append belongs to the same held obligation.
      // blockProcessorWhile holds the checkpoint so a failed append replays;
      // the keys below dedupe each target's replay.
      blockProcessorWhile(async () => {
        await Promise.all(
          prNumbers.map(async (prNumber) => {
            const streamPath = await githubAgentPath(
              {
                installationId: github.installationId,
                owner: github.owner,
                repo: github.repo,
                repoPath: this.path,
              },
              prNumber,
            );
            // The key carries the FULL GitHub coordinates, not just the PR
            // number: relinking the repo to a different repository or
            // connection must repoint existing PR agents.
            await appendTo(
              streamPath,
              {
                type: "events.iterate.com/github-agent/route-configured" as const,
                idempotencyKey: this.idempotencyKey(
                  `github-agent-route:${github.installationId}:${github.connection}:${github.owner}/${github.repo}:${prNumber}`,
                ),
                payload: {
                  ...github,
                  number: prNumber,
                  repoPath: this.path,
                  streamPath,
                },
              },
              githubAgentSubscriptionConfiguredEvent({
                agentPath: streamPath,
                projectId,
              }),
              {
                type: "events.iterate.com/github/webhook-received" as const,
                idempotencyKey: this.idempotencyKey("pr-forward", event),
                payload: event.payload,
              },
            );
          }),
        );
      });
      return;
    }

    if (event.type !== "events.iterate.com/repo/create-requested") return;
    // Address validation stays per-event (a mis-addressed request is a loud
    // error); the creation itself is reconciled from the at-head fold in
    // processEventBatch.
    this.#assertOwnCreateRequest(event);
  }

  /**
   * Creation is an OBLIGATION reconciled from the at-head fold, never a
   * per-event reaction: a journal refold (the normal aftermath of a
   * state-schema deploy) replays `create-requested` with event-time state in
   * which `created` is still false, but the at-head fold has already absorbed
   * the journaled `repo/created` fact — so `createRepoArtifact`, whose seeding
   * force-pushes the seed commit and would clobber user commits, provably
   * never re-runs. No expiry on purpose: "this repo should exist" does not go
   * stale, and the vendor call is idempotent (get-or-create + re-seed of a
   * fresh repo folds to a no-op), so a create-succeeded/append-failed retry is
   * safe.
   */
  protected override async processEventBatch(
    args: Parameters<StreamProcessor<RepoProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await super.processEventBatch(args);
    if (args.checkpointOffset < args.streamMaxOffset) return;
    if (!args.state.createRequested || args.state.created) return;
    args.blockProcessorWhile(async () => {
      const payload = await this.deps.createRepoArtifact({
        path: this.path,
        projectId: this.projectId,
      });
      await args.append({
        type: "events.iterate.com/repo/created",
        idempotencyKey: this.idempotencyKey("created"),
        payload: {
          ...payload,
          path: this.path,
          projectId: this.projectId,
        },
      });
    });
  }

  /** GitHub imports can involve two network services and a git transfer, so
   * they are durable obligations rather than checkpoint-blocking webhook
   * reactions. A refold sees the terminal event and does nothing; an eviction
   * that leaves a requested/started obligation open safely re-drives the
   * idempotent current-head sync. A vendor failure is journaled and closes the
   * attempt instead of wedging every later repo event. */
  readonly #liveGithubImports = new Set<string>();

  protected override async reconcile(
    args: Parameters<StreamProcessor<RepoProcessorContract>["reconcile"]>[0],
  ): Promise<void> {
    const request = args.state.githubImport;
    if (request === null || this.#liveGithubImports.has(request.requestId)) return;

    this.#liveGithubImports.add(request.requestId);
    args.runInBackground(async () => {
      try {
        // The started fact must land before the vendor body runs. If this
        // append fails, the open requested obligation remains retryable and
        // the sync is deliberately not called.
        await args.append({
          type: "events.iterate.com/repo/github-import-started",
          idempotencyKey: this.idempotencyKey(`github-import-started:${request.requestId}`),
          payload: {
            branch: request.branch,
            requestId: request.requestId,
            requestedCommitOid: request.requestedCommitOid,
          },
        });

        let result: { commitOid: string };
        try {
          result = await this.deps.syncFromGithubPush({
            afterCommitOid: request.requestedCommitOid,
            branch: request.branch,
          });
        } catch (error) {
          await args.append({
            type: "events.iterate.com/repo/github-import-failed",
            idempotencyKey: this.idempotencyKey(`github-import-failed:${request.requestId}`),
            payload: {
              branch: request.branch,
              error: String(error),
              requestId: request.requestId,
              requestedCommitOid: request.requestedCommitOid,
            },
          });
          return;
        }

        await args.append({
          type: "events.iterate.com/repo/github-import-completed",
          idempotencyKey: this.idempotencyKey(`github-import-completed:${request.requestId}`),
          payload: {
            branch: request.branch,
            commitOid: result.commitOid,
            requestId: request.requestId,
            requestedCommitOid: request.requestedCommitOid,
          },
        });
      } finally {
        this.#liveGithubImports.delete(request.requestId);
      }
    });
  }

  /** Reject a create-requested addressed to a different repo than this processor serves. */
  #assertOwnCreateRequest(event: RepoCreateRequested): void {
    if (event.payload.projectId !== this.projectId || event.payload.path !== this.path) {
      throw new Error(
        `repo/create-requested for "${event.payload.projectId}:${event.payload.path}" on repo "${this.projectId}:${this.path}"`,
      );
    }
  }
}
