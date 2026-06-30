import { StreamProcessor } from "../streams/engine/stream-processor.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";

type RepoProcessorDeps = {
  createRepoArtifact(input: { path: string; projectId: string | null }): Promise<{
    artifactName: string;
    defaultBranch: string;
    remote: string;
  }>;
  path: string;
  projectId: string | null;
};

export class RepoProcessor extends StreamProcessor<
  typeof RepoProcessorContract,
  RepoProcessorDeps
> {
  readonly contract = RepoProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof RepoProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/repo/created":
        return {
          ...state,
          artifactName: event.payload.artifactName,
          created: true,
          defaultBranch: event.payload.defaultBranch,
          remote: event.payload.remote,
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
  }: Parameters<StreamProcessor<typeof RepoProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/repo/create-requested") return;
    if (event.payload.projectId !== this.deps.projectId || event.payload.path !== this.deps.path) {
      throw new Error(
        `repo/create-requested for "${event.payload.projectId}:${event.payload.path}" on repo "${this.deps.projectId}:${this.deps.path}"`,
      );
    }
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
}
