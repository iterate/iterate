import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { RepoProcessorContract, type RepoProcessorState } from "./repo-processor-contract.ts";
import {
  repoArtifactPushFromEventPayload,
  repoGithubPushFromWebhookPayload,
  type RepoCommittedFileChange,
} from "./repo-task-events.ts";

/**
 * The repo processor: one stream per repo, projecting its lifecycle and Git
 * activity, and driving two durable obligations.
 *
 * HOW IT WORKS, end to end:
 *
 * A repo is born by `repo/created`. Its one per-event consequence is a
 * catalog cross-post: the created fact is re-appended onto the project root
 * stream "/" so the project processor can list the repo. The backing
 * Cloudflare Artifacts repository is NOT created per-event: "this repo's
 * artifact should exist" is a state-derived obligation. Whenever a delivery
 * reaches head with the repo born but not `ready`, the at-head pass seeds the
 * artifact and appends `repo/ready` under the offset-free idempotency key
 * `repo/ready` — so a redelivery or revival cannot rotate the key and re-seed,
 * and a stream that already contains `repo/ready` provably never re-creates
 * (the at-head state has absorbed it, even during a full replay). The seed is
 * deliberately BLOCKING: a transient failure must hold the cursor so the
 * frame is redelivered and retried — backgrounded, the failure would be acked
 * away and a quiet stream would strand the repo unborn forever.
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
 * pass — an unseeded artifact is created, an import with no live driver
 * (fresh incarnations have an empty `#liveGithubImports`) is re-driven under
 * the same request identity, so a zombie attempt racing the successor
 * collapses on the shared idempotency keys.
 */
export class RepoProcessor extends StreamProcessor<RepoProcessorContract, RepoProcessorDeps> {
  readonly contract = RepoProcessorContract;

  /**
   * RUNTIME state: request ids of GitHub imports THIS incarnation is driving.
   * In-memory, dies with the isolate, never persisted — the stream (the
   * requested/started facts), not this set, is what survives an eviction. A
   * fresh incarnation finds the open obligation in state, sees nobody here
   * driving it, and drives it again.
   */
  readonly #liveGithubImports = new Set<string>();

  // ------------------------------------------------------------ processEvent
  // Synchronous. The side-effect lanes are chosen HERE, at the dispatch site,
  // never inside helpers:
  //
  // - PER-EVENT consequences (the catalog cross-post, commit/task facts, the
  //   import request) use `blockProcessorWhile`: each derives from an event
  //   delivered once, so a dropped append loses the fact forever.
  // - STATE-DERIVED consequences run after the switch, at head only. The
  //   GitHub import is `runInBackground` (any later at-head pass re-derives
  //   an undriven obligation from state); the artifact seed deliberately
  //   BLOCKS — see the class docstring.
  protected override processEvent(args: ProcessEventArgs<RepoProcessorContract>): undefined {
    const { event, state, delivery, append, appendTo, blockProcessorWhile, runInBackground } = args;

    switch (event?.type) {
      case "events.iterate.com/repo/created": {
        blockProcessorWhile(
          "the catalog cross-post rides this one created event; a dropped append would leave the repo missing from the root catalog",
          () =>
            appendTo("/", {
              type: "events.iterate.com/repo/created",
              idempotencyKey: this.idempotencyKey("catalog-created", event),
              payload: event.payload,
            }),
        );
        break;
      }
      case "events.iterate.com/repo/cloudflare-artifact-event-received": {
        const push = repoArtifactPushFromEventPayload(event.payload);
        if (
          state.birthCertificate === null ||
          push === null ||
          state.defaultBranch === null ||
          push.branch !== state.defaultBranch
        ) {
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
        blockProcessorWhile(
          "the commit fact derives from this one artifact push; a dropped append would lose the commit from the repo stream",
          () =>
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
        if (
          state.birthCertificate === null ||
          state.defaultBranch === null ||
          event.payload.branch !== state.defaultBranch
        ) {
          break;
        }
        blockProcessorWhile(
          "task facts derive from this one commit event; a dropped append would silently lose the commit's task changes",
          async () => {
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
          },
        );
        break;
      }
      case "events.iterate.com/github/webhook-received": {
        const push = repoGithubPushFromWebhookPayload(event.payload);
        const origin = event.source?.crossPostedFrom?.at(-1);
        if (
          state.birthCertificate === null ||
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
        blockProcessorWhile(
          "the webhook is delivered once; a dropped import request would lose the push's only trigger",
          () =>
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
      // ready / github-link-configured / github-unlinked / mirror-push
      // outcomes / import lifecycle / stream lifecycle: no per-event effect —
      // they matter through the reduced state below.
    }

    // ---------------------------------------- state-derived side effects
    // At head only: behind it the reduced state is partial — an outcome
    // (repo/ready, an import settlement) may sit in stream pages not yet
    // replayed, and acting on that would re-run completed obligations.
    if (!delivery.caughtUp) return;
    if (state.birthCertificate === null) return;

    // The artifact seed. BLOCKING on purpose (the exception to
    // state-derived-work-goes-background): a transiently failed seed must
    // hold the cursor so the frame is redelivered and retried — backgrounded,
    // the failure would be acked away and a quiet stream would strand the
    // repo unborn forever. The `ready` idempotency key binds NO event offset,
    // so a redelivery/revival cannot rotate it and re-seed; the seed
    // implementation leaves any existing branch untouched, gives concurrent
    // first seeds the same commit oid, and serializes creation with branch
    // mutation, so a create-succeeded/append-failed retry is safe. No expiry
    // on purpose: "this repo should exist" does not go stale.
    if (!state.ready) {
      blockProcessorWhile(
        "a failed artifact seed must hold the cursor for redelivery — acked away, a quiet stream would strand the repo unborn forever",
        async () => {
          const artifact = await this.deps.createRepoArtifact({
            path: this.path,
            projectId: this.projectId,
          });
          await append({
            type: "events.iterate.com/repo/ready",
            idempotencyKey: this.idempotencyKey("ready"),
            payload: { ...artifact, path: this.path, projectId: this.projectId },
          });
        },
      );
      // The import (if any) waits for the ready fact's own delivery — the
      // next at-head pass drives it over a state that includes the seed.
      return;
    }

    // The GitHub import obligation: start it when nobody in THIS incarnation
    // is driving it (normal start and post-eviction recovery are the same
    // branch on purpose). Background work — a dropped attempt is re-derived
    // from state by any later at-head pass, and the revival fact guarantees
    // one. The live-set entry is taken synchronously, before any await, so
    // this same pass never classifies its own attempt as undriven.
    const githubImport = state.githubImport;
    if (githubImport !== null && !this.#liveGithubImports.has(githubImport.requestId)) {
      this.#liveGithubImports.add(githubImport.requestId);
      runInBackground(() => this.#runGithubImport(args, githubImport));
    }
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
      case "events.iterate.com/repo/created":
        // The first created event wins; a duplicate is a no-op (explicit
        // creation rejects conflicting births at the append door — a throwing
        // reducer would only wedge the frame).
        if (state.birthCertificate !== null) return state;
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
  /** Seed the backing Cloudflare Artifacts repository. Idempotent: leaves an
   * existing branch untouched and gives concurrent first seeds the same
   * commit oid. */
  createRepoArtifact(input: { path: string; projectId: string | null }): Promise<{
    artifactName: string;
    defaultBranch: string;
    remote: string;
  }>;
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
