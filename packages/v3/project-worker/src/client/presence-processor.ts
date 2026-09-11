// src/client/presence-processor.ts — the presence processor's HOST + spec, the ONE source both the
// hosted demo (demo.tsx) and the e2e lane (e2e/support/sources.ts) load into a dynamic worker.
// build-sdk.mjs bundles THIS into the loaded `cap.js` (SDK/kernel/zod left external as
// "./processor.js"), exactly like the account facet — so the reduce / processEvent / projectLiveState
// that RUN are the ones that TYPECHECK here, no hand-written string to drift.
//
// Its live state COMBINES reduced state (ticks, reduced from durable 'tick' events) with a RUNTIME
// field (lastPokeMs — a plain field on the pure class, NOT the reduce checkpoint, gone on eviction):
// a 'poke' ephemeral bumps the field in processEvent, and the engine re-projects after the batch and
// emits the delta itself (the reduce never touches it). Proves reduced ⊕ runtime through ONE
// projection + ONE revision chain (specs/live-state-demo.spec, live-state-chains-client-side.e2e).
import {
  defineProcessorContract,
  type ProcessEventArgs,
  type ReduceArgs,
  StreamProcessor,
  StreamProcessorDurableObject,
  type StreamEvent,
  z,
} from "../sdk/index.ts";

const PresenceView = z.object({ ticks: z.number().default(0) });
type PresenceView = z.infer<typeof PresenceView>;

/** The events the processor consumes — 'tick' is reduced into `ticks`, 'poke' drives the runtime
 *  field only (declared here so `reduce`/`processEvent` narrow `event.type` with no cast). */
type PresenceEvent = (StreamEvent & { type: "tick" }) | (StreamEvent & { type: "poke" });

class PresenceProcessor extends StreamProcessor<PresenceView, PresenceEvent> {
  readonly contract = defineProcessorContract({
    slug: "presence",
    version: "1.0.0",
    description: "Reduced tick count beside a runtime lastPokeMs the reduce never sees.",
    stateSchema: PresenceView,
    consumes: ["tick", "poke"],
    emits: [],
  });

  /** RUNTIME state: a field, not reduced — reset to 0 on eviction, never re-reduced. */
  #lastPokeMs = 0;

  override reduce({
    event,
    state,
  }: ReduceArgs<PresenceView, PresenceEvent>): PresenceView | undefined {
    if (event.type === "tick") return { ...state, ticks: state.ticks + 1 };
    // 'poke' is deliberately NOT reduced — it drives a runtime field, not durable truth.
    return undefined;
  }

  override processEvent({ event }: ProcessEventArgs<PresenceView, PresenceEvent>): undefined {
    // No publish call: the engine re-projects after every batch and emits the delta itself.
    if (event?.type === "poke") this.#lastPokeMs = Date.now();
  }

  override projectLiveState(state: PresenceView): unknown {
    return { ticks: state.ticks, lastPokeMs: this.#lastPokeMs };
  }
}

export class PresenceDurableObject extends StreamProcessorDurableObject<PresenceView> {
  processor = new PresenceProcessor();
}
