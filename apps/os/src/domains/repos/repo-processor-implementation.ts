import { StreamProcessor } from "../streams/stream-processor.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";
import { githubAgentCreationEvents } from "./github-agent-mechanics.ts";
import { githubAgentPath, pullRequestNumbersFromWebhookBody } from "./github-agent-utils.ts";
import {
  repoArtifactPushFromEventPayload,
  repoGithubPushFromWebhookPayload,
  type RepoCommittedFileChange,
} from "./repo-task-events.ts";

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
      case "events.iterate.com/repo/created":
        if (state.birthCertificate !== null) {
          throw new Error("repo received more than one created event");
        }
        return { ...state, birthCertificate: event.payload };
      case "events.iterate.com/repo/ready":
        return {
          ...state,
          artifactName: event.payload.artifactName,
          ready: true,
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

  protected override processEvent(
    args: Parameters<StreamProcessor<RepoProcessorContract>["processEvent"]>[0],
  ): undefined {
    const { blockProcessorWhile, event, state, append, appendTo } = args;
    if (state.birthCertificate === null) return;
    if (event !== null && event.type === "events.iterate.com/repo/created") {
      blockProcessorWhile(() =>
        appendTo("/", {
          type: "events.iterate.com/repo/created",
          idempotencyKey: this.idempotencyKey("catalog-created", event),
          payload: event.payload,
        }),
      );
    }
    // AT-HEAD reconcile (was onCaughtUp): drive the repo's two durable
    // obligations (create, github-import) from the whole fold. ONE outer
    // blocking closure so the create seed+append is awaited before this head
    // event's deferred commit; a mid-catch-up fold never reaches it.
    if (args.delivery.caughtUp) {
      args.blockProcessorWhileCaughtUp(() => this.#reconcileObligations(args));
    }
    if (event === null) return;
    if (event.type === "events.iterate.com/repo/created") return;
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
      // stars, plain issues) stays a repo-stream fact. The first forward
      // explicitly creates the agent, capability host, and GitHub
      // facet before the webhook. Idempotency keys make replay repair safe.
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
              ...githubAgentCreationEvents({
                connection: github.connection,
                installationId: github.installationId,
                number: prNumber,
                owner: github.owner,
                path: streamPath,
                projectId,
                repo: github.repo,
                repoPath: this.path,
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
  }

  /** GitHub imports can involve two network services and a git transfer, so
   * they are durable obligations rather than checkpoint-blocking webhook
   * reactions. A refold sees the terminal event and does nothing; an eviction
   * that leaves a requested/started obligation open safely re-drives the
   * idempotent current-head sync. A vendor failure is journaled and closes the
   * attempt instead of wedging every later repo event. */
  readonly #liveGithubImports = new Set<string>();

  /**
   * At-head reconciliation of the repo's two durable obligations against the
   * final fold. `processEvent` invokes it under `delivery.caughtUp` (the last
   * consumed event of a batch that reached head — the `checkpointOffset >=
   * streamMaxOffset` gate the legacy `processEventBatch` override carried lives
   * in the runner now); the refold path runs reduce-only, so it never reaches
   * this reconcile. RECOVERY rides this same path:
   * `events.iterate.com/stream/processor-revived` — the fact the keepalive's revival pass
   * journals after an eviction took in-flight work — is consumed by the
   * contract, so its ordinary delivery is a guaranteed turn that lands at head
   * and runs this reconcile, where the undriven obligations are re-driven.
   *
   * CREATION is an OBLIGATION driven from the at-head fold, never a per-event
   * reaction: a journal refold (the normal aftermath of a state-schema
   * deploy) replays the `repo/created` birth certificate, but the at-head fold
   * (`args.state`, NOT `previousState`) has already absorbed any journaled
   * `repo/ready` fact —
   * so `createRepoArtifact`, whose seeding force-pushes the seed commit and
   * would clobber user commits, provably never re-runs. The `ready`
   * idempotency key binds NO event offset (`this.idempotencyKey("ready")`),
   * so a redelivery/revival cannot rotate it and re-seed. No expiry on
   * purpose: "this repo should exist" does not go stale, and the vendor call
   * is idempotent (get-or-create + re-seed of a fresh repo folds to a no-op),
   * so a create-succeeded/append-failed retry is safe.
   */
  async #reconcileObligations(
    args: Parameters<StreamProcessor<RepoProcessorContract>["processEvent"]>[0],
  ): Promise<void> {
    if (args.state.birthCertificate === null) return;
    if (!args.state.ready) {
      // Create inline — this runs inside the head event's outer blocking
      // closure (see processEvent), so awaiting the seed + `created` append
      // holds the frame; a nested blockProcessorWhile would register after the
      // runner's per-event blocker snapshot and never be awaited.
      const payload = await this.deps.createRepoArtifact({
        path: this.path,
        projectId: this.projectId,
      });
      await args.append({
        type: "events.iterate.com/repo/ready",
        idempotencyKey: this.idempotencyKey("ready"),
        payload: {
          ...payload,
          path: this.path,
          projectId: this.projectId,
        },
      });
    }

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
}
