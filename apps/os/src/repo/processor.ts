// src/repo/processor.ts — THE REPO PROCESSOR: the reduce of the creation and deletion facts, and THE
// SAGAS — the two effects, provisioning the Artifacts repo and tearing it down again, each run from
// state at head. Subscribed to its own path (the row `itx.repos.create(path)` enables), it sees every
// commit and runs again after every eviction: an attempt lost with an incarnation is simply run again
// by the next, the certificates are keyed, provisioning tolerates a repo that already exists and the
// teardown one already gone. Pure: the host's `withItx` is its one constructor argument
// (`itx.cfArtifacts` IS the Artifacts binding, already scoped to the project), so a unit test
// constructs it with `new` and reduces rows (processor.test.ts, in node); the sagas are proven on the
// worker (e2e/repos.e2e.test.ts, a fake `itx.cfArtifacts` lent by rule).
import {
  type ConsumedEvent,
  type EmittedEventInput,
  type ProcessEventArgs,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
import type { WithItx } from "iterate/next/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { RepoContract, type RepoState } from "./contract.ts";

export class RepoProcessor extends StreamProcessor<RepoState, ConsumedEvent<typeof RepoContract>> {
  readonly contract = RepoContract;

  private readonly withItx: WithItx<ItxEntrypointScope>;

  constructor(withItx: WithItx<ItxEntrypointScope>) {
    super();
    this.withItx = withItx;
  }

  /** This incarnation's provisioning attempt, so one at-head pass does not start a second; the
   *  durable ground is `state.creation`. */
  #provisioning = false;
  /** The same for this incarnation's teardown attempt; the durable ground is `state.deletion`. */
  #deleting = false;

  override reduce({
    state,
    event,
  }: ReduceArgs<RepoState, ConsumedEvent<typeof RepoContract>>): RepoState | undefined {
    switch (event.type) {
      case "events.iterate.com/repo/create-requested":
        // Born once: a request after the certificate is a harmless fact; after a failure, a new
        // attempt. A deleted repo is not re-creatable: `creation` stays as it was, so the request
        // is a harmless fact there too (the collection refuses it before it lands).
        return state.creation?.status === "created"
          ? undefined
          : {
              ...state,
              creation: { status: "requested", offset: event.offset },
            };
      case "events.iterate.com/repo/created":
        return { ...state, creation: { status: "created", offset: event.offset } };
      case "events.iterate.com/repo/create-failed":
        // A failure after the certificate is a harmless fact too (an attempt whose own-path append
        // lost its answer): the entity stays created, and the next create() answers at once.
        return state.creation?.status === "created"
          ? undefined
          : { ...state, creation: { status: "failed", offset: event.offset } };
      case "events.iterate.com/repo/delete-requested":
        // Dies once: a request after the death certificate is a harmless fact. Deletion never
        // touches `creation` — the log still says the repo was born.
        return state.deletion?.status === "deleted"
          ? undefined
          : { ...state, deletion: { status: "requested", offset: event.offset } };
      case "events.iterate.com/repo/deleted":
        return { ...state, deletion: { status: "deleted", offset: event.offset } };
      default:
        return undefined;
    }
  }

  override processEvent({
    state,
    delivery,
    append,
    runInBackground,
  }: ProcessEventArgs<
    RepoState,
    ConsumedEvent<typeof RepoContract>,
    EmittedEventInput<typeof RepoContract>
  >): undefined {
    // THE SAGAS — state-derived, at head, in the background: at most once per incarnation, and any
    // later delivery over the same state runs them again, so an attempt lost to an eviction costs
    // nothing (the engine revives the host while an attempt is in flight).
    if (!delivery.caughtUp) return;
    if (state.creation?.status === "requested" && !this.#provisioning) {
      this.#provisioning = true;
      runInBackground(async () => {
        try {
          const { path } = await this.withItx((itx) => itx.whoami());
          await this.withItx((itx) => itx.cfArtifacts.create(path)); // one that exists is fine
          const certificate: EmittedEventInput<typeof RepoContract> = {
            type: "events.iterate.com/repo/created",
            payload: { path },
            idempotencyKey: `repo/created:${path}`,
          };
          await this.withItx((itx) => itx.cd("/").append(certificate)); // the project catalog first
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
      return;
    }
    // THE TEARDOWN, the creation's mirror, only of a repo that was born: the Artifacts repo goes,
    // then the death certificate — `/` first (the catalog drops the entry), this path last. A throw
    // appends nothing: the next at-head pass is the retry, and there is no delete-failed fact.
    if (
      state.creation?.status === "created" &&
      state.deletion?.status === "requested" &&
      !this.#deleting
    ) {
      this.#deleting = true;
      runInBackground(async () => {
        try {
          const { path } = await this.withItx((itx) => itx.whoami());
          // false when already gone (an attempt lost after its delete)
          await this.withItx((itx) => itx.cfArtifacts.delete(path));
          const certificate: EmittedEventInput<typeof RepoContract> = {
            type: "events.iterate.com/repo/deleted",
            payload: { path },
            idempotencyKey: `repo/deleted:${path}`,
          };
          await this.withItx((itx) => itx.cd("/").append(certificate)); // the project catalog first
          await append(certificate); // this path last: closes the obligation
        } finally {
          this.#deleting = false;
        }
      });
    }
  }
}
