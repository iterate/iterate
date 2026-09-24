// src/client/presence/processor.ts — the presence processor's PURE class, unit-tested in
// processor.test.ts. Imports only the pure kernel (no cloudflare:workers), so a node unit test can
// construct it with `new`; durable-object.ts is the loadable host build-sdk.mjs bundles.
import {
  type ConsumedEvent,
  type ProcessEventArgs,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/stream/processor";
import { PresenceContract, type PresenceState } from "./contract.ts";

export class PresenceProcessor extends StreamProcessor<
  PresenceState,
  ConsumedEvent<typeof PresenceContract>
> {
  readonly contract = PresenceContract;

  /** RUNTIME state: a field, not reduced — reset to 0 on eviction, never re-reduced. */
  #lastPokeMs = 0;

  override reduce({
    event,
    state,
  }: ReduceArgs<PresenceState, ConsumedEvent<typeof PresenceContract>>): PresenceState | undefined {
    if (event.type === "tick") return { ...state, ticks: state.ticks + 1 };
    // 'poke' is deliberately NOT reduced — it drives a runtime field, not durable truth.
    return undefined;
  }

  override processEvent({
    event,
  }: ProcessEventArgs<PresenceState, ConsumedEvent<typeof PresenceContract>>): undefined {
    // No publish call: the engine re-projects after every batch and emits the delta itself.
    if (event?.type === "poke") this.#lastPokeMs = Date.now();
  }

  override projectLiveState(state: PresenceState): unknown {
    return { ticks: state.ticks, lastPokeMs: this.#lastPokeMs };
  }
}
