// src/repo/processor.ts — the repo processor (the triplet's middle): the pure reduce of the saga's
// facts and the commits, plus THE SAGA'S EFFECT. `processEvent` on `repos/create-requested` — and on
// the at-head pass while a request is still owed, which is how an attempt that died with its
// incarnation is re-driven — provisions the Artifacts repo through the effects the host injects and
// appends the terminal fact: `repos/created` (also cross-posted to `/`) or `repos/create-failed`.
// The effect is idempotent end to end (provisioning tolerates an existing repo; the terminal facts
// carry idempotency keys), so re-driving is always safe. Imports only the pure kernel: a unit test
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
import { RepoContract, type RepoIdentity, type RepoView } from "./contract.ts";

/** What the saga's effect needs from the world — the host closes these over its itx. */
export interface RepoEffects {
  /** The Artifacts repo, `main` unborn; a repo that exists is fine. */
  createRepo(name: string): Promise<unknown>;
  /** The certificate onto `/`, where the project processor keeps the catalog. */
  crossPost(event: StreamEventInput): Promise<unknown>;
}

/** The certificate, spelled once — the same event (and key) on the repo's path and on `/`. */
export function repoCreatedEvent(identity: RepoIdentity): StreamEventInput {
  return {
    type: "events.iterate.com/repos/created",
    payload: identity,
    idempotencyKey: `repos/created:${identity.path}`,
  };
}

export class RepoProcessor extends StreamProcessor<
  ProcessorState<typeof RepoContract>,
  ConsumedEvent<typeof RepoContract>
> {
  readonly contract = RepoContract;
  readonly #effects: RepoEffects;
  /** The identity the open request carries — the at-head re-drive needs it without the event. */
  #requested: RepoIdentity | null = null;

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
        return { ...state, creation: "requested", attempts: state.attempts + 1, error: null };
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
    event,
    state,
    append,
    blockProcessorWhile,
    delivery,
  }: ProcessEventArgs<RepoView, ConsumedEvent<typeof RepoContract>>): undefined {
    if (event?.type === "events.iterate.com/repos/create-requested")
      this.#requested = event.payload;
    // Drive the saga AT HEAD while a request is owed — the engine's "now": a fresh request is the
    // head when it lands; an attempt that died with its incarnation is owed at the next catch-up's
    // head; a replayed history whose request already has its terminal in the same page never drives
    // (the terminal is what is at head). Never on the request event itself, for that last reason.
    const owed = state.creation === "requested" && this.#requested;
    if (!owed || !delivery.caughtUp) return undefined;
    const identity = owed;
    const attempt = state.attempts;
    blockProcessorWhile(async () => {
      try {
        await this.#effects.createRepo(identity.name);
      } catch (error) {
        await append({
          type: "events.iterate.com/repos/create-failed",
          payload: { ...identity, error: error instanceof Error ? error.message : String(error) },
          idempotencyKey: `repos/create-failed:${identity.path}:${attempt}`,
        });
        return;
      }
      // Two fresh copies: the engine stamps its provenance onto what it appends, and the copy that
      // crosses to `/` is attributed there, by that context's own append.
      await append(repoCreatedEvent(identity));
      await this.#effects.crossPost(repoCreatedEvent(identity));
    });
    return undefined;
  }
}
