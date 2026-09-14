// src/workspace/processor.ts — the workspace processor (the triplet's middle): the pure reduce of
// the saga's facts and the configured-mounts patches, plus THE SAGA'S EFFECT. `processEvent` drives
// it AT HEAD while a request is owed (a fresh request is the head when it lands; an attempt that died
// with its incarnation is owed at the next catch-up's head; a replayed history never re-drives) — and
// with nothing to provision yet, the effect is the certificate alone: cross-posted to `/` FIRST, on
// the workspace's own path LAST, so a cross-post that fails leaves the request owed. Imports only the
// pure kernel, so a unit test constructs it with `new` (processor.test.ts, in node); the host
// (durable-object.ts) reduces it on demand through `snapshot()` and supplies `itx.cd("/")`.
import {
  type ConsumedEvent,
  type ProcessEventArgs,
  type ProcessorState,
  type ReduceArgs,
  type StreamEventInput,
  StreamProcessor,
} from "../stream/processor.ts";
import { WorkspaceContract, type WorkspaceView } from "./contract.ts";

/** What the saga's effect needs from the world — the host closes it over its itx. */
export interface WorkspaceEffects {
  /** The certificate onto `/`, where the project processor keeps the catalog. */
  crossPost(event: StreamEventInput): Promise<unknown>;
}

/** The certificate, spelled once — the same event under the same key on `/` and on the workspace's path. */
export function workspaceCreatedEvent(path: string): StreamEventInput {
  return {
    type: "events.iterate.com/workspace/created",
    payload: { path },
    idempotencyKey: `workspace/created:${path}`,
  };
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
    switch (event.type) {
      case "events.iterate.com/workspace/create-requested":
        return {
          ...state,
          path: event.payload.path,
          creation: "requested",
          attempts: state.attempts + 1,
          error: null,
        };
      case "events.iterate.com/workspace/created":
        return { ...state, creation: "created", error: null };
      case "events.iterate.com/workspace/create-failed":
        return { ...state, creation: "failed", error: event.payload.error };
      case "events.iterate.com/workspace/configured": {
        const mounts = { ...state.mounts };
        for (const [mountPath, mount] of Object.entries(event.payload.mounts)) {
          if (mount) mounts[mountPath] = mount;
          else delete mounts[mountPath];
        }
        return { ...state, mounts };
      }
      default:
        return undefined;
    }
  }

  override processEvent({
    state,
    append,
    blockProcessorWhile,
    delivery,
  }: ProcessEventArgs<WorkspaceView, ConsumedEvent<typeof WorkspaceContract>>): undefined {
    if (state.creation !== "requested" || !state.path || !delivery.caughtUp) return undefined;
    const path = state.path;
    // Nothing to provision yet, so nothing fails here: the certificate alone, `/` first, own path last.
    blockProcessorWhile(async () => {
      await this.#effects.crossPost(workspaceCreatedEvent(path));
      await append(workspaceCreatedEvent(path));
    });
    return undefined;
  }
}
