import { StreamProcessor } from "../streams/engine/stream-processor.ts";
import { subscriptionConfiguredEvent } from "../streams/subscription-event.ts";
import { PROJECT_REPO_PATH } from "../repos/project-repo.ts";
import type { StreamEvent } from "../../types.ts";
import { ProjectRpcTargetInternals, type ProjectRpcTarget } from "../../rpc-targets.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { ItxProcessorContract } from "../itx/itx-processor-contract.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";

type ProjectProcessorDeps = {
  itx: ProjectRpcTarget;
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
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return { ...state, createRequest: event.payload };
      case "events.iterate.com/project/created":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
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
          await this.deps.itx.worker.processEvent({ event: event as StreamEvent });
        } catch (error) {
          console.log("project worker processEvent failed", error);
        }
      });
    }

    switch (event.type) {
      case "events.iterate.com/project/create-requested": {
        if (event.payload.projectId !== this.deps.itx.projectId) {
          throw new Error(
            `create-requested for "${event.payload.projectId}" on project "${this.deps.itx.projectId}"`,
          );
        }
        blockProcessorWhile(async () => {
          await append(
            subscriptionConfiguredEvent({
              projectId: this.deps.itx.projectId,
              path: "/",
              bindingName: "ITX",
              processorName: ItxProcessorContract.slug,
            }),
          );
          await append({
            type: "events.iterate.com/repo/create-requested",
            idempotencyKey: `repo-create-requested:${this.deps.itx.projectId}:${PROJECT_REPO_PATH}`,
            payload: {
              path: PROJECT_REPO_PATH,
              projectId: this.deps.itx.projectId,
            },
          });
        });
        break;
      }
      case "events.iterate.com/stream/child-stream-created": {
        if (!event.payload.childPath.startsWith("/agents/")) return;
        blockProcessorWhile(async () => {
          await this.deps.itx.streams.get(event.payload.childPath).append(
            subscriptionConfiguredEvent({
              projectId: this.deps.itx.projectId,
              path: event.payload.childPath,
              bindingName: "AGENT",
              processorName: AgentProcessorContract.slug,
            }),
            subscriptionConfiguredEvent({
              projectId: this.deps.itx.projectId,
              path: event.payload.childPath,
              bindingName: "ITX",
              processorName: ItxProcessorContract.slug,
            }),
          );
        });
        return;
      }
      case "events.iterate.com/repo/created": {
        if (
          event.payload.projectId !== this.deps.itx.projectId ||
          event.payload.path !== PROJECT_REPO_PATH ||
          state.created ||
          state.createRequest === null
        ) {
          return;
        }
        blockProcessorWhile(async () => {
          await this.deps.itx[ProjectRpcTargetInternals].ensureDefaultWorkerLoaded();
          await append({
            type: "events.iterate.com/project/created",
            idempotencyKey: `project-created:${this.deps.itx.projectId}`,
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
