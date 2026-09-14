// src/repo/processor.ts — the repo processor (the triplet's middle): the pure reduce of the saga's
// facts and the commits, plus THE SAGA'S EFFECT. `processEvent` drives it AT HEAD while a request is
// owed — the engine's "now": a fresh request is the head when it lands; an attempt that died with its
// incarnation is owed at the next catch-up's head; a replayed history whose request already has its
// terminal in the same page never drives. It provisions the Artifacts repo the path is backed by
// (through the effects the host injects) and lands the certificate — cross-posted to `/` FIRST, on the
// repo's own path LAST, so a cross-post that fails leaves the request owed — or `repos/create-failed`.
// Provisioning tolerates an existing repo and the terminal facts carry idempotency keys, so a re-drive
// is safe. Imports only the pure kernel: a unit test constructs it with `new`, hands it fake effects,
// and drives it on the node harness (processor.test.ts); the host supplies `itx.git` and `itx.cd("/")`.
import {
  type ConsumedEvent,
  type ProcessEventArgs,
  type ProcessorState,
  type ReduceArgs,
  type StreamEventInput,
  StreamProcessor,
} from "../stream/processor.ts";
import { RepoContract, repoArtifactName, type RepoView } from "./contract.ts";

/** What the saga's effect needs from the world — the host closes these over its itx. */
export interface RepoEffects {
  /** The Artifacts repo, `main` unborn; a repo that exists is fine. */
  createRepo(name: string): Promise<unknown>;
  /** The certificate onto `/`, where the project processor keeps the catalog. */
  crossPost(event: StreamEventInput): Promise<unknown>;
}

/** The certificate, spelled once — the same event under the same key on `/` and on the repo's path. */
export function repoCreatedEvent(path: string): StreamEventInput {
  return {
    type: "events.iterate.com/repos/created",
    payload: { path },
    idempotencyKey: `repos/created:${path}`,
  };
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
    switch (event.type) {
      case "events.iterate.com/repos/create-requested":
        return {
          ...state,
          path: event.payload.path,
          creation: "requested",
          attempts: state.attempts + 1,
          error: null,
        };
      case "events.iterate.com/repos/created":
        return { ...state, creation: "created", error: null };
      case "events.iterate.com/repos/create-failed":
        return { ...state, creation: "failed", error: event.payload.error };
      case "events.iterate.com/repo/commit-completed":
        return { ...state, tip: event.payload.commitOid, commits: state.commits + 1 };
      default:
        return undefined;
    }
  }

  override processEvent({
    state,
    append,
    blockProcessorWhile,
    delivery,
  }: ProcessEventArgs<RepoView, ConsumedEvent<typeof RepoContract>>): undefined {
    if (state.creation !== "requested" || !state.path || !delivery.caughtUp) return undefined;
    const path = state.path;
    const attempt = state.attempts;
    blockProcessorWhile(async () => {
      try {
        await this.#effects.createRepo(repoArtifactName(path));
      } catch (error) {
        await append({
          type: "events.iterate.com/repos/create-failed",
          payload: { path, error: error instanceof Error ? error.message : String(error) },
          idempotencyKey: `repos/create-failed:${path}:${attempt}`,
        });
        return;
      }
      // Two fresh copies: the engine stamps its provenance onto what it appends; the copy on `/` is
      // attributed there, by that context's own append. The cross-post FIRST, the own-path fact LAST.
      await this.#effects.crossPost(repoCreatedEvent(path));
      await append(repoCreatedEvent(path));
    });
    return undefined;
  }
}
