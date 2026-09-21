// src/workspace/processor.ts — THE WORKSPACE PROCESSOR: the reduce of the creation facts, and THE
// SAGA — the one effect, landing the birth certificate, run from state at head. A workspace has
// NOTHING to provision (the overlay is the host's own storage, born with it), so the saga is the
// cross-post alone: the keyed certificate on `/` for the project catalog, then on this path.
// Subscribed to its own path (the row `itx.workspaces.create(path)` enables), it runs again after
// every eviction: an attempt lost with an incarnation is simply run again by the next, and the
// certificate is keyed. Pure: the host's `withItx` is its one constructor argument (`itx.whoami()`
// names the path), so a unit test constructs it with `new` and reduces rows (processor.test.ts, in
// node); the saga is proven on the worker (e2e/workspaces.e2e.test.ts).
import {
  type ConsumedEvent,
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

  override reduce({
    state,
    event,
  }: ReduceArgs<WorkspaceState, ConsumedEvent<typeof WorkspaceContract>>):
    | WorkspaceState
    | undefined {
    switch (event.type) {
      case "events.iterate.com/workspace/create-requested":
        // Born once: a request after the certificate is a harmless fact; after a failure, a new attempt.
        return state.creation?.status === "created"
          ? undefined
          : { creation: { status: "requested", offset: event.offset } };
      case "events.iterate.com/workspace/created":
        return { creation: { status: "created", offset: event.offset } };
      case "events.iterate.com/workspace/create-failed":
        return { creation: { status: "failed", offset: event.offset } };
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
  }: ProcessEventArgs<WorkspaceState, ConsumedEvent<typeof WorkspaceContract>>): undefined {
    // THE SAGA — state-derived, at head, in the background: at most once per incarnation, and any
    // later delivery over the same state runs it again, so an attempt lost to an eviction costs
    // nothing (the engine revives the host while an attempt is in flight).
    if (!delivery.caughtUp || state.creation?.status !== "requested" || this.#provisioning) return;
    this.#provisioning = true;
    runInBackground(async () => {
      try {
        const { path } = await this.withItx((itx) => itx.whoami());
        const certificate = {
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
  }
}
