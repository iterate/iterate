import type { ProcessorEvent } from "../streams/processor-contracts.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";
import { prAgentPath, pullRequestNumberFromWebhookBody } from "./pr-agent-utils.ts";

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
  path: string;
  projectId: string | null;
};

export class RepoProcessor extends StreamProcessor<RepoProcessorContract, RepoProcessorDeps> {
  readonly contract = RepoProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<RepoProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
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
    append,
  }: Parameters<StreamProcessor<RepoProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type === "events.iterate.com/github/webhook-received") {
      // PR webhooks route to a per-PR agent stream, everything else (pushes,
      // stars, plain issues) stays a repo-stream fact. The first forward's
      // route event births the agent (child-stream-created lane) and durably
      // records which PR it serves; idempotency keys make replays and repeat
      // deliveries fold to nothing.
      const prNumber = pullRequestNumberFromWebhookBody((event.payload as { body?: unknown }).body);
      const github = state.github;
      if (prNumber === null || github === null) return;
      const streamPath = prAgentPath(this.deps.path, prNumber);
      const routeEvent = {
        type: "events.iterate.com/github-pr/route-configured" as const,
        idempotencyKey: `github-pr-route:${this.deps.projectId}:${this.deps.path}:${prNumber}`,
        payload: {
          ...github,
          number: prNumber,
          repoPath: this.deps.path,
          streamPath,
        },
      };
      const forwardedEvent = {
        type: "events.iterate.com/github/webhook-received" as const,
        idempotencyKey: `github-pr:forward:${this.deps.projectId}:${this.deps.path}:${event.offset}`,
        payload: event.payload,
      };
      // Durable obligation, not best-effort: this forward is the webhook's
      // only path to the PR agent (the Slack router once lost a message to a
      // fire-and-forget append). blockProcessorWhile holds the checkpoint so
      // a failed append replays; the keys above dedupe the replay.
      blockProcessorWhile(async () => {
        await this.stream.at(streamPath).append(routeEvent, forwardedEvent);
      });
      return;
    }

    if (event.type !== "events.iterate.com/repo/create-requested") return;
    this.#assertOwnCreateRequest(event);
    if (state.created) return;

    blockProcessorWhile(async () => {
      const payload = await this.deps.createRepoArtifact(event.payload);
      await append({
        type: "events.iterate.com/repo/created",
        idempotencyKey: `repo-created:${this.deps.projectId}:${this.deps.path}`,
        payload: {
          ...payload,
          path: this.deps.path,
          projectId: this.deps.projectId,
        },
      });
    });
  }

  /** Reject a create-requested addressed to a different repo than this processor serves. */
  #assertOwnCreateRequest(event: RepoCreateRequested): void {
    if (event.payload.projectId !== this.deps.projectId || event.payload.path !== this.deps.path) {
      throw new Error(
        `repo/create-requested for "${event.payload.projectId}:${event.payload.path}" on repo "${this.deps.projectId}:${this.deps.path}"`,
      );
    }
  }
}
