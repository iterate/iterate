// src/repo/processor.ts — the repo processor (the triplet's middle): the pure reduce of the creation
// facts. No effect lives here — the host's `create()` (durable-object.ts) provisions the Artifacts
// repo inline and lands the terminal fact — so a unit test constructs it with `new` and reduces rows
// (processor.test.ts, in node).
import {
  type ConsumedEvent,
  type ProcessorState,
  type ReduceArgs,
  StreamProcessor,
} from "../stream/processor.ts";
import { RepoContract, type RepoView } from "./contract.ts";

export class RepoProcessor extends StreamProcessor<
  ProcessorState<typeof RepoContract>,
  ConsumedEvent<typeof RepoContract>
> {
  readonly contract = RepoContract;

  override reduce({
    event,
    state,
  }: ReduceArgs<RepoView, ConsumedEvent<typeof RepoContract>>): RepoView | undefined {
    switch (event.type) {
      case "events.iterate.com/repos/create-requested":
        return { ...state, path: event.payload.path, creation: "requested", error: null };
      case "events.iterate.com/repos/created":
        return { ...state, creation: "created", error: null };
      case "events.iterate.com/repos/create-failed":
        return { ...state, creation: "failed", error: event.payload.error };
      default:
        return undefined;
    }
  }
}
