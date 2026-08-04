import { StreamProcessor } from "iterate/processors";
import type { EmittedInput, ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { internalStreamId } from "../streams/stream-delivery-utils.ts";
import { isRetryableDurableObjectAvailabilityError } from "../streams/stream-unavailable.ts";
import { isRetryableGithubTemplateSourceError } from "./github-template-source.ts";
import {
  RepoProcessorContract,
  type RepoCreateRequest,
  type RepoProcessorState,
} from "./repo-processor-contract.ts";
import { REPO_DEFAULT_BRANCH } from "./repo-defaults.ts";
import {
  repoArtifactPushFromEventPayload,
  repoGithubPushFromWebhookPayload,
} from "./repo-push-events.ts";
import { isRepoNotSeededError, isRetryableArtifactsInfrastructureError } from "./utils.ts";

// A platform alarm armed at the current millisecond from a retained hosted
// callback can be consumed before the callback handoff becomes independently
// runnable. Give the source Stream DO a real future deadline to record the
// callback result and release its call tree before Repo alarm work starts.
const CREATION_HANDOFF_DELAY_MS = 1_000;

/**
 * The repo processor: one stream per repo, projecting its lifecycle and Git
 * activity, and driving two durable obligations.
 *
 * HOW IT WORKS, end to end:
 *
 * A repo begins as a CREATION SAGA. `repos/create-requested` is the durable
 * intent (empty starter seed, a public GitHub template subtree, a private
 * GitHub pull at depth one, or a public GitHub import performed by Cloudflare
 * Artifacts outside the Worker);
 * `repos/created` or `repos/create-failed` is its terminal fact. Empty seeding
 * is short must-complete work, so the at-head pass holds the stream checkpoint
 * with `blockProcessorWhile`; an interrupted attempt is redelivered by the
 * stream spine immediately instead of depending on another event to wake a
 * quiet config repo. GitHub-backed creation is a state-derived ALARM
 * obligation. The source Stream DO invokes this processor over a retained
 * callback; starting long work in that callback and later appending its
 * outcome to the same Stream DO creates a cyclic actor-drain tree. The
 * callback therefore only arms the Repo DO's creation slice. The create event
 * itself arms that slice even when the source reports more raw offsets ahead;
 * relying only on an at-head pass can strand creation when a hosted filtered
 * delivery advances the cursor without producing that pass. `alarm()` drives
 * the vendor work after the source callback has closed, then journals the
 * immutable source and terminal fact. The terminal certificate's
 * idempotency keys are offset-free (`created` / `create-failed`), so a
 * redelivery or revival cannot rotate them and double-birth. A vendor/domain
 * error settles the saga as `repos/create-failed` — FAIL-CLOSED: a failed
 * repo's stream never reacts to anything again. A still-materializing
 * Artifact (RepoNotSeededError), an Artifacts service-availability failure,
 * or a Durable Object lifecycle interruption is not a domain failure: no
 * terminal fact is journaled and the durable obligation remains open for
 * redelivery/revival.
 *
 * Every default-branch advance becomes one `repo/commit-completed` fact.
 * OS-owned writes append it directly from the Repo Durable Object's durable
 * outbox. External Git pushes arrive as
 * `repo/cloudflare-artifact-event-received`: each push is projected into
 * branch-head authority (including ref DELETIONS, which produce no commit
 * facts but must still evict a warm head) and, when it carries a commit,
 * normalized into that same fact. Both paths use the (before, after, branch)
 * idempotency key, so a later queue observation of an OS write deduplicates.
 * The default branch is known from the moment create-requested reduces (every
 * creation mode targets main), so a push racing the terminal certificate
 * still lands its facts.
 *
 * GitHub is an ingress lane, not a second source of commit facts. A
 * received `github/webhook-received` push delivery — source-checked
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
 * resulting Artifacts queue event remains the ONLY source of commit-completed
 * facts.
 *
 * RECOVERY is the same code path as normal operation: an incarnation that
 * dies owing work gets the keepalive's `stream/processor-revived` fact
 * appended; its wake produces the eventless at-head pass. An open creation
 * re-arms the Repo DO alarm that owns its attempt, while an import with no live
 * driver (fresh incarnations have empty runtime sets) is re-driven under the
 * same request identity. A zombie attempt racing the successor collapses on
 * the shared idempotency keys.
 */
export class RepoProcessor extends StreamProcessor<RepoProcessorContract, RepoProcessorDeps> {
  readonly contract = RepoProcessorContract;

  /**
   * RUNTIME state: request ids of GitHub imports THIS incarnation is driving.
   * The requested/started facts on the stream are the durable truth.
   */
  readonly #liveGithubImports = new Set<string>();

  // ------------------------------------------------------------ processEvent
  // Synchronous. The side-effect lanes are chosen HERE, at the dispatch site,
  // never inside helpers:
  //
  // - PER-EVENT consequences (commit facts, the import request, creation-alarm
  //   handoff) use
  //   `blockProcessorWhile`: each derives from an event delivered once, so a
  //   dropped append loses the fact forever.
  // - STATE-DERIVED consequences run after the switch, at head only: creation
  //   durably arms an independent Repo DO alarm, while GitHub syncs use
  //   `runInBackground`. Any later at-head pass re-derives an undriven
  //   obligation from state, and slow vendor work must not hold the stream
  //   cursor or append into the source stream's retained callback tree.
  protected override processEvent(args: ProcessEventArgs<RepoProcessorContract>): undefined {
    const { event, state, delivery, append, blockProcessorWhile, runInBackground } = args;

    // Nothing reacts before the creation request exists, and NOTHING ever
    // reacts after a terminal creation failure — fail-closed.
    if (state.createRequest === null && state.birthCertificate === null) return;
    if (state.createFailure !== null) return;

    switch (event?.type) {
      case "events.iterate.com/repos/create-requested": {
        // Arm from the intent event itself, not only from an eventual at-head
        // pass. Hosted delivery can report the request while still having raw,
        // selector-filtered offsets ahead; creation must already have an
        // independently durable wake-up if no later consumed event arrives.
        // ensureCreationAlarm preserves a coarser retry alarm that an earlier
        // failed attempt may already own.
        if (event.payload.type !== "empty" && state.birthCertificate === null) {
          blockProcessorWhile(() =>
            this.deps.ensureCreationAlarm(this.deps.now() + CREATION_HANDOFF_DELAY_MS),
          );
        }
        break;
      }
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
      case "events.iterate.com/github/webhook-received": {
        const push = repoGithubPushFromWebhookPayload(event.payload);
        const origin = event.source?.copiedFrom?.at(-1);
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
        // remains the ONLY source of commit-completed facts.
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
      // created / create-failed / github-link lifecycle / mirror-push
      // outcomes / import lifecycle / stream lifecycle: no
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
    // GitHub-backed creation can be a long import. The source Stream DO is
    // still waiting for this hosted callback's acknowledgement, so this turn
    // MUST NOT start work that later appends back to that same Stream DO. Arm
    // the Repo DO's dedicated alarm slice instead; its handler runs outside
    // this callback tree and calls driveCreation(). Offset-free terminal keys
    // make a retried alarm converge on one certificate.
    const createRequest = state.createRequest;
    if (
      createRequest !== null &&
      state.birthCertificate === null &&
      createRequest.type === "empty"
    ) {
      blockProcessorWhile(async () => append(await this.#createRepoTerminal(createRequest)));
    } else if (createRequest !== null && state.birthCertificate === null) {
      blockProcessorWhile(() =>
        this.deps.ensureCreationAlarm(this.deps.now() + CREATION_HANDOFF_DELAY_MS),
      );
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
   * Drive one open GitHub-backed creation obligation from the Repo DO's alarm
   * handler, never from the source Stream DO's hosted callback. The caller
   * supplies a runner-backed committed snapshot. A resolved source
   * is journaled before any bytes are materialized; if materialization then
   * fails retryably, the next alarm folds that fact and never resolves a moved
   * ref again. Every append is idempotency-keyed, so an alarm retry after a
   * lost response converges on the same source and terminal certificate.
   */
  async driveCreation(state: RepoProcessorState): Promise<void> {
    const createRequest = state.createRequest;
    if (
      createRequest === null ||
      createRequest.type === "empty" ||
      state.birthCertificate !== null ||
      state.createFailure !== null
    ) {
      await this.deps.repointCreationAlarm(null);
      return;
    }

    let templateSource = state.templateSource;
    if (createRequest.type === "github-public-template" && templateSource === null) {
      // The source fact may have committed while this runner's local fold was
      // evicted or before its callback observed the append. Point-read the
      // offset-free journal key before resolving a moving ref again. The
      // stream remains the sole source of truth; this adds no shadow KV state.
      templateSource = await this.#readJournaledTemplateSource(createRequest);
    }
    if (createRequest.type === "github-public-template" && templateSource === null) {
      try {
        templateSource = await this.deps.resolveGithubTemplateSource(createRequest);
      } catch (error) {
        await this.append(this.#creationFailureOrThrow(createRequest, error));
        await this.deps.repointCreationAlarm(null);
        return;
      }
      await this.append({
        type: "events.iterate.com/repos/template-source-resolved",
        idempotencyKey: internalStreamId(
          "repo-template-source-resolved",
          this.projectId,
          this.path,
        ),
        payload: templateSource,
      });
    }

    await this.append(await this.#createRepoTerminal(createRequest, templateSource));
    await this.deps.repointCreationAlarm(null);
  }

  async #readJournaledTemplateSource(
    request: Extract<RepoCreateRequest, { type: "github-public-template" }>,
  ): Promise<NonNullable<RepoProcessorState["templateSource"]> | null> {
    const event = await this.stream.getEvent({
      idempotencyKey: internalStreamId("repo-template-source-resolved", this.projectId, this.path),
    });
    if (event === undefined) return null;

    const parsed = RepoProcessorContract.parseEvent(event);
    if (
      parsed.type !== "events.iterate.com/repos/template-source-resolved" ||
      parsed.payload.owner !== request.owner ||
      parsed.payload.repo !== request.repo ||
      parsed.payload.ref !== request.ref ||
      parsed.payload.path !== request.path
    ) {
      throw new Error(
        "The journaled GitHub template source does not match the repo creation request.",
      );
    }
    return parsed.payload;
  }

  /**
   * One creation attempt, returning the saga's terminal fact. An empty repo
   * seeds a starter Artifact; a public GitHub repo is imported by Cloudflare
   * Artifacts directly (no transfer through the Worker) and then linked; a
   * private GitHub repo starts from an empty Artifact, links, and pulls the
   * default branch through the Worker at depth one. Any vendor error settles
   * the saga as `repos/create-failed` — EXCEPT a still-materializing Artifact
   * (RepoNotSeededError), a retryable Artifacts service failure, or a Durable
   * Object lifecycle interruption. Those keep the obligation open for
   * redelivery/revival instead of permanently failing a repo because
   * infrastructure restarted underneath it.
   */
  async #createRepoTerminal(
    request: RepoCreateRequest,
    templateSource: RepoProcessorState["templateSource"] = null,
  ): Promise<EmittedInput<RepoProcessorContract>> {
    try {
      const artifact = await this.#createRepo(request, templateSource);
      return {
        type: "events.iterate.com/repos/created",
        idempotencyKey: this.idempotencyKey("created"),
        payload: { ...artifact, request },
      };
    } catch (error) {
      return this.#creationFailureOrThrow(request, error);
    }
  }

  #creationFailureOrThrow(
    request: RepoCreateRequest,
    error: unknown,
  ): EmittedInput<RepoProcessorContract> {
    if (
      isRepoNotSeededError(error) ||
      isRetryableArtifactsInfrastructureError(error) ||
      isRetryableDurableObjectAvailabilityError(error) ||
      isRetryableGithubTemplateSourceError(error)
    ) {
      throw error;
    }
    return {
      type: "events.iterate.com/repos/create-failed",
      idempotencyKey: this.idempotencyKey("create-failed"),
      payload: {
        error: error instanceof Error ? error.message : String(error),
        request,
      },
    };
  }

  async #createRepo(
    request: RepoCreateRequest,
    templateSource: RepoProcessorState["templateSource"],
  ) {
    if (request.type === "empty") return await this.deps.createEmptyArtifact();

    if (request.type === "github-public-template") {
      if (templateSource === null) {
        throw new Error("GitHub template source was not durably resolved before materialization.");
      }
      return await this.deps.createGithubTemplateArtifact(templateSource);
    }

    const artifact =
      request.type === "github-public"
        ? await this.deps.importPublicGithubArtifact(request)
        : await this.deps.createEmptyArtifact();
    // A public import without a connection is a plain clone: Artifacts pulls
    // the public URL unauthenticated, and nothing links — linkGithub remains
    // the explicit later verb for webhook ingestion and sync.
    if (request.type === "github-private") {
      await this.deps.linkGithub(request);
      await this.deps.syncPrivateGithub();
    } else if (request.connection !== undefined) {
      await this.deps.linkGithub({
        connection: request.connection,
        owner: request.owner,
        repo: request.repo,
      });
    }
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
          // still normalized into durable commit facts.
          defaultBranch: REPO_DEFAULT_BRANCH,
        };
      case "events.iterate.com/repos/template-source-resolved": {
        const request = state.createRequest;
        if (
          request?.type !== "github-public-template" ||
          state.templateSource !== null ||
          event.idempotencyKey !==
            internalStreamId("repo-template-source-resolved", this.projectId, this.path) ||
          event.payload.owner !== request.owner ||
          event.payload.repo !== request.repo ||
          event.payload.ref !== request.ref ||
          event.payload.path !== request.path
        ) {
          return state;
        }
        return { ...state, templateSource: event.payload };
      }
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
        // commit-completed and webhook deliveries are consumed for their
        // per-event delivery turn; no state change.
        return state;
    }
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies (wired by repo-durable-object.ts).
// -----------------------------------------------------------------------------

type RepoProcessorDeps = {
  /** Current epoch milliseconds; injected so alarm scheduling is deterministic
   * in the processor harness. */
  now(): number;
  /** Arm the Repo DO's creation slice only when it has no existing desire.
   * A caught-up callback after a retryable failure must not pull the coarse
   * retry that alarm() already scheduled back to the handoff deadline. */
  ensureCreationAlarm(atMs: number): Promise<void>;
  /** Point the Repo DO's dedicated creation alarm slice at an epoch ms, or
   * disarm it with null. The alarm, not the hosted source callback, owns all
   * long creation work so outcome appends cannot form a cyclic DO call tree. */
  repointCreationAlarm(atMs: number | null): Promise<void>;
  /** Seed the backing Cloudflare Artifacts repository with the starter files.
   * Idempotent: leaves an existing branch untouched and gives concurrent
   * first seeds the same commit oid. */
  createEmptyArtifact(): Promise<{
    artifactName: string;
    defaultBranch: string;
    remote: string;
  }>;
  /** Materialize a previously journaled immutable GitHub commit as a fresh
   * Artifact root commit. Idempotent: an existing branch is left untouched. */
  createGithubTemplateArtifact(source: NonNullable<RepoProcessorState["templateSource"]>): Promise<{
    artifactName: string;
    defaultBranch: string;
    remote: string;
  }>;
  /** Resolve a branch, tag, commit, or default branch to immutable Git
   * coordinates. This performs no blob downloads; the caller journals the
   * result before materialization. */
  resolveGithubTemplateSource(
    input: Extract<RepoCreateRequest, { type: "github-public-template" }>,
  ): Promise<NonNullable<RepoProcessorState["templateSource"]>>;
  /** Have Cloudflare Artifacts clone a public GitHub repository directly —
   * the history never transfers through the Worker. Throws RepoNotSeededError
   * while the import is still materializing. */
  importPublicGithubArtifact(input: { depth?: number; owner: string; repo: string }): Promise<{
    artifactName: string;
    defaultBranch: string;
    remote: string;
  }>;
  /** Link the repo to the GitHub repository (configure the link, arm webhook
   * webhook delivery) without pushing starter history first. */
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
  /** Adopt the CURRENT GitHub default-branch head into Artifacts (idempotent
   * fast-forward; a newer head than requested also satisfies the request —
   * GitHub webhooks may arrive out of order). */
  syncFromGithubPush(input: {
    afterCommitOid: string;
    branch: string;
  }): Promise<{ commitOid: string }>;
};
