// src/workspace/processor.ts — THE WORKSPACE PROCESSOR: the reduce of the creation and deletion
// facts, and THE SAGAS — the two effects, landing the birth certificate and the death certificate,
// each run from state at head. A workspace has NOTHING to provision (the overlay is the host's own
// storage, born with it and deleted with it), so each saga is the cross-post alone: the keyed
// certificate on `/` for the project catalog, then on this path. Subscribed to its own path (the row
// `itx.workspaces.create(path)` enables), it runs again after every eviction: an attempt lost with an
// incarnation is simply run again by the next, and the certificates are keyed. Pure: the host's
// `withItx` is its one constructor argument (`itx.whoami()` names the path), so a unit test
// constructs it with `new` and reduces rows (processor.test.ts, in node); the sagas are proven on
// the worker (e2e/workspaces.e2e.test.ts).
import {
  type ConsumedEvent,
  type EmittedEventInput,
  type ProcessEventArgs,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/next/stream/processor";
import type { WithItx } from "iterate/next/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { WorkspaceContract, type WorkspaceState } from "./contract.ts";

export class WorkspaceProcessor extends StreamProcessor<
  WorkspaceState,
  ConsumedEvent<typeof WorkspaceContract>
> {
  readonly contract = WorkspaceContract;

  constructor(private readonly withItx: WithItx<ItxEntrypointScope>) {
    super();
  }

  /** This incarnation's creation attempt, so one at-head pass does not start a second; the durable
   *  ground is `state.creation`. */
  #provisioning = false;
  /** The same for this incarnation's deletion attempt; the durable ground is `state.deletion`. */
  #deleting = false;

  override reduce({
    state,
    event,
  }: ReduceArgs<WorkspaceState, ConsumedEvent<typeof WorkspaceContract>>):
    | WorkspaceState
    | undefined {
    switch (event.type) {
      case "events.iterate.com/workspace/create-requested":
        // Born once: a request after the certificate is a harmless fact; after a failure, a new
        // attempt. A deleted workspace is not re-creatable: `creation` stays as it was, so the
        // request is a harmless fact there too (the collection refuses it before it lands).
        return state.creation?.status === "created"
          ? undefined
          : {
              ...state,
              creation: {
                status: "requested",
                offset: event.offset,
                creator: event.payload.creator,
              },
            };
      case "events.iterate.com/workspace/created":
        return { ...state, creation: { status: "created", offset: event.offset } };
      case "events.iterate.com/workspace/create-failed":
        // A failure after the certificate is a harmless fact too (an attempt whose own-path append
        // lost its answer): the entity stays created, and the next create() answers at once.
        return state.creation?.status === "created"
          ? undefined
          : { ...state, creation: { status: "failed", offset: event.offset } };
      case "events.iterate.com/workspace/delete-requested":
        // Dies once: a request after the death certificate is a harmless fact. Deletion never
        // touches `creation` — the log still says the workspace was born.
        return state.deletion?.status === "deleted"
          ? undefined
          : { ...state, deletion: { status: "requested", offset: event.offset } };
      case "events.iterate.com/workspace/deleted":
        return { ...state, deletion: { status: "deleted", offset: event.offset } };
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
  }: ProcessEventArgs<
    WorkspaceState,
    ConsumedEvent<typeof WorkspaceContract>,
    EmittedEventInput<typeof WorkspaceContract>
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
          // THE PARENT LINK, part of the birth: everything this context does not claim, its creator
          // answers (itx-expression-rewriting.ts rule 3) — written before the certificate, so a born
          // context is never re-pointed and an owner's later row (a jail) is the last word.
          const creator = state.creation?.creator;
          if (creator && creator !== path)
            await this.withItx((itx) =>
              itx.builtins.append({
                type: "events.iterate.com/itx/rewrite-rule-configured",
                payload: {
                  match: "itx",
                  target: ["itx", "builtins", ["cd", creator]],
                  description: "everything this context does not claim, its creator answers",
                },
                idempotencyKey: `itx@${creator}`,
              }),
            );
          const certificate: EmittedEventInput<typeof WorkspaceContract> = {
            type: "events.iterate.com/workspace/created",
            payload: { path },
            idempotencyKey: `workspace/created:${path}`,
          };
          await appendTo("/", certificate); // the project catalog first
          await append(certificate); // this path last: closes the obligation
        } catch (error) {
          await append({
            type: "events.iterate.com/workspace/create-failed",
            payload: { error: error instanceof Error ? error.message : String(error) },
          });
        } finally {
          this.#provisioning = false;
        }
      });
      return;
    }
    // THE DELETION, the creation's mirror, only of a workspace that was born: nothing to tear down
    // (the overlay goes with the facet when the collection drops the row), so the death certificate
    // alone — `/` first (the catalog drops the entry), this path last. A throw appends nothing: the
    // next at-head pass is the retry, and there is no delete-failed fact.
    if (
      state.creation?.status === "created" &&
      state.deletion?.status === "requested" &&
      !this.#deleting
    ) {
      this.#deleting = true;
      runInBackground(async () => {
        try {
          const { path } = await this.withItx((itx) => itx.whoami());
          const certificate: EmittedEventInput<typeof WorkspaceContract> = {
            type: "events.iterate.com/workspace/deleted",
            payload: { path },
            idempotencyKey: `workspace/deleted:${path}`,
          };
          await appendTo("/", certificate); // the project catalog first
          await append(certificate); // this path last: closes the obligation
        } finally {
          this.#deleting = false;
        }
      });
    }
  }
}
