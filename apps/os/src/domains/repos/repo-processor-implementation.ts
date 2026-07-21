import { StreamProcessor } from "iterate/processors";
import type { EmittedInput, ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { isDurableObjectLifecycleError } from "../streams/stream-unavailable.ts";
import {
  RepoProcessorContract,
  type RepoCreateRequest,
  type RepoProcessorState,
} from "./repo-processor-contract.ts";
import { REPO_DEFAULT_BRANCH } from "./repo-defaults.ts";
import {
  repoArtifactPushFromEventPayload,
  repoGithubPushFromWebhookPayload,
  type RepoCommittedFileChange,
} from "./repo-task-events.ts";
import { isRepoNotSeededError } from "./utils.ts";

/**
 * The repo processor: one stream per repo, projecting its lifecycle and Git
 * activity, and driving two durable obligations.
 *
 * HOW IT WORKS, end to end:
 *
 * A repo begins as a CREATION SAGA. `repos/create-requested` is the durable
 * intent (empty starter seed, a private GitHub pull at depth one, or a public
 * GitHub import performed by Cloudflare Artifacts outside the Worker);
 * `repos/created` or `repos/create-failed` is its terminal fact. Empty seeding
 * is short must-complete work, so the at-head pass holds the stream checkpoint
 * with `blockProcessorWhile`; an interrupted attempt is redelivered by the
 * stream spine immediately instead of depending on another event to wake a
 * quiet config repo. GitHub imports remain state-derived background
 * obligations because they can be long-running. The terminal certificate's
 * idempotency keys are offset-free (`created` / `create-failed`), so a
 * redelivery or revival cannot rotate them and double-birth. A vendor/domain
 * error settles the saga as `repos/create-failed` — FAIL-CLOSED: a failed
 * repo's stream never reacts to anything again. A still-materializing
 * Artifact (RepoNotSeededError) or Durable Object lifecycle interruption is
 * not a domain failure: no terminal fact is journaled and the durable
 * obligation remains open for redelivery/revival.
 *
 * Commit facts come from ONE source: the Cloudflare Artifacts event queue.
 * Each `repo/cloudflare-artifact-event-received` push on the default branch
 * is projected into the in-memory branch-head cache (including ref
 * DELETIONS, which produce no commit facts but must still evict a warm head)
 * and, when it carries a commit, normalized into `repo/commit-completed`,
 * idempotency-keyed on the (before, after, branch) coordinates. Each
 * commit-completed event on the default branch is then diffed for Markdown
 * task files, producing `repo/task-created|updated|deleted` facts keyed on
 * the same coordinates plus the path — all per-event `blockProcessorWhile`
 * work: each fact derives from an event that is delivered once, so a dropped
 * append would lose it forever, and the stable keys collapse redeliveries.
 * The default branch is known from the moment create-requested reduces
 * (every creation mode targets main), so a push racing the terminal
 * certificate still lands its facts.
 *
 * GitHub is an ingress lane, not a second source of commit facts. A
 * cross-posted `github/webhook-received` push delivery — provenance-checked
 * against the linked connection stream, installation, repository id, and
 * default branch — is normalized per-event into
 * `repo/github-import-requested`, which opens the one import obligation in
 * state (`state.githubImport`, request identity = the webhook event's
 * path:offset). The at-head pass drives it WITHOUT holding the cursor
 * (`runInBackground` — imports touch two network services and a Git
 * transfer): journal `github-import-started` BEFORE the sync body (a failed
 * started-append leaves the obligation requested and retryable, and the sync
 * deliberately does not run), then sync the CURRENT GitHub head (idempotent
 * fast-forward — out-of-order deliveries are satisfied by any newer head),
 * then settle with `github-import-completed` or `github-import-failed`. A
 * failure closes the obligation instead of wedging later repo events; the
 * resulting Artifacts queue event remains the ONLY source of
 * commit-completed/task facts.
 *
 * RECOVERY is the same code path as normal operation: an incarnation that
 * dies owing work gets the keepalive's `stream/processor-revived` fact
 * appended, whose ordinary delivery lands at head and re-runs the at-head
 * pass — an open creation request with no live attempt is re-driven, an
 * import with no live driver (fresh incarnations have empty runtime sets) is
 * re-driven under the same request identity, so a zombie attempt racing the
 * successor collapses on the shared idempotency keys.
 */
export class RepoProcessor extends StreamProcessor<RepoProcessorContract, RepoProcessorDeps> {
  readonly contract = RepoProcessorContract;

  /**
   * RUNTIME state: whether THIS incarnation already launched a creation
   * attempt. In-memory, dies with the isolate, never persisted — the stream
   * (the request and its terminal fact), not this flag, is what survives an
   * eviction. A fresh incarnation finds the open request in state, sees no
   * attempt here, and drives it again.
   */
  #longCreationAttemptedThisIncarnation = false;

  /**
   * RUNTIME state: request ids of GitHub imports THIS incarnation is driving.
   * Same lifecycle as the creation flag — the requested/started facts on the
   * stream are the durable truth.
   */
  readonly #liveGithubImports = new Set<string>();

  // ------------------------------------------------------------ processEvent
  // Synchronous. The side-effect lanes are chosen HERE, at the dispatch site,
  // never inside helpers:
  //
  // - PER-EVENT consequences (commit/task facts, the import request) use
  //   `blockProcessorWhile`: each derives from an event delivered once, so a
  //   dropped append loses the fact forever.
  // - STATE-DERIVED consequences run after the switch, at head only, in
  //   `runInBackground`: any later at-head pass re-derives an undriven
  //   obligation from state, and slow vendor work (a full public import, a
  //   Git transfer) must not hold the stream cursor.
  protected override processEvent(args: ProcessEventArgs<RepoProcessorContract>): undefined {
    const { event, state, delivery, append, blockProcessorWhile, runInBackground } = args;

    // Nothing reacts before the creation request exists, and NOTHING ever
    // reacts after a terminal creation failure — fail-closed.
    if (state.createRequest === null && state.birthCertificate === null) return;
    if (state.createFailure !== null) return;

    switch (event?.type) {
      case "events.iterate.com/repo/cloudflare-artifact-event-received": {
        const push = repoArtifactPushFromEventPayload(event.payload);
        if (push === null || state.defaultBranch === null || push.branch !== state.defaultBranch) {
          break;
        }
        // Head-cache projection is unconditional: every parsed default-branch
        // push — including a deletion, which appends no commit facts —
        // invalidates the branch-head authority. A replay re-pokes the cache
        // (idempotent-by-overwrite); only the commit fact below needs a commit.
        this.deps.observeArtifactPush({
          afterCommitOid: push.afterCommitOid ?? null,
          beforeCommitOid: push.beforeCommitOid ?? null,
          branch: push.branch,
        });
        const commitOid = push.afterCommitOid;
        if (commitOid === null || commitOid === undefined) break;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/repo/commit-completed",
            idempotencyKey: this.idempotencyKey(
              `commit-completed:${push.beforeCommitOid ?? "none"}:${commitOid}:${push.branch}`,
            ),
            payload: {
              beforeCommitOid: push.beforeCommitOid,
              branch: push.branch,
              commitOid,
            },
          }),
        );
        break;
      }
      case "events.iterate.com/repo/commit-completed": {
        if (state.defaultBranch === null || event.payload.branch !== state.defaultBranch) break;
        blockProcessorWhile(async () => {
          // The tree diff is deterministic from the commit coordinates, so a
          // redelivery re-appends identical bodies and dedupes on the keys.
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
        break;
      }
      case "events.iterate.com/github/webhook-received": {
        const push = repoGithubPushFromWebhookPayload(event.payload);
        const origin = event.source?.crossPostedFrom?.at(-1);
        if (
          push === null ||
          state.github === null ||
          state.defaultBranch === null ||
          origin?.path !== `/integrations/github/${state.github.connection}` ||
          origin.projectId !== this.projectId ||
          origin.subscriptionKey !== `github-repo:${this.path}` ||
          origin.type !== event.type ||
          push.installationId !== state.github.installationId ||
          push.repositoryId !== state.github.repositoryId ||
          push.branch !== state.defaultBranch
        ) {
          break;
        }
        // GitHub is an ingress lane, not a second source of commit facts: the
        // webhook opens an obligation; the at-head pass below imports GitHub
        // without holding the cursor. The resulting Artifacts queue event
        // remains the ONLY source of commit-completed/task facts.
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
        break;
      }
      // create-requested / created / create-failed / github-link lifecycle /
      // mirror-push outcomes / import lifecycle / stream lifecycle: no
      // per-event effect — they matter through the reduced state below.
    }

    // ---------------------------------------- state-derived side effects
    // At head only: behind it the reduced state is partial — an outcome (the
    // terminal certificate, an import settlement) may sit in stream pages not
    // yet replayed, and acting on that would re-run completed obligations.
    if (!delivery.caughtUp) return;

    // The creation saga. Empty seeding is short and must complete before this
    // frame is acknowledged: if an Artifacts DO is reset during a deployment,
    // the stream spine redelivers the uncommitted frame and retries promptly.
    // GitHub-backed creation can be a long import, so it remains a background
    // obligation re-derived from state after eviction. Offset-free terminal
    // keys make both paths converge on one certificate.
    const createRequest = state.createRequest;
    if (
      createRequest !== null &&
      state.birthCertificate === null &&
      createRequest.type === "empty"
    ) {
      blockProcessorWhile(async () => append(await this.#createRepoTerminal(createRequest)));
    } else if (
      createRequest !== null &&
      state.birthCertificate === null &&
      !this.#longCreationAttemptedThisIncarnation
    ) {
      this.#longCreationAttemptedThisIncarnation = true;
      runInBackground(async () => {
        try {
          await append(await this.#createRepoTerminal(createRequest));
        } catch (error) {
          // No terminal fact landed, so a later at-head/revival pass in this
          // incarnation must be allowed to re-drive the obligation.
          this.#longCreationAttemptedThisIncarnation = false;
          throw error;
        }
      });
    }

    // The GitHub import obligation: start it when nobody in THIS incarnation
    // is driving it. Background work — a dropped attempt is re-derived from
    // state by any later at-head pass, and the revival fact guarantees one.
    // The live-set entry is taken synchronously, before any await, so this
    // same pass never classifies its own attempt as undriven.
    const githubImport = state.githubImport;
    if (githubImport !== null && !this.#liveGithubImports.has(githubImport.requestId)) {
      this.#liveGithubImports.add(githubImport.requestId);
      runInBackground(() => this.#runGithubImport(args, githubImport));
    }
  }

  /**
   * One creation attempt, returning the saga's terminal fact. An empty repo
   * seeds a starter Artifact; a public GitHub repo is imported by Cloudflare
   * Artifacts directly (no transfer through the Worker) and then linked; a
   * private GitHub repo starts from an empty Artifact, links, and pulls the
   * default branch through the Worker at depth one. Any vendor error settles
   * the saga as `repos/create-failed` — EXCEPT a still-materializing Artifact
   * (RepoNotSeededError) or a Durable Object lifecycle interruption. Those
   * keep the obligation open for redelivery/revival instead of permanently
   * failing a repo because infrastructure restarted underneath it.
   */
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
      if (isRepoNotSeededError(error) || isDurableObjectLifecycleError(error)) throw error;
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

  /**
   * One GitHub import attempt — background work: it can involve two network
   * services and a Git transfer, and the stream (not this closure) is what
   * survives an eviction. The started fact lands BEFORE the sync body; if
   * that append fails, the obligation stays `requested` and the sync
   * deliberately does not run. A vendor failure settles the obligation as
   * failed instead of wedging later repo events. Two racing drivers (a
   * zombie incarnation and its successor) collapse on the shared
   * per-requestId idempotency keys: identical bodies dedupe, and a
   * same-key-different-body settlement (the sync heads moved between
   * attempts) is rejected by the stream — the first writer's story stands,
   * which is fine because the first settlement already closed the obligation.
   */
  async #runGithubImport(
    args: ProcessEventArgs<RepoProcessorContract>,
    githubImport: NonNullable<RepoProcessorState["githubImport"]>,
  ): Promise<void> {
    const { requestId, branch, requestedCommitOid } = githubImport;
    try {
      await args.append({
        type: "events.iterate.com/repo/github-import-started",
        idempotencyKey: this.idempotencyKey(`github-import-started:${requestId}`),
        payload: { branch, requestId, requestedCommitOid },
      });

      let result: { commitOid: string };
      try {
        result = await this.deps.syncFromGithubPush({
          afterCommitOid: requestedCommitOid,
          branch,
        });
      } catch (error) {
        await args.append({
          type: "events.iterate.com/repo/github-import-failed",
          idempotencyKey: this.idempotencyKey(`github-import-failed:${requestId}`),
          payload: { branch, error: String(error), requestId, requestedCommitOid },
        });
        return;
      }

      await args.append({
        type: "events.iterate.com/repo/github-import-completed",
        idempotencyKey: this.idempotencyKey(`github-import-completed:${requestId}`),
        payload: { branch, commitOid: result.commitOid, requestId, requestedCommitOid },
      });
    } finally {
      // Released either way — otherwise a failed attempt would leave the
      // request id marked live and this incarnation would never retry it.
      this.#liveGithubImports.delete(requestId);
    }
  }

  // ------------------------------------------------------------------ reduce
  // Pure projection, one switch, cases inline.
  protected override reduce({ event, state }: ReduceArgs<RepoProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/repos/create-requested":
        // The first request wins; a duplicate is a no-op (explicit creation
        // rejects conflicting requests at the append door — a throwing
        // reducer would only wedge the frame).
        if (state.createRequest !== null) return state;
        return {
          ...state,
          createRequest: event.payload,
          // Every creation mode targets main. Record that invariant with the
          // intent so an Artifact push racing the terminal certificate is
          // still normalized into durable commit/task facts.
          defaultBranch: REPO_DEFAULT_BRANCH,
        };
      case "events.iterate.com/repos/created":
        // The first certificate wins — same no-op rule as the request.
        if (state.birthCertificate !== null) return state;
        return {
          ...state,
          birthCertificate: event.payload,
          artifactName: event.payload.artifactName,
          defaultBranch: event.payload.defaultBranch,
          remote: event.payload.remote,
        };
      case "events.iterate.com/repos/create-failed":
        return { ...state, createFailure: event.payload };
      case "events.iterate.com/repo/github-link-configured":
        // A (re)link is a fresh start: any open import obligation belonged to
        // the previous link, and the mirror status board is blank again.
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
        return { ...state, githubImport: { ...event.payload, status: "requested" as const } };
      case "events.iterate.com/repo/github-import-started":
        // Guarded on the request identity: a started fact for an obligation a
        // relink already cleared reduces to nothing.
        return state.githubImport?.requestId === event.payload.requestId
          ? { ...state, githubImport: { ...state.githubImport, status: "started" as const } }
          : state;
      case "events.iterate.com/repo/github-import-completed":
      case "events.iterate.com/repo/github-import-failed":
        return state.githubImport?.requestId === event.payload.requestId
          ? { ...state, githubImport: null }
          : state;
      case "events.iterate.com/stream/created":
        return { ...state, initialized: true };
      default:
        // commit-completed, task facts, webhook deliveries, stream/woken,
        // subscriber-connected, processor-revived: consumed for their
        // delivery turn (per-event facts or a guaranteed at-head pass), no
        // state change.
        return state;
    }
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies (wired by repo-durable-object.ts).
// -----------------------------------------------------------------------------

type RepoProcessorDeps = {
  /** Seed the backing Cloudflare Artifacts repository with the starter files.
   * Idempotent: leaves an existing branch untouched and gives concurrent
   * first seeds the same commit oid. */
  createEmptyArtifact(): Promise<{
    artifactName: string;
    defaultBranch: string;
    remote: string;
  }>;
  /** Have Cloudflare Artifacts clone a public GitHub repository directly —
   * the history never transfers through the Worker. Throws RepoNotSeededError
   * while the import is still materializing. */
  importPublicGithubArtifact(input: { depth?: number; owner: string; repo: string }): Promise<{
    artifactName: string;
    defaultBranch: string;
    remote: string;
  }>;
  /** Link the repo to the GitHub repository (configure the link, arm webhook
   * cross-posting) without pushing starter history first. */
  linkGithub(input: { connection: string; owner: string; repo: string }): Promise<void>;
  /** Pull the linked private repository's default branch through the Worker
   * at depth one, overwriting the empty Artifact seed. */
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
  /** Diff the task-file trees between two commits — deterministic from the
   * commit coordinates, so redelivered appends dedupe. */
  taskChangesForArtifactPush(input: {
    afterCommitOid: string | null;
    beforeCommitOid: string | null;
    branch: string;
  }): Promise<RepoCommittedFileChange[]>;
  /** Adopt the CURRENT GitHub default-branch head into Artifacts (idempotent
   * fast-forward; a newer head than requested also satisfies the request —
   * GitHub webhooks may arrive out of order). */
  syncFromGithubPush(input: {
    afterCommitOid: string;
    branch: string;
  }): Promise<{ commitOid: string }>;
};
