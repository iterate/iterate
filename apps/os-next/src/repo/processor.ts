// src/repo/processor.ts — THE REPO PROCESSOR: the reduce of the creation facts, and THE SAGA — the
// one effect, provisioning the Artifacts repo, run from state at head. Subscribed to its own path
// (the row `itx.repos.create(path)` enables), it sees every commit and runs again after every
// eviction: an attempt lost with an incarnation is simply run again by the next, the certificate is
// keyed, and provisioning tolerates a repo that already exists. Pure: the host's `withItx` is its one
// constructor argument (`itx.cfArtifacts` IS the Artifacts binding, already scoped to the project),
// so a unit test constructs it with `new` and reduces rows (processor.test.ts, in node); the saga is
// proven on the worker (e2e/repos.e2e.test.ts, a fake `itx.cfArtifacts` lent by rule).
import {
  type ConsumedEvent,
  type ProcessEventArgs,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
import type { WithItx } from "iterate/next/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { RepoContract, type RepoState } from "./contract.ts";

export class RepoProcessor extends StreamProcessor<RepoState, ConsumedEvent<typeof RepoContract>> {
  readonly contract = RepoContract;

  constructor(private readonly withItx: WithItx<ItxEntrypointScope>) {
    super();
  }

  /** This incarnation's provisioning attempt, so one at-head pass does not start a second; the
   *  durable ground is `state.creation`. */
  #provisioning = false;

  override reduce({
    state,
    event,
  }: ReduceArgs<RepoState, ConsumedEvent<typeof RepoContract>>): RepoState | undefined {
    switch (event.type) {
      case "events.iterate.com/repo/create-requested":
        // Born once: a request after the certificate is a harmless fact; after a failure, a new attempt.
        return state.creation?.status === "created"
          ? undefined
          : { creation: { status: "requested", offset: event.offset } };
      case "events.iterate.com/repo/created":
        return { creation: { status: "created", offset: event.offset } };
      case "events.iterate.com/repo/create-failed":
        // A failure after the certificate is a harmless fact too (an attempt whose own-path append
        // lost its answer): the entity stays created, and the next create() answers at once.
        return state.creation?.status === "created"
          ? undefined
          : { creation: { status: "failed", offset: event.offset } };
      default:
        return undefined;
    }
  }

  override processEvent({
    state,
    delivery,
    append,
    appendTo,
    runInBackground,
  }: ProcessEventArgs<RepoState, ConsumedEvent<typeof RepoContract>>): undefined {
    // THE SAGA — state-derived, at head, in the background: at most once per incarnation, and any
    // later delivery over the same state runs it again, so an attempt lost to an eviction costs
    // nothing (the engine revives the host while an attempt is in flight).
    if (!delivery.caughtUp || state.creation?.status !== "requested" || this.#provisioning) return;
    this.#provisioning = true;
    runInBackground(async () => {
      try {
        const { path } = await this.withItx((itx) => itx.whoami());
        await this.withItx((itx) => itx.cfArtifacts.create(path)); // one that exists is fine
        const certificate = {
          type: "events.iterate.com/repo/created",
          payload: { path },
          idempotencyKey: `repo/created:${path}`,
        };
        await appendTo("/", certificate); // the project catalog first
        await append(certificate); // this path last: closes the obligation
      } catch (error) {
        await append({
          type: "events.iterate.com/repo/create-failed",
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        this.#provisioning = false;
      }
    });
  }
}
