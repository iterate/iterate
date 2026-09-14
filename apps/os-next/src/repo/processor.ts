// src/repo/processor.ts — the repo processor (the triplet's middle): the pure reduce of the saga's
// facts and the commits, plus THE SAGA'S EFFECT through the shared driver (stream/creation-saga.ts):
// at head, while a request is owed, provision the Artifacts repo the path is backed by (through the
// effects the host injects) and land the terminal fact. Imports only the pure kernel: a unit test
// constructs it with `new`, hands it fake effects, and drives it on the node harness
// (processor.test.ts); the host (durable-object.ts) supplies `itx.git` and `itx.cd("/")`.
import {
  type ConsumedEvent,
  type ProcessEventArgs,
  type ProcessorState,
  type ReduceArgs,
  type StreamEventInput,
  StreamProcessor,
} from "../stream/processor.ts";
import { driveCreationSaga, reduceCreation } from "../stream/creation-saga.ts";
import { RepoContract, repoArtifactName, type RepoView } from "./contract.ts";

/** What the saga's effect needs from the world — the host closes these over its itx. */
export interface RepoEffects {
  /** The Artifacts repo, `main` unborn; a repo that exists is fine. */
  createRepo(name: string): Promise<unknown>;
  /** The certificate onto `/`, where the project processor keeps the catalog. */
  crossPost(event: StreamEventInput): Promise<unknown>;
}

export class RepoProcessor extends StreamProcessor<
  ProcessorState<typeof RepoContract>,
  ConsumedEvent<typeof RepoContract>
> {
  readonly contract = RepoContract;
  readonly #effects: RepoEffects;

  constructor(effects: RepoEffects) {
    super();
    this.#effects = effects;
  }

  override reduce({
    event,
    state,
  }: ReduceArgs<RepoView, ConsumedEvent<typeof RepoContract>>): RepoView | undefined {
    if (event.type === "events.iterate.com/repo/commit-completed")
      return { ...state, tip: event.payload.commitOid, commits: state.commits + 1 };
    return reduceCreation("repos", state, event);
  }

  /** The saga's effect: the Artifacts repo the path is backed by, then the certificate. */
  override processEvent(
    args: ProcessEventArgs<RepoView, ConsumedEvent<typeof RepoContract>>,
  ): undefined {
    driveCreationSaga("repos", args, {
      provision: (path) => this.#effects.createRepo(repoArtifactName(path)),
      crossPost: (event) => this.#effects.crossPost(event),
    });
    return undefined;
  }
}
