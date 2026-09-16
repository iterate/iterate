// src/project/processor.ts — the project processor's PURE class (the triplet's middle): folds the
// birth certificates cross-posted to `/` into the catalog. First certificate wins; a repo or
// workspace is born once. Imports only the pure kernel, so a unit test constructs it with `new`
// (processor.test.ts, in node); the host (durable-object.ts) reduces it on demand through `snapshot()`.
import {
  type ConsumedEvent,
  type ProcessorState,
  type ReduceArgs,
  StreamProcessor,
} from "../stream/processor.ts";
import { ProjectContract, type ProjectView } from "./contract.ts";

export class ProjectProcessor extends StreamProcessor<
  ProcessorState<typeof ProjectContract>,
  ConsumedEvent<typeof ProjectContract>
> {
  readonly contract = ProjectContract;

  override reduce({
    event,
    state,
  }: ReduceArgs<ProjectView, ConsumedEvent<typeof ProjectContract>>): ProjectView | undefined {
    if (event.type === "events.iterate.com/repos/created") {
      if (state.repos[event.payload.path]) return undefined;
      return {
        ...state,
        repos: { ...state.repos, [event.payload.path]: { createdAt: event.createdAt } },
      };
    }

    if (event.type === "events.iterate.com/workspace/created") {
      if (state.workspaces[event.payload.path]) return undefined;
      return {
        ...state,
        workspaces: { ...state.workspaces, [event.payload.path]: { createdAt: event.createdAt } },
      };
    }
    return undefined;
  }
}
