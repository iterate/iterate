// src/workspace/processor.ts — the workspace processor (the triplet's middle): the pure reduce of the
// creation facts. No effect lives here — the host's `create()` (durable-object.ts) lands the facts —
// so a unit test constructs it with `new` and reduces rows (processor.test.ts, in node).
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
    switch (event.type) {
      case "events.iterate.com/workspace/create-requested":
        return { ...state, path: event.payload.path, creation: "requested" };
      case "events.iterate.com/workspace/created":
        return { ...state, creation: "created" };
      default:
        return undefined;
    }
  }
}
