// src/workspace/processor.ts — the workspace processor (the triplet's middle): the pure reduce of
// the saga's facts and the configured-mounts patches, plus THE SAGA'S EFFECT through the shared
// driver (stream/creation-saga.ts) — with nothing to provision: a workspace is its facet's own
// storage, so the effect is the certificate alone, cross-posted to `/` and landed on the workspace's
// path. Imports only the pure kernel, so a unit test constructs it with `new` (processor.test.ts, in
// node); the host (durable-object.ts) reduces it on demand through `snapshot()` and supplies `itx.cd("/")`.
import {
  type ConsumedEvent,
  type ProcessEventArgs,
  type ProcessorState,
  type ReduceArgs,
  type StreamEventInput,
  StreamProcessor,
} from "../stream/processor.ts";
import { driveCreationSaga, reduceCreation } from "../stream/creation-saga.ts";
import { WorkspaceContract, type WorkspaceView } from "./contract.ts";

/** What the saga's effect needs from the world — the host closes it over its itx. */
export interface WorkspaceEffects {
  /** The certificate onto `/`, where the project processor keeps the catalog. */
  crossPost(event: StreamEventInput): Promise<unknown>;
}

export class WorkspaceProcessor extends StreamProcessor<
  ProcessorState<typeof WorkspaceContract>,
  ConsumedEvent<typeof WorkspaceContract>
> {
  readonly contract = WorkspaceContract;
  readonly #effects: WorkspaceEffects;

  constructor(effects: WorkspaceEffects) {
    super();
    this.#effects = effects;
  }

  override reduce({
    event,
    state,
  }: ReduceArgs<WorkspaceView, ConsumedEvent<typeof WorkspaceContract>>):
    | WorkspaceView
    | undefined {
    if (event.type === "events.iterate.com/workspace/configured") {
      const mounts = { ...state.mounts };
      for (const [mountPath, mount] of Object.entries(event.payload.mounts)) {
        if (mount) mounts[mountPath] = mount;
        else delete mounts[mountPath];
      }
      return { ...state, mounts };
    }
    return reduceCreation("workspace", state, event);
  }

  /** The saga's effect: nothing to provision yet — the certificate alone. */
  override processEvent(
    args: ProcessEventArgs<WorkspaceView, ConsumedEvent<typeof WorkspaceContract>>,
  ): undefined {
    driveCreationSaga("workspace", args, {
      provision: async () => undefined,
      crossPost: (event) => this.#effects.crossPost(event),
    });
    return undefined;
  }
}
