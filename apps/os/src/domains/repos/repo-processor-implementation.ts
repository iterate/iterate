import { StreamProcessor, type EmittedInput } from "iterate/processors";
import { RepoProcessorContract, type RepoCreateRequest } from "./repo-processor-contract.ts";
import {
  repoArtifactPushFromEventPayload,
  repoGithubPushFromWebhookPayload,
  type RepoCommittedFileChange,
} from "./repo-task-events.ts";

type RepoProcessorDeps = {
  createEmptyArtifact(): Promise<{
    artifactName: string;
    defaultBranch: string;
    remote: string;
  }>;
  importPublicGithubArtifact(input: { depth?: number; owner: string; repo: string }): Promise<{
    artifactName: string;
    defaultBranch: string;
    remote: string;
  }>;
  linkGithub(input: { connection: string; owner: string; repo: string }): Promise<void>;
  syncPrivateGithub(): Promise<void>;
  /** Feed a queue-observed push into the branch-head cache authority —
   * INCLUDING ref deletions (`afterCommitOid: null`), which produce no
   * commit facts but must still evict a warm head/tree. The before oid lets
   * the authority prune out-of-order deliveries. */
  observeArtifactPush(input: {
    afterCommitOid: string | null;
    beforeCommitOid: string | null;
    branch: string;
  }): void;
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
      case "events.iterate.com/repos/create-requested":
        if (state.createRequest !== null) {
          throw new Error("repo received more than one create-requested event");
        }
        return { ...state, createRequest: event.payload };
      case "events.iterate.com/repos/created":
        if (state.birthCertificate !== null) {
          throw new Error("repo received more than one created event");
        }
        return {
          ...state,
          birthCertificate: event.payload,
          artifactName: event.payload.artifactName,
          defaultBranch: event.payload.defaultBranch,
          remote: event.payload.remote,
        };
      case "events.iterate.com/repos/create-failed":
        return { ...state, createFailure: event.payload };
      case "events.iterate.com/repo/created":
        if (state.birthCertificate !== null) {
          throw new Error("repo received more than one created event");
        }
        return { ...state, birthCertificate: event.payload };
      case "events.iterate.com/repo/ready":
        return {
          ...state,
          artifactName: event.payload.artifactName,
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
    const { event, state } = args;
    if (state.createRequest === null && state.birthCertificate === null) return;
    // Per-event blockers register FIRST: `blockProcessorWhile` runs in FIFO
    // registration order, so the at-head registration below must come after
    // them — its appends must land after this frame's per-event appends.
    if (event !== null) this.#processConsumedEvent(args, event);
    // AT-HEAD reconcile (was onCaughtUp): derive both durable obligations from
    // the whole fold. The fast reconciliation is checkpoint-blocking; the
    // consequential vendor work it registers is keepalive-backed background
    // work, so slow imports cannot hold stream delivery.
    if (args.delivery.caughtUp) {
      args.blockProcessorWhile(() => this.#reconcileObligations(args));
    }
  }

  /** The per-event chain, extracted so its early `return`s exit only this
   * helper and can never skip the at-head registration in `processEvent`. */
  #processConsumedEvent(
    args: Parameters<StreamProcessor<RepoProcessorContract>["processEvent"]>[0],
    event: NonNullable<
      Parameters<StreamProcessor<RepoProcessorContract>["processEvent"]>[0]["event"]
    >,
  ): void {
    const { blockProcessorWhile, state, append } = args;
    if (
      event.type === "events.iterate.com/repos/create-requested" ||
      event.type === "events.iterate.com/repos/created" ||
      event.type === "events.iterate.com/repos/create-failed" ||
      event.type === "events.iterate.com/repo/created" ||
      event.type === "events.iterate.com/repo/ready"
    ) {
      return;
    }
    if (event.type === "events.iterate.com/repo/cloudflare-artifact-event-received") {
      const push = repoArtifactPushFromEventPayload(event.payload);
      if (push === null || state.defaultBranch === null || push.branch !== state.defaultBranch) {
        return;
      }
      // Ref projection is unconditional: every parsed default-branch push —
      // including a deletion, which appends no commit facts — invalidates the
      // head authority. Only the commit-diff work below needs a commit.
      this.deps.observeArtifactPush({
        afterCommitOid: push.afterCommitOid ?? null,
        beforeCommitOid: push.beforeCommitOid ?? null,
        branch: push.branch,
      });
      const commitOid = push.afterCommitOid;
      if (commitOid === null || commitOid === undefined) return;
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
      const origin = event.source?.crossPostedFrom?.at(-1);
      if (
        push !== null &&
        state.github !== null &&
        state.defaultBranch !== null &&
        origin?.path === `/integrations/github/${state.github.connection}` &&
        origin.projectId === this.projectId &&
        origin.subscriptionKey === `github-repo:${this.path}` &&
        origin.type === event.type &&
        push.installationId === state.github.installationId &&
        push.repositoryId === state.github.repositoryId &&
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
  #creationAttemptedThisIncarnation = false;

  /**
   * At-head reconciliation of the repo's two durable obligations against the
   * final fold. `processEvent` invokes it under `delivery.caughtUp` after the
   * scan reaches head (on the last consumed event or an eventless pass); the
   * refold path runs reduce-only, so it never reaches
   * this reconcile. RECOVERY rides this same path:
   * `events.iterate.com/stream/processor-revived` — the fact the keepalive's revival pass
   * journals after an eviction took in-flight work — is consumed by the
   * contract, so its ordinary delivery is a guaranteed turn that lands at head
   * and runs this reconcile, where the undriven obligations are re-driven.
   *
   * CREATION is an OBLIGATION driven from the at-head fold, never a per-event
   * reaction. `repos/create-requested` is durable intent; `repos/created` or
   * `repos/create-failed` is its terminal fact. The external work runs in the
   * background so a slow vendor import cannot hold the stream checkpoint.
   */
  async #reconcileObligations(
    args: Parameters<StreamProcessor<RepoProcessorContract>["processEvent"]>[0],
  ): Promise<void> {
    const request = args.state.createRequest;
    if (
      request !== null &&
      args.state.birthCertificate === null &&
      args.state.createFailure === null &&
      !this.#creationAttemptedThisIncarnation
    ) {
      this.#creationAttemptedThisIncarnation = true;
      args.runInBackground(async () => {
        try {
          await args.append(await this.#createRepoTerminal(request));
        } catch (error) {
          // No terminal fact landed, so a later at-head/revival pass in this
          // incarnation must be allowed to re-drive the obligation.
          this.#creationAttemptedThisIncarnation = false;
          throw error;
        }
      });
    }

    const githubImport = args.state.githubImport;
    if (githubImport === null || this.#liveGithubImports.has(githubImport.requestId)) return;

    this.#liveGithubImports.add(githubImport.requestId);
    args.runInBackground(async () => {
      try {
        // The started fact must land before the vendor body runs. If this
        // append fails, the open requested obligation remains retryable and
        // the sync is deliberately not called.
        await args.append({
          type: "events.iterate.com/repo/github-import-started",
          idempotencyKey: this.idempotencyKey(`github-import-started:${githubImport.requestId}`),
          payload: {
            branch: githubImport.branch,
            requestId: githubImport.requestId,
            requestedCommitOid: githubImport.requestedCommitOid,
          },
        });

        let result: { commitOid: string };
        try {
          result = await this.deps.syncFromGithubPush({
            afterCommitOid: githubImport.requestedCommitOid,
            branch: githubImport.branch,
          });
        } catch (error) {
          await args.append({
            type: "events.iterate.com/repo/github-import-failed",
            idempotencyKey: this.idempotencyKey(`github-import-failed:${githubImport.requestId}`),
            payload: {
              branch: githubImport.branch,
              error: String(error),
              requestId: githubImport.requestId,
              requestedCommitOid: githubImport.requestedCommitOid,
            },
          });
          return;
        }

        await args.append({
          type: "events.iterate.com/repo/github-import-completed",
          idempotencyKey: this.idempotencyKey(`github-import-completed:${githubImport.requestId}`),
          payload: {
            branch: githubImport.branch,
            commitOid: result.commitOid,
            requestId: githubImport.requestId,
            requestedCommitOid: githubImport.requestedCommitOid,
          },
        });
      } finally {
        this.#liveGithubImports.delete(githubImport.requestId);
      }
    });
  }

  async #createRepoTerminal(
    request: RepoCreateRequest,
  ): Promise<EmittedInput<RepoProcessorContract>> {
    try {
      const artifact = await this.#createRepo(request);
      return {
        type: "events.iterate.com/repos/created",
        idempotencyKey: this.idempotencyKey("created"),
        payload: { ...artifact, request },
      };
    } catch (error) {
      return {
        type: "events.iterate.com/repos/create-failed",
        idempotencyKey: this.idempotencyKey("create-failed"),
        payload: {
          error: error instanceof Error ? error.message : String(error),
          request,
        },
      };
    }
  }

  async #createRepo(request: RepoCreateRequest) {
    if (request.type === "empty") return await this.deps.createEmptyArtifact();

    const artifact =
      request.type === "github-public"
        ? await this.deps.importPublicGithubArtifact(request)
        : await this.deps.createEmptyArtifact();
    await this.deps.linkGithub(request);
    if (request.type === "github-private") await this.deps.syncPrivateGithub();
    return artifact;
  }
}
