// src/workspace/processor.ts — the workspace processor's PURE class (the triplet's middle): folds
// `workspace/configured` patches into the configured-mounts view. Imports only the pure kernel, so
// a unit test constructs it with `new` (processor.test.ts, in node); the host (durable-object.ts)
// reduces it on demand — a workspace facet is not subscribed, its `snapshot()` catches up from the log.
import {
  type ConsumedEvent,
  type ProcessorState,
  type ReduceArgs,
  StreamProcessor,
} from "../stream/processor.ts";
import { WorkspaceContract, type WorkspaceView } from "./contract.ts";

export class WorkspaceProcessor extends StreamProcessor<
  ProcessorState<typeof WorkspaceContract>,
  ConsumedEvent<typeof WorkspaceContract>
> {
  readonly contract = WorkspaceContract;

  override reduce({
    event,
    state,
  }: ReduceArgs<WorkspaceView, ConsumedEvent<typeof WorkspaceContract>>):
    | WorkspaceView
    | undefined {
    if (event.type === "events.iterate.com/workspace/created") return { ...state, created: true };
    if (event.type !== "events.iterate.com/workspace/configured") return undefined;
    const mounts = { ...state.mounts };
    for (const [mountPath, mount] of Object.entries(event.payload.mounts)) {
      if (mount) mounts[mountPath] = mount;
      else delete mounts[mountPath];
    }
    return { ...state, mounts };
  }
}
