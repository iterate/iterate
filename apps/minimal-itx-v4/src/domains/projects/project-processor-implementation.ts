import { StreamProcessor } from "../streams/engine/stream-processor.ts";
import { durableObjectProcessorSubscriber } from "../streams/engine/shared/callable-subscriber.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { PROJECT_REPO_PATH } from "../repos/project-repo.ts";
import type { StreamEvent } from "../streams/types.ts";
import { ItxProcessorContract } from "../itx/itx-processor-contract.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
type ProjectProcessorDeps = {
  ensureDefaultWorkerLoaded(): Promise<void>;
  forwardEventToProjectWorker(event: StreamEvent): Promise<void>;
  projectId: string;
};

export class ProjectProcessor extends StreamProcessor<
  typeof ProjectProcessorContract,
  ProjectProcessorDeps
> {
  readonly contract = ProjectProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof ProjectProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/project/create-requested":
        if (event.payload.projectId !== this.deps.projectId) return state;
        return { ...state, createRequest: event.payload };
      case "events.iterate.com/project/created":
        if (event.payload.projectId !== this.deps.projectId) return state;
        return { ...state, created: true };
      default:
        return state;
    }
  }

  protected override processEvent({
    blockProcessorWhile,
    event,
    previousState,
    runInBackground,
    state,
    append,
  }: Parameters<StreamProcessor<typeof ProjectProcessorContract>["processEvent"]>[0]): undefined {
    if (previousState.created) {
      runInBackground(async () => {
        try {
          await this.deps.forwardEventToProjectWorker(event as StreamEvent);
        } catch (error) {
          console.log("project worker processEvent failed", error);
        }
      });
    }

    switch (event.type) {
      case "events.iterate.com/project/create-requested": {
        if (event.payload.projectId !== this.deps.projectId) {
          throw new Error(
            `create-requested for "${event.payload.projectId}" on project "${this.deps.projectId}"`,
          );
        }
        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/stream/subscription-configured",
            idempotencyKey: `stream-subscription:${this.deps.projectId}:${ItxProcessorContract.slug}`,
            payload: {
              subscriptionKey: ItxProcessorContract.slug,
              subscriber: durableObjectProcessorSubscriber({
                bindingName: "ITX",
                durableObjectName: DurableObjectNameCodec.stringify({
                  projectId: this.deps.projectId,
                  path: "/",
                }),
                processorName: ItxProcessorContract.slug,
              }),
            },
          });
          await append({
            type: "events.iterate.com/repo/create-requested",
            idempotencyKey: `repo-create-requested:${this.deps.projectId}:${PROJECT_REPO_PATH}`,
            payload: {
              path: PROJECT_REPO_PATH,
              projectId: this.deps.projectId,
            },
          });
        });
        break;
      }
      case "events.iterate.com/repo/created": {
        if (
          event.payload.projectId !== this.deps.projectId ||
          event.payload.path !== PROJECT_REPO_PATH ||
          state.created ||
          state.createRequest === null
        ) {
          return;
        }
        blockProcessorWhile(async () => {
          await this.deps.ensureDefaultWorkerLoaded();
          await append({
            type: "events.iterate.com/project/created",
            idempotencyKey: `project-created:${this.deps.projectId}`,
            payload: state.createRequest!,
          });
        });
        return;
      }

      default:
        return;
    }
  }
}
