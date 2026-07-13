import type { ProcessorEvent } from "../streams/processor-contracts.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";
import {
  githubAgentSubscriptionConfiguredEvent,
  obsoleteGithubAgentSubscriptionRemovedEvent,
} from "./github-agent-mechanics.ts";
import { githubAgentPath, pullRequestNumbersFromWebhookBody } from "./github-agent-utils.ts";

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
        return { ...state, github: event.payload, lastGithubPush: null };
      case "events.iterate.com/repo/github-unlinked":
        return { ...state, github: null, lastGithubPush: null };
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
    appendTo,
  }: Parameters<StreamProcessor<RepoProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type === "events.iterate.com/github/webhook-received") {
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
              obsoleteGithubAgentSubscriptionRemovedEvent({
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

  /** Reject a create-requested addressed to a different repo than this processor serves. */
  #assertOwnCreateRequest(event: RepoCreateRequested): void {
    if (event.payload.projectId !== this.projectId || event.payload.path !== this.path) {
      throw new Error(
        `repo/create-requested for "${event.payload.projectId}:${event.payload.path}" on repo "${this.projectId}:${this.path}"`,
      );
    }
  }
}
